/**
 * Single-use values every replica must agree on: a replay sent to a second controller must find
 * the first one's record. One upsert claims, so two at once cannot both succeed.
 */
import { and, eq, gt, lte } from "drizzle-orm";
import db from "../db";
import { spentNonces } from "../db/schema";

/** False when already spent and not yet expired. `expiresAt` is when it could no longer verify. */
export async function claimNonce(
  key: string,
  expiresAt: number,
  now = Date.now(),
): Promise<boolean> {
  const claimed = await db
    .insert(spentNonces)
    .values({ key, expiresAt })
    .onConflictDoUpdate({
      target: spentNonces.key,
      set: { expiresAt },
      setWhere: lte(spentNonces.expiresAt, now),
    })
    .returning({ key: spentNonces.key });
  return claimed.length > 0;
}

export async function isNonceSpent(key: string, now = Date.now()): Promise<boolean> {
  const [row] = await db
    .select({ key: spentNonces.key })
    .from(spentNonces)
    .where(and(eq(spentNonces.key, key), gt(spentNonces.expiresAt, now)))
    .limit(1);
  return row !== undefined;
}

export async function pruneSpentNonces(now = Date.now()): Promise<void> {
  await db.delete(spentNonces).where(lte(spentNonces.expiresAt, now));
}
