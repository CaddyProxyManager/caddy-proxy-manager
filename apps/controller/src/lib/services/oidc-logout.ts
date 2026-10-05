/**
 * OIDC back-channel logout's database half. The `sid` arrives with the account row but belongs on
 * the session row created moments later: the account hook parks it, the session hook takes it.
 */

import { and, eq, inArray } from "drizzle-orm";
import db from "../db";
import { accounts, sessions } from "../db/schema";
import { logAuditEvent } from "../audit";
import { decodeJwtPayload } from "../auth/oidc/claims";
import { decryptSecret, isEncryptedSecret } from "../secrets";
import { deleteUserForwardAuthSessions } from "../models/forward-auth";

export type PendingSessionBinding = {
  userId: number;
  providerId: string;
  sid: string;
};

/**
 * Keyed by the sign-in request's own endpoint context, which Better Auth hands both the account
 * and the session hook: overlapping sign-ins for one user each keep their own `sid`, whatever order
 * their hooks finish in. Weak, so an unconsumed entry goes with its request.
 */
const pending = new WeakMap<object, PendingSessionBinding>();

export function recordPendingSessionBinding(request: object, entry: PendingSessionBinding): void {
  pending.set(request, entry);
}

export function consumePendingSessionBinding(
  request: object,
  userId: number,
): PendingSessionBinding | null {
  const entry = pending.get(request);
  pending.delete(request);
  return entry && entry.userId === userId ? entry : null;
}

/** No `sid`, no binding: that provider's logout tokens are honoured by subject, per the spec. */
export function recordSessionBindingFromIdToken(
  request: object | null | undefined,
  userId: number,
  providerId: string,
  idToken: string | null | undefined,
): void {
  // Without the request there is nothing safe to correlate by, so the session goes unbound.
  if (!request || !Number.isFinite(userId) || !idToken) return;
  const raw = isEncryptedSecret(idToken) ? decryptSecret(idToken, "OIDC id_token") : idToken;
  const claims = decodeJwtPayload(raw);
  const sid = claims?.sid;
  if (typeof sid !== "string" || !sid) return;
  recordPendingSessionBinding(request, { userId, providerId, sid });
}

export async function bindSessionToIdpSession(
  request: object | null | undefined,
  userId: number,
  sessionId: number,
): Promise<void> {
  if (!request || !Number.isFinite(userId) || !Number.isFinite(sessionId)) return;
  const entry = consumePendingSessionBinding(request, userId);
  if (!entry) return;

  await db
    .update(sessions)
    .set({ oidcProviderId: entry.providerId, oidcSid: entry.sid })
    .where(eq(sessions.id, sessionId));
}

export type RevocationTarget = {
  providerId: string;
  subject: string | null;
  sessionId: string | null;
};

export type RevocationResult = {
  /** Zero is a success: the user may simply not have been signed in. */
  sessions: number;
  userIds: number[];
};

/**
 * A `sid` wins over the `sub` most providers also send, or session-scoped logout could not be asked
 * for; only a token without one ends every session. Forward-auth sessions outlive CPM's and carry
 * no `sid`, so all of the user's go either way.
 */
export async function revokeSessionsForLogoutToken(
  target: RevocationTarget,
): Promise<RevocationResult> {
  const userIds = new Set<number>();
  let deleted = 0;

  if (target.sessionId) {
    const rows = await db
      .delete(sessions)
      .where(
        and(eq(sessions.oidcProviderId, target.providerId), eq(sessions.oidcSid, target.sessionId)),
      )
      .returning({ userId: sessions.userId });
    deleted += rows.length;
    for (const row of rows) userIds.add(row.userId);
  } else if (target.subject) {
    const owners = await db
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(
        and(eq(accounts.providerId, target.providerId), eq(accounts.accountId, target.subject)),
      );
    const ids = owners.map((row) => row.userId);
    if (ids.length > 0) {
      const rows = await db
        .delete(sessions)
        .where(inArray(sessions.userId, ids))
        .returning({ userId: sessions.userId });
      deleted += rows.length;
      for (const id of ids) userIds.add(id);
    }
  }

  for (const userId of userIds) {
    await deleteUserForwardAuthSessions(userId);
    await logAuditEvent({
      userId,
      action: "oidc_backchannel_logout",
      entityType: "user",
      entityId: userId,
      summary: `Sessions for user ${userId} ended by a back-channel logout from ${target.providerId}`,
      data: { providerId: target.providerId, bySessionId: target.sessionId !== null },
    });
  }

  return { sessions: deleted, userIds: [...userIds] };
}
