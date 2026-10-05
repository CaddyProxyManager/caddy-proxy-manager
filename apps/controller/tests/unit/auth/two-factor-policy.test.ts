import { describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';

const policy = vi.hoisted(() => ({
  stored: { requireForAdmins: true } as Record<string, unknown>,
  facts: { passkeyCount: 0, createdAt: '2026-01-01T00:00:00.000Z' as string | null },
}));

vi.mock('../../../src/lib/settings', () => ({
  getTwoFactorPolicySettings: async () => policy.stored,
}));

vi.mock('../../../src/lib/auth/two-factor/facts', () => ({
  accountMfaFacts: async () => policy.facts,
}));

const { mfaStandingFor, mustEnrollTwoFactor } = await import(
  '../../../src/lib/auth/two-factor/policy'
);

const admin = {
  user: {
    id: '1',
    email: 'a@x',
    name: 'A',
    role: 'admin',
    hasPassword: true,
    twoFactorEnabled: false,
  },
};

describe('mustEnrollTwoFactor', () => {
  it('catches an admin without 2FA when the policy requires it', async () => {
    expect(await mustEnrollTwoFactor(admin)).toBe(true);
  });

  it('still catches them while they view as a lesser role', async () => {
    const viewing = {
      ...admin,
      user: { ...admin.user, role: 'viewer' },
      realRole: 'admin',
      viewAs: {
        role: 'viewer' as const,
        groupIds: [],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    expect(await mustEnrollTwoFactor(viewing)).toBe(true);
  });

  it('leaves non-admins, SSO accounts and enrolled admins alone', async () => {
    expect(await mustEnrollTwoFactor({ user: { ...admin.user, role: 'operator' } })).toBe(false);
    expect(await mustEnrollTwoFactor({ user: { ...admin.user, hasPassword: false } })).toBe(false);
    expect(await mustEnrollTwoFactor({ user: { ...admin.user, twoFactorEnabled: true } })).toBe(
      false,
    );
  });
});

describe('the policy modes', () => {
  it('counts a passkey as a second factor', async () => {
    policy.facts = { passkeyCount: 1, createdAt: null };
    expect(await mustEnrollTwoFactor(admin)).toBe(false);
    policy.facts = { passkeyCount: 0, createdAt: '2026-01-01T00:00:00.000Z' };
  });

  it('covers every password account under "all", within its grace period first', async () => {
    const recently = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    policy.stored = { mode: 'all', graceDays: 7, since: recently };
    const user = { user: { ...admin.user, role: 'user' } };
    const standing = await mfaStandingFor(user);
    expect(standing.status).toBe('grace');
    expect(await mustEnrollTwoFactor(user)).toBe(false);

    policy.stored = { mode: 'all', graceDays: 0, since: recently };
    expect(await mustEnrollTwoFactor(user)).toBe(true);
    policy.stored = { requireForAdmins: true };
  });

  it('leaves everyone alone when off', async () => {
    policy.stored = { mode: 'off', graceDays: 7, since: null };
    expect(await mustEnrollTwoFactor(admin)).toBe(false);
    policy.stored = { requireForAdmins: true };
  });
});
