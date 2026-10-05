import { count, eq } from "drizzle-orm";
import db from "../../db";
import { passkeys, users } from "../../db/schema";

/** A passkey is both factors at once, so it satisfies the policy on its own. */
export async function accountPasskeyCount(userId: number): Promise<number> {
  const [keys] = await db
    .select({ total: count() })
    .from(passkeys)
    .where(eq(passkeys.userId, userId));
  return Number(keys?.total ?? 0);
}

/** What the policy needs beyond the session: read only for an account it covers without TOTP. */
export async function accountMfaFacts(
  userId: number,
): Promise<{ passkeyCount: number; createdAt: string | null }> {
  const [passkeyCount, [user]] = await Promise.all([
    accountPasskeyCount(userId),
    db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId)).limit(1),
  ]);
  return { passkeyCount, createdAt: user?.createdAt ?? null };
}
