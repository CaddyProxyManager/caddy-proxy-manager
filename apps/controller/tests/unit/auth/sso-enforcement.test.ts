import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_SSO_ENFORCEMENT,
  MAX_BREAK_GLASS_ACCOUNTS,
  isBreakGlassAccount,
  readSsoEnforcement,
} from '@/src/lib/auth/sso-enforcement';

describe('readSsoEnforcement', () => {
  it('is off, with LDAP allowed, when nothing is stored', () => {
    expect(readSsoEnforcement(null)).toEqual(DEFAULT_SSO_ENFORCEMENT);
    expect(readSsoEnforcement([])).toEqual(DEFAULT_SSO_ENFORCEMENT);
    expect(DEFAULT_SSO_ENFORCEMENT).toEqual({
      enforced: false,
      breakGlassUserIds: [],
      allowLdap: true,
    });
  });

  it('turns on only for a literal true, and keeps LDAP unless told false', () => {
    expect(readSsoEnforcement({ enforced: 'true' }).enforced).toBe(false);
    expect(readSsoEnforcement({ enforced: true }).enforced).toBe(true);
    expect(readSsoEnforcement({ allowLdap: 0 }).allowLdap).toBe(true);
    expect(readSsoEnforcement({ allowLdap: false }).allowLdap).toBe(false);
  });

  it('keeps break-glass ids that are positive integers, once each, up to the limit', () => {
    expect(
      readSsoEnforcement({ breakGlassUserIds: [3, '4', 3, 0, -1, 2.5, 'x'] }).breakGlassUserIds,
    ).toEqual([3, 4]);
    const many = Array.from({ length: MAX_BREAK_GLASS_ACCOUNTS + 5 }, (_, i) => i + 1);
    expect(readSsoEnforcement({ breakGlassUserIds: many }).breakGlassUserIds).toHaveLength(
      MAX_BREAK_GLASS_ACCOUNTS,
    );
  });

  it('names a break-glass account by id', () => {
    const policy = readSsoEnforcement({ enforced: true, breakGlassUserIds: [7] });
    expect(isBreakGlassAccount(policy, 7)).toBe(true);
    expect(isBreakGlassAccount(policy, 8)).toBe(false);
  });
});
