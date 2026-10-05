/** The passkeys table outside Better Auth's routes: counts, the admin reset, lock-out guards. */
import { getAuthenticatorName } from "@better-auth/passkey";
import { asc, count, eq, inArray } from "drizzle-orm";
import db from "../../db";
import { passkeys } from "../../db/schema";
import { getUserById, getUserPasswordHash, listUserOAuthProviders } from "../../models/user";

/** What Profile lists: never the public key or credential id. */
export type PasskeySummary = {
  id: number;
  /** The name given, else the password manager or platform its AAGUID names, else null. */
  label: string | null;
  createdAt: string | null;
  /** Synced to other devices (a multi-device credential), so losing this one loses nothing. */
  backedUp: boolean;
};

export async function listUserPasskeys(userId: number): Promise<PasskeySummary[]> {
  const rows = await db
    .select({
      id: passkeys.id,
      name: passkeys.name,
      aaguid: passkeys.aaguid,
      createdAt: passkeys.createdAt,
      backedUp: passkeys.backedUp,
    })
    .from(passkeys)
    .where(eq(passkeys.userId, userId))
    .orderBy(asc(passkeys.id));
  return rows.map((row) => ({
    id: row.id,
    label: row.name?.trim() || getAuthenticatorName(row.aaguid) || null,
    createdAt: row.createdAt,
    backedUp: row.backedUp,
  }));
}

export async function countUserPasskeys(userId: number): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(passkeys)
    .where(eq(passkeys.userId, userId));
  return Number(row?.total ?? 0);
}

export async function passkeyCountsByUser(userIds: number[]): Promise<Map<number, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ userId: passkeys.userId, total: count() })
    .from(passkeys)
    .where(inArray(passkeys.userId, userIds))
    .groupBy(passkeys.userId);
  return new Map(rows.map((row) => [row.userId, Number(row.total)]));
}

export async function deleteUserPasskeys(userId: number): Promise<number> {
  const deleted = await db
    .delete(passkeys)
    .where(eq(passkeys.userId, userId))
    .returning({ id: passkeys.id });
  return deleted.length;
}

export async function anyPasskeysExist(): Promise<boolean> {
  const [row] = await db.select({ id: passkeys.id }).from(passkeys).limit(1);
  return Boolean(row);
}

/**
 * Whether the account keeps a way in with `passkeysLeft` passkeys: a password, a linked provider
 * or a passkey. Unlinking a provider asks for the password, so it needs no check here.
 */
export async function keepsSignInMethod(userId: number, passkeysLeft: number): Promise<boolean> {
  if (passkeysLeft > 0) return true;
  const user = await getUserById(userId);
  if (!user) return false;
  if (await getUserPasswordHash(user)) return true;
  return (await listUserOAuthProviders(userId)).length > 0;
}
