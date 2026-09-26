import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "./config";
import { derivePurposeKey } from "./derived-key";

const PREFIX = "enc:v1:";
const IV_LENGTH = 12;

function deriveKey(sessionSecret: string = config.sessionSecret): Buffer {
  return derivePurposeKey("secret:v1", sessionSecret);
}

function deriveKeyLegacy(sessionSecret: string = config.sessionSecret): Buffer {
  return createHash("sha256").update(sessionSecret).digest();
}

/**
 * Decrypt with a session secret that is not this deployment's own.
 *
 * The migration flow is the only caller: a pre-3.0 database carries its secrets encrypted under
 * the `SESSION_SECRET` that installation ran with, which is rarely the one the new deployment was
 * given. Rather than making the operator adopt the old secret forever, the importer asks for it
 * once and re-encrypts everything under the current key on the way in.
 *
 * Both derivations are tried, for the same reason `decryptSecret` tries both: a database old
 * enough to predate the HKDF change holds values under the SHA-256 key, and one that was upgraded
 * part-way holds a mixture. No grace-period check here - the cutoff exists to push a running
 * deployment off the legacy key, and refusing to read a legacy value during the one operation that
 * would re-encrypt it has it exactly backwards.
 *
 * Returns null rather than throwing: every caller is asking "is this the right secret", and a
 * wrong answer is an expected outcome there, not an error.
 */
export function decryptSecretWith(value: string, sessionSecret: string): string | null {
  if (!isEncryptedSecret(value)) return value;
  for (const key of [deriveKey(sessionSecret), deriveKeyLegacy(sessionSecret)]) {
    try {
      return _decryptWithKey(value, key);
    } catch {
      // Try the other derivation before giving up.
    }
  }
  return null;
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

/**
 * Columns that are a secret in full, by table and SQL name. Older releases, and backups taken by
 * them, stored some in plain text, so anything copying rows in seals these on the way.
 */
export const SECRET_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  certificates: ["privateKeyPem"],
  ca_certificates: ["privateKeyPem"],
};

/** `value` encrypted if `table.column` is a secret column; anything else as it came. */
export function sealSecretColumn(table: string, column: string, value: string): string {
  return SECRET_COLUMNS[table]?.includes(column) ? encryptSecret(value) : value;
}

export function encryptSecret(value: string): string {
  if (!value) return "";
  if (isEncryptedSecret(value)) return value;

  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/**
 * Legacy fallback is time-limited: past the grace period the legacy key is not tried, forcing
 * re-encryption. LEGACY_KEY_CUTOFF_DATE extends or disables it (ISO 8601 or "never").
 */
const LEGACY_KEY_CUTOFF_ENV = process.env.LEGACY_KEY_CUTOFF_DATE;
const LEGACY_KEY_CUTOFF =
  LEGACY_KEY_CUTOFF_ENV === "never"
    ? null
    : new Date(LEGACY_KEY_CUTOFF_ENV || "2026-06-01T00:00:00Z");

/**
 * Decrypt a value that was encrypted with encryptSecret.
 *
 * @param context Optional human-readable label describing what is being
 * decrypted (e.g. `DNS provider "cloudflare" credential "api_token"`).
 * Included in error messages so users can tell which stored value failed.
 */
export function decryptSecret(value: string, context?: string): string {
  if (!value) return "";
  if (!isEncryptedSecret(value)) return value;

  const label = context ? ` for ${context}` : "";
  const recoveryHint =
    "This usually happens when SESSION_SECRET changed after the value was stored. " +
    "Fix: re-enter the affected token/secret in the UI to re-encrypt it with the current key, or restore the previous SESSION_SECRET.";

  // Try new HKDF key first
  try {
    return _decryptWithKey(value, deriveKey());
  } catch (hkdfError: unknown) {
    // Only fall back to legacy key within the grace period
    if (LEGACY_KEY_CUTOFF && new Date() > LEGACY_KEY_CUTOFF) {
      throw new Error(
        `[secret] Failed to decrypt stored secret${label}: HKDF decryption failed and the legacy key grace period has expired. ` +
          recoveryHint +
          " Set LEGACY_KEY_CUTOFF_DATE=never to temporarily restore legacy key support.",
        { cause: hkdfError },
      );
    }
    console.warn(
      "[secret] HKDF decryption failed; retrying with legacy SHA-256 key. Re-encrypt this secret to remove the legacy key dependency.",
    );
    try {
      return _decryptWithKey(value, deriveKeyLegacy());
    } catch (legacyError: unknown) {
      throw new Error(
        `[secret] Failed to decrypt stored secret${label}: decryption failed with both the current (HKDF) and legacy keys. ` +
          recoveryHint,
        { cause: legacyError },
      );
    }
  }
}

function _decryptWithKey(value: string, key: Buffer): string {
  const payload = value.slice(PREFIX.length);
  const [ivB64, tagB64, dataB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Invalid encrypted secret format");
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (tag.length !== 16) {
    throw new Error("Invalid authentication tag length");
  }
  const data = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString("utf8");
}
