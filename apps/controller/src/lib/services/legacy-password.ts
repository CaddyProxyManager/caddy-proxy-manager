import { getUserById } from "../models/user";
import { isLegacyPasswordHash } from "../auth/password";
import { isLegacyPasswordChangeRequired } from "../settings";

/**
 * Whether this user must change their password: only when the policy is on *and* the hash is still
 * bcrypt. Changing it rehashes with argon2id, so the gate self-resolves. Federated users have no
 * password hash and are never caught by it.
 */
export async function requiresLegacyPasswordChange(userId: number): Promise<boolean> {
  if (!(await isLegacyPasswordChangeRequired())) return false;
  const user = await getUserById(userId);
  return isLegacyPasswordHash(user?.passwordHash);
}
