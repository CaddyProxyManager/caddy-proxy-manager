import { describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';

vi.mock('../../../src/lib/settings', () => ({
  getTwoFactorPolicySettings: async () => ({ requireForAdmins: true }),
}));

const { mustEnrollTwoFactor } = await import('../../../src/lib/auth/two-factor/policy');

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
