import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_MFA_GRACE_DAYS,
  type MfaSubject,
  mfaStanding,
  nextMfaPolicy,
  readMfaPolicy,
} from '../../../src/lib/auth/two-factor/mfa-policy';

const NOW = new Date('2026-06-10T00:00:00.000Z');

const subject = (overrides: Partial<MfaSubject> = {}): MfaSubject => ({
  role: 'admin',
  hasPassword: true,
  twoFactorEnabled: false,
  passkeyCount: 0,
  createdAt: '2025-01-01T00:00:00.000Z',
  ...overrides,
});

describe('readMfaPolicy', () => {
  it('reads the older "require for admins" switch as the admins mode, enforced at once', () => {
    expect(readMfaPolicy({ requireForAdmins: true })).toEqual({
      mode: 'admins',
      graceDays: DEFAULT_MFA_GRACE_DAYS,
      since: null,
      requireForAdmins: true,
    });
    expect(readMfaPolicy({ requireForAdmins: false }).mode).toBe('off');
    expect(readMfaPolicy(null).mode).toBe('off');
  });

  it('clamps the grace period to 0-90 days', () => {
    expect(readMfaPolicy({ mode: 'all', graceDays: 500 }).graceDays).toBe(90);
    expect(readMfaPolicy({ mode: 'all', graceDays: -3 }).graceDays).toBe(0);
  });
});

describe('nextMfaPolicy', () => {
  const previous = readMfaPolicy({ mode: 'admins', graceDays: 7, since: '2026-01-01T00:00:00Z' });

  it('restarts the grace clock when the mode changes', () => {
    expect(nextMfaPolicy(previous, { mode: 'all', graceDays: 7 }, NOW).since).toBe(
      NOW.toISOString(),
    );
  });

  it('keeps it running when only the days change, and clears it when turned off', () => {
    expect(nextMfaPolicy(previous, { mode: 'admins', graceDays: 30 }, NOW).since).toBe(
      '2026-01-01T00:00:00Z',
    );
    expect(nextMfaPolicy(previous, { mode: 'off', graceDays: 30 }, NOW).since).toBeNull();
  });
});

describe('mfaStanding', () => {
  const all = readMfaPolicy({ mode: 'all', graceDays: 7, since: '2026-06-05T00:00:00.000Z' });

  it('exempts accounts without a local password, and roles the mode does not cover', () => {
    expect(mfaStanding(all, subject({ hasPassword: false }), NOW).status).toBe('exempt');
    const admins = readMfaPolicy({ mode: 'admins', graceDays: 7, since: null });
    expect(mfaStanding(admins, subject({ role: 'operator' }), NOW).status).toBe('exempt');
  });

  it('is satisfied by TOTP or a passkey', () => {
    expect(mfaStanding(all, subject({ twoFactorEnabled: true }), NOW).status).toBe('satisfied');
    expect(mfaStanding(all, subject({ passkeyCount: 2 }), NOW).status).toBe('satisfied');
  });

  it('gives a grace period from the policy change, or from a newer account', () => {
    expect(mfaStanding(all, subject(), NOW)).toEqual({
      status: 'grace',
      deadline: '2026-06-12T00:00:00.000Z',
    });
    expect(mfaStanding(all, subject({ createdAt: '2026-06-09T00:00:00.000Z' }), NOW)).toEqual({
      status: 'grace',
      deadline: '2026-06-16T00:00:00.000Z',
    });
    const later = new Date('2026-06-13T00:00:00.000Z');
    expect(mfaStanding(all, subject(), later).status).toBe('required');
  });

  it('forces setup at once for a policy stored before grace periods', () => {
    expect(mfaStanding(readMfaPolicy({ requireForAdmins: true }), subject(), NOW).status).toBe(
      'required',
    );
  });
});
