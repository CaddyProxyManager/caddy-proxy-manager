/**
 * Drops audit events past `audit_log_keep_days`. The cutoff is a UTC midnight, so however often a
 * pass runs (each new leader runs one), only the first of a day removes anything or records it.
 * A sink still behind the cutoff is sent a gap record and alerted on by lib/audit-stream.
 */

import { nowIso } from "../db";
import { pruneAuditEvents } from "./chain";
import { auditLogKeepDays } from "../settings/registry";
import { resolveSetting } from "../settings/resolve";

const DAY_MS = 86_400_000;
const FIRST_WAKE_MS = 5 * 60_000;
const WAKE_MS = 6 * 60 * 60_000;

/** Null while retention is off; otherwise how many events went and where the cut was. */
export async function runAuditRetention(
  now = Date.now(),
): Promise<{ deleted: number; cutoff: string } | null> {
  const { value: days } = await resolveSetting(auditLogKeepDays);
  if (days <= 0) return null;
  const cutoff = new Date(Math.floor(now / DAY_MS) * DAY_MS - days * DAY_MS).toISOString();
  const deleted = await pruneAuditEvents(cutoff, (count) =>
    count === 0
      ? null
      : {
          userId: null,
          action: "audit_pruned",
          entityType: "audit_log",
          entityId: null,
          summary: `Removed audit events older than ${cutoff} (${count})`,
          data: JSON.stringify({ deleted: count, cutoff, keepDays: days }),
          createdAt: nowIso(),
        },
  );
  return { deleted, cutoff };
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Idempotent. Wakes a few times a day so a leader that took over late still prunes on time. */
export function startAuditRetention(): void {
  if (timer) return;
  const wake = () => {
    void runAuditRetention().catch((error: unknown) => {
      console.error("[audit-retention] pass failed:", error);
    });
  };
  timer = setTimeout(() => {
    wake();
    timer = setInterval(wake, WAKE_MS);
    timer.unref();
  }, FIRST_WAKE_MS);
  timer.unref();
}

/** On losing the lead; clearTimeout takes either handle. */
export function stopAuditRetention(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
