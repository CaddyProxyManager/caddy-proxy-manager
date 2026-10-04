/**
 * Browsers that receive the administrators' notifications. Keyed by endpoint, which the browser
 * itself identifies a subscription by, and which this server POSTs to on every batch: so only a
 * push service's own host is accepted, never an address an admin typed.
 */

import { and, asc, eq, inArray, isNull, ne, or } from "drizzle-orm";
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
/** Per user; the oldest go first. Every send fans out to each one. */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;

/**
 * The push services browsers use: Chrome, Edge (and other Chromium) via FCM or WNS, Firefox via
 * Mozilla's autopush, Safari via Apple. Anything else would be the server POSTing wherever it is
 * told, internal addresses included.
 */
const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "push.services.mozilla.com",
  "notify.windows.com",
  "push.apple.com",
];

export function isPushServiceUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // No explicit port, credentials or IP literal: none of which a real push service hands out.
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** What `PushSubscription.toJSON()` gives, checked: it arrives from the browser. */
export function parsePushSubscription(value: unknown): BrowserSubscription {
  const input = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = input?.endpoint;
  const p256dh = input?.keys?.p256dh;
  const auth = input?.keys?.auth;
  if (
    typeof endpoint !== "string" ||
    endpoint.length > MAX_ENDPOINT ||
    !isPushServiceUrl(endpoint) ||
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

/**
 * Another user's endpoint is refused rather than taken over: turning push on always makes a fresh
 * subscription, so a clash is a copied endpoint, not this browser.
 */
export async function savePushSubscription(
  userId: number,
  subscription: BrowserSubscription,
  locale: Locale,
  userAgent: string | null,
  sessionId: number | null = null,
): Promise<void> {
  const [existing] = await db
    .select({ userId: pushSubscriptions.userId })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, subscription.endpoint))
    .limit(1);
  if (existing && existing.userId !== userId) throw domainError("pushSubscriptionInvalid");

  const row = {
    userId,
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    locale,
    userAgent: userAgent?.slice(0, MAX_USER_AGENT) ?? null,
    sessionId,
    createdAt: nowIso(),
  };
  await db
    .insert(pushSubscriptions)
    .values(row)
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: row });

  const mine = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .orderBy(asc(pushSubscriptions.createdAt), asc(pushSubscriptions.id));
  const excess = mine.slice(0, Math.max(0, mine.length - MAX_SUBSCRIPTIONS_PER_USER));
  if (excess.length > 0) {
    await db.delete(pushSubscriptions).where(
      inArray(
        pushSubscriptions.id,
        excess.map((entry) => entry.id),
      ),
    );
  }
}

/** Only the caller's own: the session is what proves ownership, not knowing an endpoint. */
export async function deletePushSubscription(userId: number, endpoint: string): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}

export async function deletePushSubscriptionById(userId: number, id: number): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.id, id)));
}

/** For a push service that answered "gone": the browser dropped it, so must we. */
export async function forgetPushEndpoint(endpoint: string): Promise<void> {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
}

/**
 * Browsers turned on from revoked sessions. `keepSessionId` is the session doing the revoking,
 * whose own browser stays; one with no recorded session cannot be told apart, so it goes too.
 */
export async function forgetPushForRevokedSessions(
  userId: number,
  revoked: { all: true; keepSessionId: number | null } | { all: false; sessionIds: number[] },
): Promise<void> {
  if (revoked.all) {
    const keep = revoked.keepSessionId;
    await db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, userId),
          keep === null
            ? undefined
            : or(isNull(pushSubscriptions.sessionId), ne(pushSubscriptions.sessionId, keep)),
        ),
      );
    return;
  }
  if (revoked.sessionIds.length === 0) return;
  await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.userId, userId),
        inArray(pushSubscriptions.sessionId, revoked.sessionIds),
      ),
    );
}

export async function hasPushSubscription(userId: number, endpoint: string): Promise<boolean> {
  const rows = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
    .limit(1);
  return rows.length > 0;
}

/** The caller's browsers, for Profile to list and remove; never the endpoint or keys. */
export async function listPushSubscriptions(
  userId: number,
): Promise<{ id: number; userAgent: string | null; createdAt: string }[]> {
  return db
    .select({
      id: pushSubscriptions.id,
      userAgent: pushSubscriptions.userAgent,
      createdAt: pushSubscriptions.createdAt,
    })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .orderBy(asc(pushSubscriptions.createdAt));
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

/** Whether any exists, without reading endpoints or keys: asked on every notification. */
export async function hasAdminPushTarget(): Promise<boolean> {
  const rows = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .innerJoin(users, eq(users.id, pushSubscriptions.userId))
    .where(and(eq(users.role, "admin"), eq(users.status, "active")))
    .limit(1);
  return rows.length > 0;
}
