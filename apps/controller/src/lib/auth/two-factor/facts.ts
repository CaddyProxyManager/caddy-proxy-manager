import { count, eq } from "drizzle-orm";
import db from "../../db";
import { passkeys, users } from "../../db/schema";

/** What the policy needs beyond the session: read only for an account it covers without TOTP. */
export async function accountMfaFacts(
  userId: number,
): Promise<{ passkeyCount: number; createdAt: string | null }> {
  const [[keys], [user]] = await Promise.all([
    db.select({ total: count() }).from(passkeys).where(eq(passkeys.userId, userId)),
    db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId)).limit(1),
  ]);
  return { passkeyCount: Number(keys?.total ?? 0), createdAt: user?.createdAt ?? null };
}
