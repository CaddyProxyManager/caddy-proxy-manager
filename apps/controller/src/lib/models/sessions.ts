import { and, eq, inArray, lt } from "drizzle-orm";
import { forgetPushForRevokedSessions } from "./push-subscriptions";
import db from "../db";
import { sessions } from "../db/schema";
import { deleteUserForwardAuthSessions } from "./forward-auth";

/** A management-UI session; forward-auth `_cpm_fa` sessions are tracked separately. */
export interface UserSession {
  id: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/** better-auth deletes an expired session only when its cookie comes back, which many never do. */
export async function pruneExpiredSessions(now = new Date()): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, now.toISOString()));
}

/** Non-expired, newest first. */
export async function listUserSessions(userId: number): Promise<UserSession[]> {
  const now = Date.now();
  const rows = await db
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      updatedAt: sessions.updatedAt,
      expiresAt: sessions.expiresAt,
      ipAddress: sessions.ipAddress,
      userAgent: sessions.userAgent,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId));

  return rows
    .filter((r) => {
      const exp = new Date(r.expiresAt).getTime();
      return Number.isNaN(exp) || exp > now;
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/** Only if it belongs to the user; false when none, so callers can 404. */
export async function revokeUserSession(userId: number, sessionId: number): Promise<boolean> {
  const [existing] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  if (!existing) return false;
  await db.delete(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  // A revoked session's browser must not keep receiving the administrators' notifications.
  await forgetPushForRevokedSessions(userId, { all: false, sessionIds: [sessionId] });
  return true;
}

/** Returns the number revoked. */
export async function revokeOtherUserSessions(
  userId: number,
  exceptSessionId: number | null,
): Promise<number> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  const toRevoke = rows.map((r) => r.id).filter((id) => id !== exceptSessionId);
  if (toRevoke.length > 0) {
    await db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), inArray(sessions.id, toRevoke)));
  }
  // Every browser but this one's, including ones whose session already expired: "sign out
  // everywhere else" and a password change mean exactly that.
  await forgetPushForRevokedSessions(userId, { all: true, keepSessionId: exceptSessionId });
  return toRevoke.length;
}

/** Other dashboard sessions and every forward-auth one; `keepSessionId` null keeps none. */
export async function revokeSessionsAfterPasswordChange(
  userId: number,
  keepSessionId: number | null,
): Promise<void> {
  await revokeOtherUserSessions(userId, keepSessionId);
  await deleteUserForwardAuthSessions(userId);
}
