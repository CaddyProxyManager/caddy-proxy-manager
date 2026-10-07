/**
 * `backup_runs`: a run is claimed by inserting its `(scheduleId, slot)` row before any work, so of
 * two replicas (or a leader and its successor) reaching the same slot exactly one runs it.
 */
import { and, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import db, { nowIso } from "../db";
import { backupRuns, backupSchedules } from "../db/schema";
import { domainErrorMessage } from "../errors/domain-error";

export const RUN_TRIGGERS = ["schedule", "catch-up", "manual"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];
export type RunStatus = "running" | "succeeded" | "failed";

export type BackupRun = typeof backupRuns.$inferSelect & { scheduleName: string | null };

/** The run's id, or null when another process already holds this slot. */
export async function claimRun(
  scheduleId: number,
  slot: number,
  trigger: RunTrigger,
  replica: string | null = null,
): Promise<number | null> {
  const [row] = await db
    .insert(backupRuns)
    .values({ scheduleId, slot, trigger, status: "running", replica, startedAt: nowIso() })
    .onConflictDoNothing()
    .returning({ id: backupRuns.id });
  return row?.id ?? null;
}

export async function finishRun(
  id: number,
  result:
    | { status: "succeeded"; objectKey: string; bytes: number; durationMs: number }
    | {
        status: "failed";
        error: string;
        errorCode: string | null;
        durationMs: number;
        objectKey?: string;
      },
): Promise<void> {
  await db
    .update(backupRuns)
    .set({ ...result, finishedAt: nowIso() })
    .where(eq(backupRuns.id, id));
}

export async function listRuns(
  options: { scheduleId?: number; limit?: number } = {},
): Promise<BackupRun[]> {
  const rows = await db
    .select({ run: backupRuns, scheduleName: backupSchedules.name })
    .from(backupRuns)
    .leftJoin(backupSchedules, eq(backupSchedules.id, backupRuns.scheduleId))
    .where(
      options.scheduleId === undefined ? undefined : eq(backupRuns.scheduleId, options.scheduleId),
    )
    .orderBy(desc(backupRuns.startedAt), desc(backupRuns.id))
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 500));
  return rows.map(({ run, scheduleName }) => ({ ...run, scheduleName }));
}

export async function getRun(id: number): Promise<BackupRun | null> {
  const [row] = await db
    .select({ run: backupRuns, scheduleName: backupSchedules.name })
    .from(backupRuns)
    .leftJoin(backupSchedules, eq(backupSchedules.id, backupRuns.scheduleId))
    .where(eq(backupRuns.id, id));
  return row ? { ...row.run, scheduleName: row.scheduleName } : null;
}

/** Per schedule, the newest slot the scheduler ran (manual runs aside) and the newest run of any kind. */
export async function latestRuns(
  scheduleIds: readonly number[],
): Promise<
  Map<number, { scheduledSlot: number | null; last: typeof backupRuns.$inferSelect | null }>
> {
  const result = new Map<
    number,
    { scheduledSlot: number | null; last: typeof backupRuns.$inferSelect | null }
  >();
  if (scheduleIds.length === 0) return result;
  const slots = await db
    .select({ scheduleId: backupRuns.scheduleId, slot: sql<number>`max(${backupRuns.slot})` })
    .from(backupRuns)
    .where(and(inArray(backupRuns.scheduleId, [...scheduleIds]), ne(backupRuns.trigger, "manual")))
    .groupBy(backupRuns.scheduleId);
  for (const id of scheduleIds) result.set(id, { scheduledSlot: null, last: null });
  for (const row of slots) {
    const entry = result.get(row.scheduleId);
    if (entry) entry.scheduledSlot = row.slot === null ? null : Number(row.slot);
  }
  for (const id of scheduleIds) {
    const [last] = await db
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.scheduleId, id))
      .orderBy(desc(backupRuns.startedAt), desc(backupRuns.id))
      .limit(1);
    const entry = result.get(id);
    if (entry) entry.last = last ?? null;
  }
  return result;
}

/** A run longer than this was cut short by a crash: nothing a backup does takes hours. */
export const STALE_RUN_MS = 6 * 60 * 60_000;

/** Marks runs a dead process left `running`, so they read as failed rather than forever busy. */
export async function failStaleRuns(now = Date.now()): Promise<number> {
  const cutoff = new Date(now - STALE_RUN_MS).toISOString();
  const rows = await db
    .update(backupRuns)
    .set({
      status: "failed",
      error: domainErrorMessage("backupRunInterrupted"),
      errorCode: JSON.stringify({ code: "backupRunInterrupted", params: {} }),
      finishedAt: nowIso(),
    })
    .where(and(eq(backupRuns.status, "running"), lt(backupRuns.startedAt, cutoff)))
    .returning({ id: backupRuns.id });
  return rows.length;
}
