/**
 * The gate sending bcrypt-hashed users to the reset screen. Its failure modes are asymmetric -
 * gating a federated user with no password locks them out - so the negative cases matter more.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import bcrypt from 'bcryptjs';

vi.mock('@/src/lib/models/user', () => ({ getUserById: vi.fn() }));
vi.mock('@/src/lib/settings', () => ({ isLegacyPasswordChangeRequired: vi.fn() }));

import { requiresLegacyPasswordChange } from '@/src/lib/services/legacy-password';
import { getUserById } from '@/src/lib/models/user';
import { isLegacyPasswordChangeRequired } from '@/src/lib/settings';
import { hashPassword } from '@/src/lib/auth/password';

const asUser = (passwordHash: string | null) => ({ id: 1, passwordHash }) as never;

describe('requiresLegacyPasswordChange', () => {
  beforeEach(() => vi.clearAllMocks());

  it('gates a user whose hash is still bcrypt', async () => {
    vi.mocked(isLegacyPasswordChangeRequired).mockResolvedValue(true);
    vi.mocked(getUserById).mockResolvedValue(asUser(bcrypt.hashSync('pw', 10)));
    expect(await requiresLegacyPasswordChange(1)).toBe(true);
  });

  it('does not gate a user already on argon2id', async () => {
    vi.mocked(isLegacyPasswordChangeRequired).mockResolvedValue(true);
    vi.mocked(getUserById).mockResolvedValue(asUser(await hashPassword('pw')));
    expect(await requiresLegacyPasswordChange(1)).toBe(false);
  });

  it('never gates a federated user with no password', async () => {
    // An OAuth/OIDC account has nothing to change, so gating it would be an
    // unsatisfiable lockout rather than a prompt.
    vi.mocked(isLegacyPasswordChangeRequired).mockResolvedValue(true);
    vi.mocked(getUserById).mockResolvedValue(asUser(null));
    expect(await requiresLegacyPasswordChange(1)).toBe(false);
  });

  it('does not gate an unknown user', async () => {
    vi.mocked(isLegacyPasswordChangeRequired).mockResolvedValue(true);
    vi.mocked(getUserById).mockResolvedValue(null);
    expect(await requiresLegacyPasswordChange(1)).toBe(false);
  });

  it('never gates while the policy is off, and does not even read the user', async () => {
    vi.mocked(isLegacyPasswordChangeRequired).mockResolvedValue(false);
    expect(await requiresLegacyPasswordChange(1)).toBe(false);
    expect(getUserById).not.toHaveBeenCalled();
  });
});
