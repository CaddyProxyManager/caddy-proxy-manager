/**
 * Secrets in and out of a backup.
 *
 * The database encrypts its secrets with a key derived from this deployment's SESSION_SECRET. A
 * backup has to restore onto a machine with a different one, so on the way out every encrypted
 * value is replaced by its plaintext under a marker, and on the way in each marker is encrypted
 * again under the restoring deployment's key. The file itself is sealed with the passphrase.
 *
 * Two kinds of ciphertext: the app's own `enc:v1:` tokens - found anywhere in a text column,
 * including inside the JSON the settings are stored as - and Better Auth's, which only the
 * two-factor plugin's columns hold.
 */
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { config } from "../config";
import { decryptSecret, encryptSecret, isEncryptedSecret, sealSecretColumn } from "../secret";

const MARKER = "cpmbak-secret:";
/** Better Auth encrypts these with the auth secret, not with `enc:v1:`. */
const BETTER_AUTH_ENCRYPTED: Record<string, readonly string[]> = {
  two_factors: ["secret", "backupCodes"],
};

function mapStrings(input: unknown, map: (text: string) => string): unknown {
  if (typeof input === "string") return map(input);
  if (Array.isArray(input)) return input.map((entry) => mapStrings(entry, map));
  if (input !== null && typeof input === "object") {
    return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, mapStrings(v, map)]));
  }
  return input;
}

/** Applies `map` to a column value and, when the value is JSON text, to every string inside it. */
function mapTextColumn(value: string, needle: string, map: (text: string) => string): string {
  if (!value.includes(needle)) return value;
  const whole = map(value);
  if (whole !== value) return whole;
  try {
    return JSON.stringify(mapStrings(JSON.parse(value), map));
  } catch {
    return value;
  }
}

const toMarker = (plaintext: string) => `${MARKER}${Buffer.from(plaintext).toString("base64")}`;
const fromMarker = (text: string) => Buffer.from(text.slice(MARKER.length), "base64").toString();

export async function exportRow(
  table: string,
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    if (typeof value !== "string") {
      out[column] = value;
    } else if (BETTER_AUTH_ENCRYPTED[table]?.includes(column)) {
      out[column] = toMarker(await symmetricDecrypt({ key: config.sessionSecret, data: value }));
    } else {
      out[column] = mapTextColumn(value, "enc:v1:", (text) =>
        isEncryptedSecret(text) ? toMarker(decryptSecret(text, `${table}.${column}`)) : text,
      );
    }
  }
  return out;
}

export async function importRow(
  table: string,
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    if (typeof value !== "string") {
      out[column] = value;
    } else if (BETTER_AUTH_ENCRYPTED[table]?.includes(column) && value.startsWith(MARKER)) {
      out[column] = await symmetricEncrypt({ key: config.sessionSecret, data: fromMarker(value) });
    } else {
      // A backup from before a column was encrypted carries it in plain text, with no marker.
      out[column] = sealSecretColumn(
        table,
        column,
        mapTextColumn(value, MARKER, (text) =>
          text.startsWith(MARKER) ? encryptSecret(fromMarker(text)) : text,
        ),
      );
    }
  }
  return out;
}
