/**
 * Browsers that receive the administrators' notifications. Keyed by endpoint, which the browser
 * itself identifies a subscription by: one signing in as someone else moves to that account.
 */

import { and, eq } from "drizzle-orm";
import db, { nowIso } from "../db";
import { pushSubscriptions, users } from "../db/schema";
import { domainError } from "../domain-error";
import type { Locale } from "../locale";

export type PushTarget = {
  userId: number;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  locale: string | null;
};

export type BrowserSubscription = Pick<PushTarget, "endpoint" | "keys">;

/** Bounds a row a browser hands us; real endpoints and keys are a fraction of these. */
const MAX_ENDPOINT = 2048;
const MAX_KEY = 256;
const MAX_USER_AGENT = 300;

/** What `PushSubscription.toJSON()` gives, checked: it arrives from the browser. */
export function parsePushSubscription(value: unknown): BrowserSubscription {
  const input = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = input?.endpoint;
  const p256dh = input?.keys?.p256dh;
  const auth = input?.keys?.auth;
  if (
    typeof endpoint !== "string" ||
    endpoint.length > MAX_ENDPOINT ||
    !endpoint.startsWith("https://") ||
    typeof p256dh !== "string" ||
    typeof auth !== "string" ||
    p256dh.length === 0 ||
    auth.length === 0 ||
    p256dh.length > MAX_KEY ||
    auth.length > MAX_KEY
  ) {
    throw domainError("pushSubscriptionInvalid");
  }
  return { endpoint, keys: { p256dh, auth } };
}

export async function savePushSubscription(
  userId: number,
  subscription: BrowserSubscription,
  locale: Locale,
  userAgent: string | null,
): Promise<void> {
  const row = {
    userId,
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    locale,
    userAgent: userAgent?.slice(0, MAX_USER_AGENT) ?? null,
    createdAt: nowIso(),
  };
  await db
    .insert(pushSubscriptions)
    .values(row)
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: row });
}

/** Only the caller's own: an endpoint is not a secret, the session is what proves ownership. */
export async function deletePushSubscription(userId: number, endpoint: string): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}

/** For a push service that answered "gone": the browser dropped it, so must we. */
export async function forgetPushEndpoint(endpoint: string): Promise<void> {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
}

export async function hasPushSubscription(userId: number, endpoint: string): Promise<boolean> {
  const rows = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
    .limit(1);
  return rows.length > 0;
}

/** Every browser of an active administrator; a demoted or disabled one stops receiving at once. */
export async function adminPushTargets(): Promise<PushTarget[]> {
  const rows = await db
    .select({
      userId: pushSubscriptions.userId,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
      locale: pushSubscriptions.locale,
    })
    .from(pushSubscriptions)
    .innerJoin(users, eq(users.id, pushSubscriptions.userId))
    .where(and(eq(users.role, "admin"), eq(users.status, "active")));
  return rows.map((row) => ({
    userId: row.userId,
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
    locale: row.locale,
  }));
}
