/**
 * A solved CAPTCHA, good for one password attempt on one account, right or wrong. Spent on the
 * server: clearing the cookie stops only a browser, not a script replaying it.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { claimNonce, isNonceSpent } from "../cluster/nonces";
import { derivePurposeKey } from "../secrets/derived-key";
import { accountKey } from "../auth/rate-limit";

export const CAPTCHA_PASS_COOKIE = "cpm-captcha-pass";
/** How long a pass may sit unused. */
export const CAPTCHA_PASS_TTL_MS = 10 * 60_000;
/** Covers both /api/auth and /api/forward-auth. */
export const CAPTCHA_PASS_PATH = "/api";
export const CAPTCHA_PASS_CLEAR_COOKIE = `${CAPTCHA_PASS_COOKIE}=; Path=${CAPTCHA_PASS_PATH}; Max-Age=0; HttpOnly; SameSite=Strict`;

/** Spent passes are shared, so a pass solved through one replica redeems once on any. */
const spentKey = (nonce: string) => `captcha:${nonce}`;

function signature(account: string, expiresAt: number, nonce: string): string {
  return createHmac("sha256", derivePurposeKey("captcha-pass:v1"))
    .update(`${account}\n${expiresAt}\n${nonce}`)
    .digest("base64url");
}

export function issueCaptchaPass(username: string, now = Date.now()): string {
  const expiresAt = now + CAPTCHA_PASS_TTL_MS;
  const nonce = randomBytes(16).toString("base64url");
  return `${expiresAt}.${nonce}.${signature(accountKey(username), expiresAt, nonce)}`;
}

/** Spends nothing. */
function verify(
  pass: string | null | undefined,
  username: string,
  now: number,
): { nonce: string; expiresAt: number } | null {
  // A blank name is the account key of "@localhost", so it must never match anything.
  if (!pass || !username.trim()) return null;
  const [expiry, nonce, sig, ...rest] = pass.split(".");
  if (rest.length > 0 || !expiry || !nonce || !sig || !/^\d{1,15}$/.test(expiry)) return null;
  const expiresAt = Number(expiry);
  // A pass is never minted further out than the TTL.
  if (expiresAt <= now || expiresAt > now + CAPTCHA_PASS_TTL_MS) return null;
  const expected = Buffer.from(signature(accountKey(username), expiresAt, nonce));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { nonce, expiresAt };
}

/** Without spending it. */
export async function isValidCaptchaPass(
  pass: string | null | undefined,
  username: string,
  now = Date.now(),
): Promise<boolean> {
  const verified = verify(pass, username, now);
  return verified !== null && !(await isNonceSpent(spentKey(verified.nonce), now));
}

/** One claim from check to record, so two replays of one pass cannot both get through. */
export async function redeemCaptchaPass(
  pass: string | null | undefined,
  username: string,
  now = Date.now(),
): Promise<boolean> {
  const verified = verify(pass, username, now);
  if (!verified) return false;
  return claimNonce(spentKey(verified.nonce), verified.expiresAt, now);
}

export function captchaPassFromCookieHeader(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === CAPTCHA_PASS_COOKIE) return value.join("=");
  }
  return null;
}
