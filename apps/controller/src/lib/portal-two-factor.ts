/**
 * A portal sign-in between password and second factor. The portal has no Better Auth session to
 * hold the challenge, so the browser carries a signed, short-lived one, like `captcha/pass.ts`.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { derivePurposeKey } from "./derived-key";

export const PORTAL_CHALLENGE_TTL_MS = 5 * 60_000;
/** Codes one challenge may try before the password has to be entered again. */
export const PORTAL_CHALLENGE_ATTEMPTS = 5;

/** Attempts per live nonce; spent ones stay until they would have expired anyway. */
const ATTEMPTS = new Map<string, { count: number; expiresAt: number }>();
const MAX_TRACKED = 100_000;
/** Expired entries go at most this often, so a long-lived process doesn't keep every nonce. */
const PRUNE_INTERVAL_MS = 60_000;
let lastPrune = 0;

/** A restart invalidates every challenge, since ATTEMPTS starts empty again. */
const bootSalt = randomBytes(32);

function signature(userId: number, rid: string, expiresAt: number, nonce: string): string {
  const key = createHmac("sha256", derivePurposeKey("portal-2fa:v1")).update(bootSalt).digest();
  return createHmac("sha256", key)
    .update(`${userId}\n${rid}\n${expiresAt}\n${nonce}`)
    .digest("base64url");
}

function prune(now: number) {
  lastPrune = now;
  for (const [nonce, entry] of ATTEMPTS) if (entry.expiresAt <= now) ATTEMPTS.delete(nonce);
}

export function issuePortalChallenge(userId: number, rid: string, now = Date.now()): string {
  const expiresAt = now + PORTAL_CHALLENGE_TTL_MS;
  const nonce = randomBytes(16).toString("base64url");
  return `${userId}.${expiresAt}.${nonce}.${signature(userId, rid, expiresAt, nonce)}`;
}

/** Counts as one attempt; null when forged, expired, for another intent, or out of attempts. */
export function redeemPortalChallenge(
  challenge: string | null | undefined,
  rid: string,
  now = Date.now(),
): { userId: number; nonce: string } | null {
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

  if (ATTEMPTS.size >= MAX_TRACKED || now - lastPrune >= PRUNE_INTERVAL_MS) prune(now);
  const entry = ATTEMPTS.get(nonce) ?? { count: 0, expiresAt };
  if (entry.count >= PORTAL_CHALLENGE_ATTEMPTS) return null;
  entry.count += 1;
  ATTEMPTS.set(nonce, entry);
  return { userId, nonce };
}

/** Spent on sign-in, so the challenge can't be replayed for the rest of its TTL. */
export function spendPortalChallenge(nonce: string) {
  const entry = ATTEMPTS.get(nonce);
  if (entry) entry.count = PORTAL_CHALLENGE_ATTEMPTS;
}
