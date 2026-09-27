/**
 * "View as" previews a role and groups, not a user, since grants attach to those. It lives on the
 * admin's own session: actions are still done and audited as them, and it can only narrow access.
 */

import { eq, inArray } from "drizzle-orm";
import db from "./db";
import { groups, sessions } from "./db/schema";
import { domainError } from "./domain-error";

export const VIEW_AS_ROLES = ["operator", "user", "viewer"] as const;
export type ViewAsRole = (typeof VIEW_AS_ROLES)[number];
/** Long enough to click around, short enough that a forgotten one doesn't linger. */
export const VIEW_AS_DURATION_MS = 60 * 60 * 1000;

export type ViewAs = { role: ViewAsRole; groupIds: number[]; expiresAt: string };

function isViewAsRole(value: unknown): value is ViewAsRole {
  return (VIEW_AS_ROLES as readonly unknown[]).includes(value);
}

/**
 * The live view on a session row, or null. Checked against the account's real role as well, so a
 * view left on a session whose owner has since been demoted grants nothing.
 */
export function readViewAs(
  row: { viewAsRole?: unknown; viewAsGroupIds?: unknown; viewAsExpiresAt?: unknown } | undefined,
  realRole: string,
  now = Date.now(),
): ViewAs | null {
  if (!row || realRole !== "admin" || !isViewAsRole(row.viewAsRole)) return null;
  const expiresAt = typeof row.viewAsExpiresAt === "string" ? row.viewAsExpiresAt : null;
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now) {
    return null;
  }
  let groupIds: number[] = [];
  try {
    const parsed = JSON.parse(typeof row.viewAsGroupIds === "string" ? row.viewAsGroupIds : "[]");
    if (Array.isArray(parsed)) groupIds = parsed.filter((id) => Number.isInteger(id) && id > 0);
  } catch {
    // Unreadable ids narrow to no groups, which is the safe direction.
  }
  return { role: row.viewAsRole, groupIds, expiresAt };
}

/** Narrows the session. The caller has already checked it belongs to a real administrator. */
export async function startViewAs(
  sessionId: number,
  role: unknown,
  groupIds: unknown,
  now = Date.now(),
): Promise<ViewAs> {
  if (!isViewAsRole(role)) throw domainError("viewAsRoleInvalid");
  const requested = Array.isArray(groupIds)
    ? [...new Set(groupIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
    : [];
  // Only groups that exist, so a stale id can't silently mean something later.
  const known = requested.length
    ? (await db.select({ id: groups.id }).from(groups).where(inArray(groups.id, requested))).map(
        (row) => row.id,
      )
    : [];
  if (known.length !== requested.length) throw domainError("viewAsGroupMissing");

  const view: ViewAs = {
    role,
    groupIds: known,
    expiresAt: new Date(now + VIEW_AS_DURATION_MS).toISOString(),
  };
  await db
    .update(sessions)
    .set({
      viewAsRole: view.role,
      viewAsGroupIds: JSON.stringify(view.groupIds),
      viewAsExpiresAt: view.expiresAt,
    })
    .where(eq(sessions.id, sessionId));
  return view;
}

export async function stopViewAs(sessionId: number): Promise<void> {
  await db
    .update(sessions)
    .set({ viewAsRole: null, viewAsGroupIds: null, viewAsExpiresAt: null })
    .where(eq(sessions.id, sessionId));
}
