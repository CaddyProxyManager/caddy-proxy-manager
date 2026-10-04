/**
 * A failed password sign-in against one account: the per-account lock's count, and past the
 * auto-disable threshold the account itself. Never throws into the sign-in, which answers the
 * same 401 either way, so a guesser cannot tell that the account was disabled.
 */

import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { logAuditEvent } from "./audit";
import db from "./db";
import { auditEvents, users } from "./db/schema";
import { DomainError } from "./domain-error";
import {
  accountFailureCount,
  accountLockPolicy,
  type AccountLockPolicy,
  registerAccountFailure,
} from "./rate-limit";

/**
 * `directory`: an LDAP bind refused the password. The directory's entry is only known after a
 * bind succeeds, so such a failure cannot be tied to a CPM user and never disables one.
 */
export type SignInSource = "local" | "directory";

const PORTAL_DOMAIN = "@localhost";

export const AUTO_DISABLE_ACTION = "user_disabled_failed_sign_ins";
/** `cpm-server --enable-user`. */
export const CONSOLE_ENABLE_ACTION = "user_enabled_console";

export type AccountKeyUser = {
  id: number;
  email: string;
  role: string;
  status: string;
};

/**
 * The user an account key names: the email typed on the login page, or a typed username, which
 * `accountKey` turns into `<name>@localhost` (the portal's own reading of it). Sign-in names are
 * kept unique across users (sign-in-names.ts), so two matches mean something is off: none.
 */
export async function findUserByAccountKey(account: string): Promise<AccountKeyUser | null> {
  const key = account.trim().toLowerCase();
  if (!key) return null;
  const conditions = [sql`lower(${users.email}) = ${key}`, sql`lower(${users.username}) = ${key}`];
  if (key.endsWith(PORTAL_DOMAIN)) {
    const name = key.slice(0, -PORTAL_DOMAIN.length);
    if (name) conditions.push(sql`lower(${users.username}) = ${name}`);
  }
  const rows = await db
    .select({ id: users.id, email: users.email, role: users.role, status: users.status })
    .from(users)
    .where(or(...conditions))
    .limit(2);
  return rows.length === 1 ? rows[0] : null;
}

export type AccountFailureOutcome = {
  /** The lock now imposed, in ms. */
  delayMs: number;
  failures: number;
  /** The lock went on with this failure, the first past the free ones. */
  lockEngaged: boolean;
  disabled: AccountKeyUser | null;
  /** Reached the threshold, but it is the last active administrator. */
  keptLastAdmin: AccountKeyUser | null;
  /** Who the lock engaged on, when that is an administrator. */
  lockedAdmin: AccountKeyUser | null;
};

/** Counts a failure, and disables the account once the policy says so. */
export async function recordAccountFailure(
  account: string,
  source: SignInSource,
  now = Date.now(),
  policy?: AccountLockPolicy,
): Promise<AccountFailureOutcome> {
  const resolved = policy ?? (await accountLockPolicy());
  const delayMs = await registerAccountFailure(account, now, resolved);
  const failures = accountFailureCount(account, now);
  const outcome: AccountFailureOutcome = {
    delayMs,
    failures,
    lockEngaged: resolved.enabled && failures === resolved.freeFailures + 1,
    disabled: null,
    keptLastAdmin: null,
    lockedAdmin: null,
  };
  const disableDue =
    source === "local" && resolved.disableAfter !== null && failures >= resolved.disableAfter;
  if (!disableDue && !outcome.lockEngaged) return outcome;

  try {
    const user = await findUserByAccountKey(account);
    if (user?.status !== "active") return outcome;
    if (disableDue) {
      const disabled = await disableForFailedSignIns(user, failures);
      if (disabled) outcome.disabled = user;
      // Once per streak: the count passes the threshold exactly once.
      else if (failures === resolved.disableAfter) outcome.keptLastAdmin = user;
    }
    if (outcome.lockEngaged && !outcome.disabled && user.role === "admin") {
      outcome.lockedAdmin = user;
    }
    await reportOutcome(outcome);
  } catch (error) {
    console.error("[account-lock] could not act on repeated failed sign-ins:", error);
  }
  return outcome;
}

/** An hour's quiet per account: a lock that keeps engaging is one story, not one per streak. */
const REPEAT_QUIET_MS = 60 * 60_000;

async function reportOutcome(outcome: AccountFailureOutcome): Promise<void> {
  if (!outcome.disabled && !outcome.keptLastAdmin && !outcome.lockedAdmin) return;
  // Imported here: the notifications reach the settings, which import the user model.
  const { notify } = await import("./notifications");
  const { failures } = outcome;
  if (outcome.disabled) {
    const { id, email } = outcome.disabled;
    await notify(`account-disabled:${id}`, { kind: "accountDisabled", email, failures });
  }
  if (outcome.keptLastAdmin) {
    const { id, email } = outcome.keptLastAdmin;
    await notify(
      `last-admin-kept:${id}`,
      { kind: "lastAdminKept", email, failures },
      REPEAT_QUIET_MS,
    );
  }
  if (outcome.lockedAdmin) {
    const { id, email } = outcome.lockedAdmin;
    await notify(`admin-locked:${id}`, { kind: "adminLocked", email, failures }, REPEAT_QUIET_MS);
  }
}

/** False when it may not be disabled: the last active administrator, or the demo account. */
async function disableForFailedSignIns(user: AccountKeyUser, failures: number): Promise<boolean> {
  // Imported here: the user model imports rate-limit, which this module sits beside.
  const { updateUserStatus } = await import("./models/user");
  try {
    await updateUserStatus(user.id, "disabled", { by: "failedSignIns", failures });
  } catch (error) {
    if (
      error instanceof DomainError &&
      (error.code === "lastActiveAdmin" || error.code === "demoAdminProtected")
    ) {
      console.warn(
        `[account-lock] ${user.email} reached ${failures} failed sign-ins but is the last active administrator; it stays on the timed lock`,
      );
      return false;
    }
    throw error;
  }
  console.warn(`[account-lock] disabled ${user.email} after ${failures} failed sign-ins`);
  await logAuditEvent({
    userId: null,
    action: AUTO_DISABLE_ACTION,
    entityType: "user",
    entityId: user.id,
    summary: `Disabled user ${user.email} after ${failures} failed sign-ins`,
  });
  return true;
}

/**
 * Of these users, the ones whose latest status change was the auto-disable. Read off the audit
 * log rather than a column: every path that changes a status writes a row there.
 */
export async function disabledByFailedSignIns(userIds: readonly number[]): Promise<Set<number>> {
  const found = new Set<number>();
  if (userIds.length === 0) return found;
  const rows = await db
    .select({ entityId: auditEvents.entityId, action: auditEvents.action })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, "user"),
        inArray(auditEvents.entityId, [...userIds]),
        or(
          eq(auditEvents.action, AUTO_DISABLE_ACTION),
          eq(auditEvents.action, CONSOLE_ENABLE_ACTION),
          and(
            eq(auditEvents.action, "update"),
            like(auditEvents.summary, "Changed user % status to %"),
          ),
        ),
      ),
    )
    .orderBy(desc(auditEvents.id));
  const seen = new Set<number>();
  for (const row of rows) {
    if (row.entityId === null || seen.has(row.entityId)) continue;
    seen.add(row.entityId);
    if (row.action === AUTO_DISABLE_ACTION) found.add(row.entityId);
  }
  return found;
}
