import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config, DISALLOWED_SESSION_SECRETS } from "../config";
import { derivePurposeKey } from "./derived-key";

export const ENCRYPTED_SECRET_PREFIX = "enc:v1:";
const PREFIX = ENCRYPTED_SECRET_PREFIX;
const IV_LENGTH = 12;

function deriveKey(sessionSecret: string = config.sessionSecret): Buffer {
  return derivePurposeKey("secret:v1", sessionSecret);
}

function deriveKeyLegacy(sessionSecret: string = config.sessionSecret): Buffer {
  return createHash("sha256").update(sessionSecret).digest();
}

/**
 * For the migration: a pre-3.0 database's secrets are under its own `SESSION_SECRET`. Both
 * derivations are tried, as in `decryptSecret`, but with no grace-period cutoff - refusing a legacy
 * value in the one operation that re-encrypts it is backwards. Null, not a throw, on a wrong key.
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

function encryptWithCurrentKey(value: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function encryptSecret(value: string): string {
  if (!value) return "";
  if (isEncryptedSecret(value)) return value;
  return encryptWithCurrentKey(value);
}

/**
 * Secrets that may decrypt but never encrypt: SESSION_SECRET_PREVIOUS, then the public placeholders
 * older installs ran with, which reveal nothing by being tried.
 */
export function previousSessionSecrets(): string[] {
  const secrets = new Set([...config.previousSessionSecrets, ...DISALLOWED_SESSION_SECRETS]);
  secrets.delete(config.sessionSecret);
  return [...secrets];
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

function legacyKeyAllowed(): boolean {
  return !LEGACY_KEY_CUTOFF || new Date() <= LEGACY_KEY_CUTOFF;
}

/** For a value the current HKDF key could not open. Throws with a recovery hint when none can. */
function decryptWithFallbackKeys(
  value: string,
  context: string | undefined,
  currentKeyError: unknown,
): { plaintext: string; source: "legacy" | "previous" } {
  const withLegacy = legacyKeyAllowed();
  let lastError = currentKeyError;

  if (withLegacy) {
    try {
      return { plaintext: _decryptWithKey(value, deriveKeyLegacy()), source: "legacy" };
    } catch (error) {
      lastError = error;
    }
  }
  for (const secret of previousSessionSecrets()) {
    const keys = withLegacy ? [deriveKey(secret), deriveKeyLegacy(secret)] : [deriveKey(secret)];
    for (const key of keys) {
      try {
        return { plaintext: _decryptWithKey(value, key), source: "previous" };
      } catch (error) {
        lastError = error;
      }
    }
  }

  const label = context ? ` for ${context}` : "";
  const recoveryHint =
    "This usually happens when SESSION_SECRET changed after the value was stored. " +
    "Fix: set SESSION_SECRET_PREVIOUS to the secret the value was stored with and restart " +
    "(startup re-encrypts it with the current key), or re-enter the affected token/secret in the UI.";

  if (!withLegacy) {
    throw new Error(
      `[secret] Failed to decrypt stored secret${label}: HKDF decryption failed with the current key and SESSION_SECRET_PREVIOUS, and the legacy key grace period has expired. ` +
        recoveryHint +
        " Set LEGACY_KEY_CUTOFF_DATE=never to temporarily restore legacy key support.",
      { cause: lastError },
    );
  }
  throw new Error(
    `[secret] Failed to decrypt stored secret${label}: decryption failed with the current (HKDF) and legacy keys, and with SESSION_SECRET_PREVIOUS. ` +
      recoveryHint,
    { cause: lastError },
  );
}

/**
 * @param context Label for what is being decrypted (e.g. `DNS provider "cloudflare" credential
 * "api_token"`), included in errors so users can tell which stored value failed.
 */
export function decryptSecret(value: string, context?: string): string {
  if (!value) return "";
  if (!isEncryptedSecret(value)) return value;

  try {
    return _decryptWithKey(value, deriveKey());
  } catch (currentKeyError: unknown) {
    const { plaintext, source } = decryptWithFallbackKeys(value, context, currentKeyError);
    console.warn(
      source === "legacy"
        ? "[secret] Decrypted a stored secret with the legacy SHA-256 key. Re-encrypt this secret to remove the legacy key dependency."
        : "[secret] Decrypted a stored secret with a previous SESSION_SECRET. Keep SESSION_SECRET_PREVIOUS set until " +
            "a restart has re-encrypted it with the current key.",
    );
    return plaintext;
  }
}

/**
 * The value under the current key when only a fallback key opens it; null when it is not
 * encrypted or needs nothing. Throws like decryptSecret when no key opens it.
 */
export function reencryptSecret(value: string, context?: string): string | null {
  if (!value || !isEncryptedSecret(value)) return null;
  try {
    _decryptWithKey(value, deriveKey());
    return null;
  } catch (currentKeyError: unknown) {
    const { plaintext } = decryptWithFallbackKeys(value, context, currentKeyError);
    return encryptWithCurrentKey(plaintext);
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
