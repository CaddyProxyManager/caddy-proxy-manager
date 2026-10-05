/**
 * After a SESSION_SECRET rotation, moves every stored secret that only an old key opens
 * (SESSION_SECRET_PREVIOUS, a refused placeholder, the legacy derivation) onto the current key, so
 * rotating needs no re-entry. Found by marker in every table (./secret-walk.ts), not from a list.
 */
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { and, eq, getTableColumns, like, or } from "drizzle-orm";
import { getTableConfig, type PgColumn, type PgTable } from "drizzle-orm/pg-core";
import { config } from "../config";
import db from "../db";
import { activeSchema } from "../db/schema";
import { describeTables } from "../migration/import";
import {
  ENCRYPTED_SECRET_PREFIX,
  isEncryptedSecret,
  previousSessionSecrets,
  reencryptSecret,
} from "./index";
import { BETTER_AUTH_ENCRYPTED_COLUMNS, mapTextColumn } from "./walk";

export type SecretRotationResult = {
  /** Values rewritten under the current key. */
  reencrypted: number;
  /** Values no known key opens, left as they are. */
  failed: number;
  /** OAuth tokens no known key opens, set to NULL: the next sign-in with that provider stores new ones. */
  clearedOAuthTokens: number;
};

/** Cleared rather than reported when unreadable: nothing needs them past the sign-in that wrote them. */
const CLEARABLE: Readonly<Record<string, readonly string[]>> = {
  accounts: ["accessToken", "refreshToken", "idToken"],
};

type Located = { column: PgColumn; field: string };

/** How a row is addressed: its primary key, else its first unique index. */
function keyColumns(table: PgTable): string[] {
  const config = getTableConfig(table);
  const primary = config.columns.filter((column) => column.primary).map((column) => column.name);
  if (primary.length > 0) return primary;
  const composite = config.primaryKeys[0];
  if (composite) return composite.columns.map((column) => column.name);
  const unique = config.indexes.find((index) => index.config.unique);
  const columns = unique?.config.columns ?? [];
  return columns.every((column) => "name" in column)
    ? columns.map((column) => (column as { name: string }).name)
    : [];
}

function reportUnreadable(where: string) {
  console.warn(
    `[secret] ${where} cannot be decrypted with SESSION_SECRET or SESSION_SECRET_PREVIOUS; ` +
      "re-enter it in the UI or set SESSION_SECRET_PREVIOUS to the secret it was stored with.",
  );
}

/** Better Auth's cipher, keyed with the secret itself. Null when nothing needs doing. */
async function rotateBetterAuthValue(value: string): Promise<string | null | "unreadable"> {
  try {
    await symmetricDecrypt({ key: config.sessionSecret, data: value });
    return null;
  } catch {
    // Not under the current key; try the old ones.
  }
  for (const secret of previousSessionSecrets()) {
    try {
      const plaintext = await symmetricDecrypt({ key: secret, data: value });
      return await symmetricEncrypt({ key: config.sessionSecret, data: plaintext });
    } catch {
      // The next one, then.
    }
  }
  return "unreadable";
}

/** Idempotent: a value already under the current key costs one decryption and is not rewritten. */
export async function reencryptStoredSecrets(): Promise<SecretRotationResult> {
  const result: SecretRotationResult = { reencrypted: 0, failed: 0, clearedOAuthTokens: 0 };

  for (const described of describeTables()) {
    const table = activeSchema[described.key as keyof typeof activeSchema] as unknown as PgTable;
    const byName = new Map<string, Located>(
      Object.entries(getTableColumns(table)).map(([field, column]) => [
        column.name,
        { column: column as PgColumn, field },
      ]),
    );
    const textColumns = getTableConfig(described.table)
      .columns.filter((column) => column.dataType === "string" && byName.has(column.name))
      .map((column) => column.name);
    const betterAuthColumns = BETTER_AUTH_ENCRYPTED_COLUMNS[described.name] ?? [];
    const keys = keyColumns(described.table);
    if (textColumns.length === 0 || keys.length === 0) continue;

    const located = (name: string) => byName.get(name) as Located;
    const selection = Object.fromEntries(
      [...new Set([...keys, ...textColumns])].map((name) => [name, located(name).column]),
    );
    const marked = or(
      ...textColumns.map((name) => like(located(name).column, `%${ENCRYPTED_SECRET_PREFIX}%`)),
    );
    // Better Auth's columns carry no marker, so their table is read whole; it is one row per user.
    const rows = (await db
      .select(selection)
      .from(table)
      .where(betterAuthColumns.length > 0 ? undefined : marked)) as Record<string, unknown>[];

    for (const row of rows) {
      const where = `${described.name} ${keys.map((key) => row[key]).join("/")}`;
      const updates: Record<string, string | null> = {};
      let reencrypted = 0;
      let cleared = 0;

      for (const name of textColumns) {
        const value = row[name];
        if (typeof value !== "string" || !value) continue;

        if (betterAuthColumns.includes(name)) {
          const rotated = await rotateBetterAuthValue(value);
          if (rotated === "unreadable") {
            result.failed += 1;
            reportUnreadable(`${where} ${name}`);
          } else if (rotated !== null) {
            updates[located(name).field] = rotated;
            reencrypted += 1;
          }
          continue;
        }

        if (!value.includes(ENCRYPTED_SECRET_PREFIX)) continue;
        let rotatedHere = 0;
        let unreadable = 0;
        const next = mapTextColumn(value, ENCRYPTED_SECRET_PREFIX, (text) => {
          if (!isEncryptedSecret(text)) return text;
          try {
            const rotated = reencryptSecret(text);
            if (rotated === null) return text;
            rotatedHere += 1;
            return rotated;
          } catch {
            unreadable += 1;
            return text;
          }
        });

        if (unreadable > 0 && CLEARABLE[described.name]?.includes(name)) {
          updates[located(name).field] = null;
          cleared += 1;
          continue;
        }
        if (unreadable > 0) {
          result.failed += unreadable;
          reportUnreadable(`${where} ${name}`);
        }
        if (rotatedHere > 0) {
          updates[located(name).field] = next;
          reencrypted += rotatedHere;
        }
      }

      if (Object.keys(updates).length === 0) continue;
      try {
        await db
          .update(table)
          .set(updates)
          .where(and(...keys.map((key) => eq(located(key).column, row[key]))));
        result.reencrypted += reencrypted;
        result.clearedOAuthTokens += cleared;
      } catch (error) {
        result.failed += reencrypted;
        console.warn("[secret] Failed to store re-encrypted %s:", where, error);
      }
    }
  }

  return result;
}
