/**
 * Secrets are keyed to this deployment's SESSION_SECRET and a restore target has another, so they
 * leave as marked plaintext and are re-encrypted on the way in. `enc:v1:` tokens can sit anywhere
 * in a text column, settings JSON included; Better Auth's own are only in the 2FA columns.
 */
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { config } from "../config";
import {
  decryptSecret,
  ENCRYPTED_SECRET_PREFIX,
  encryptSecret,
  isEncryptedSecret,
  sealSecretColumn,
} from "../secret";
import {
  BETTER_AUTH_ENCRYPTED_COLUMNS as BETTER_AUTH_ENCRYPTED,
  mapTextColumn,
} from "../secret-walk";

const MARKER = "cpmbak-secret:";

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
      out[column] = mapTextColumn(value, ENCRYPTED_SECRET_PREFIX, (text) =>
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
