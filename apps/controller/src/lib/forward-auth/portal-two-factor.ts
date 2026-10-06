/**
 * A portal sign-in between password and second factor. The portal has no Better Auth session to
 * hold the challenge, so the browser carries a signed, short-lived one, like `captcha/pass.ts`.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import db from "../db";
import { rateLimitCounters } from "../db/schema";
import { derivePurposeKey } from "../secrets/derived-key";

export const PORTAL_CHALLENGE_TTL_MS = 5 * 60_000;
/** Codes one challenge may try before the password has to be entered again. */
export const PORTAL_CHALLENGE_ATTEMPTS = 5;

/** Attempts per nonce, shared so a second replica is no fresh budget; pruned once expired. */
const attemptsKey = (nonce: string) => `portal-2fa:${nonce}`;

function signature(userId: number, rid: string, expiresAt: number, nonce: string): string {
  return createHmac("sha256", derivePurposeKey("portal-2fa:v1"))
    .update(`${userId}\n${rid}\n${expiresAt}\n${nonce}`)
    .digest("base64url");
}

export function issuePortalChallenge(userId: number, rid: string, now = Date.now()): string {
  const expiresAt = now + PORTAL_CHALLENGE_TTL_MS;
  const nonce = randomBytes(16).toString("base64url");
  return `${userId}.${expiresAt}.${nonce}.${signature(userId, rid, expiresAt, nonce)}`;
}

/** Counts as one attempt; null when forged, expired, for another intent, or out of attempts. */
export async function redeemPortalChallenge(
  challenge: string | null | undefined,
  rid: string,
  now = Date.now(),
): Promise<{ userId: number; nonce: string } | null> {
  if (!challenge || !rid) return null;
  const [id, expiry, nonce, sig, ...rest] = challenge.split(".");
  if (rest.length > 0 || !id || !expiry || !nonce || !sig) return null;
  if (!/^\d{1,10}$/.test(id) || !/^\d{1,15}$/.test(expiry)) return null;
  const userId = Number(id);
  const expiresAt = Number(expiry);
  if (expiresAt <= now || expiresAt > now + PORTAL_CHALLENGE_TTL_MS) return null;

  const expected = Buffer.from(signature(userId, rid, expiresAt, nonce));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  const [row] = await db
    .insert(rateLimitCounters)
    .values({ key: attemptsKey(nonce), count: 1, resetAt: expiresAt })
    .onConflictDoUpdate({
      target: rateLimitCounters.key,
      set: { count: sql`${rateLimitCounters.count} + 1` },
    })
    .returning({ count: rateLimitCounters.count });
  if (!row || row.count > PORTAL_CHALLENGE_ATTEMPTS) return null;
  return { userId, nonce };
}

/** Spent on sign-in, so the challenge can't be replayed for the rest of its TTL. */
export async function spendPortalChallenge(nonce: string): Promise<void> {
  await db
    .update(rateLimitCounters)
    .set({ count: PORTAL_CHALLENGE_ATTEMPTS })
    .where(eq(rateLimitCounters.key, attemptsKey(nonce)));
}
