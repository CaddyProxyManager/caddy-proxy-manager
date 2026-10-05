/**
 * User passwords use argon2id, which is memory-hard and reads past bcrypt's 72 bytes. Access list
 * passwords stay bcrypt, as Caddy's `http_basic` verifies them. Verify detects the algorithm.
 */

const BCRYPT_MAX_BYTES = 72;

/** $2a$ (legacy), $2b$ (current), $2y$ (PHP). */
const BCRYPT_PREFIX = /^\$2[aby]\$/;

export const DEFAULT_BCRYPT_COST = 12;

/**
 * Old hashes came from bcryptjs, which truncated at 72 bytes; Bun.password does not. Bcrypt only:
 * clamping argon2id would throw away real material.
 */
function clampToBcryptLimit(password: string): string | Uint8Array {
  const bytes = Buffer.from(password, "utf8");
  return bytes.byteLength <= BCRYPT_MAX_BYTES ? password : bytes.subarray(0, BCRYPT_MAX_BYTES);
}

export function isLegacyPasswordHash(hash: string | null | undefined): boolean {
  return typeof hash === "string" && BCRYPT_PREFIX.test(hash);
}

/** Bun's defaults (m=64MiB, t=2, p=1), above OWASP's m=19MiB floor. */
export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

/** Only for hashes verified outside this app (Caddy basicauth). */
export async function hashBcrypt(
  password: string,
  cost: number = DEFAULT_BCRYPT_COST,
): Promise<string> {
  return Bun.password.hash(clampToBcryptLimit(password), { algorithm: "bcrypt", cost });
}

/** False, never a throw, for an unusable hash. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  try {
    const candidate = isLegacyPasswordHash(hash) ? clampToBcryptLimit(password) : password;
    return await Bun.password.verify(candidate, hash);
  } catch {
    // It throws on a malformed hash; one bad row must read as a wrong password, not a 500.
    return false;
  }
}
