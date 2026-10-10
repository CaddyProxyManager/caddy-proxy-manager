/**
 * Runs backup schedules on the leader: one in-process `Bun.cron` per enabled schedule, re-created
 * whenever a schedule changes. Bun never replays a fire missed while no leader ran, so a leader
 * taking over runs the latest slot each schedule owes. Every run claims its slot first.
 */
import { onAnnouncement, replicaId } from "../cluster";
import { domainError, storedErrorCode } from "../errors/domain-error";
import { raiseProblem, resolveProblem } from "../notifications";
import { type CronJob, cronHandler, latestSlot, missedSlot, scheduleJobs } from "../cron";

export { type CronFactory, cronHandler, scheduleJobs } from "../cron";
import { getDestination, openStore } from "./destinations";
import { applyRetention, backupObjectName } from "./retention";
import {
  type BackupSchedule,
  listEnabledSchedules,
  requireSchedule,
  SCHEDULES_CHANGED,
} from "./schedules";
import { createBackup } from "./service";
import { claimRun, failStaleRuns, finishRun, getRun, latestRuns, type RunTrigger } from "./runs";

const PROBLEM_PREFIX = "backup:";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Makes, uploads and prunes one backup for a claimed slot. Null when another process holds the
 * slot. Throws nothing a run causes: a failure is recorded on the row and raised as a notice.
 */
export async function runBackupSchedule(
  scheduleId: number,
  slot: number,
  trigger: RunTrigger,
  now: () => number = Date.now,
): Promise<number | null> {
  const runId = await claimRun(scheduleId, slot, trigger, replicaId());
  if (runId === null) return null;
  const started = now();
  let schedule: BackupSchedule | null = null;
  let objectKey: string | undefined;
  try {
    schedule = await requireSchedule(scheduleId);
    const destination = await getDestination(schedule.destinationId);
    if (!destination) throw domainError("backupDestinationMissing");
    const file = await createBackup(schedule.passphrase, {
      auditLog: schedule.includeAuditLog,
      settingsHistory: schedule.includeSettingsHistory,
    });
    const prefix = `${destination.prefix}${schedule.prefix}`;
    objectKey = `${prefix}${backupObjectName(slot, trigger === "manual")}`;
    const store = openStore(destination);
    await store.write(objectKey, file);
    try {
      await applyRetention(
        store,
        prefix,
        { keepLast: schedule.keepLast, keepDays: schedule.keepDays },
        now(),
      );
    } catch (error) {
      // The backup itself is safe; the next run prunes again.
      console.warn(`[backup] Pruning old backups for "${schedule.name}" failed:`, error);
    }
    await finishRun(runId, {
      status: "succeeded",
      objectKey,
      bytes: file.length,
      durationMs: now() - started,
    });
    const name = schedule.name;
    await resolveProblem(`${PROBLEM_PREFIX}${scheduleId}`, (raised) =>
      raised?.kind === "backupFailed" ? { kind: "backupRecovered", schedule: name } : null,
    );
  } catch (error) {
    const code = storedErrorCode(error);
    await finishRun(runId, {
      status: "failed",
      error: errorText(error),
      errorCode: code ? JSON.stringify(code) : null,
      durationMs: now() - started,
      objectKey,
    }).catch((recordError: unknown) => {
      console.error("[backup] Could not record a failed run:", recordError);
    });
    await raiseProblem(`${PROBLEM_PREFIX}${scheduleId}`, {
      kind: "backupFailed",
      schedule: schedule?.name ?? String(scheduleId),
      error: errorText(error),
      errorCode: code,
    });
  }
  return runId;
}

/** "Run now": the run, once finished, or null if the slot was somehow taken. */
export async function runScheduleNow(scheduleId: number) {
  await requireSchedule(scheduleId);
  const runId = await runBackupSchedule(scheduleId, Date.now(), "manual");
  return runId === null ? null : getRun(runId);
}

/** A fire may land a little after its slot; a little before would credit the previous one. */
const FIRE_TOLERANCE_MS = 2_000;

function fire(schedule: BackupSchedule): () => Promise<void> {
  return cronHandler(async () => {
    const slot = latestSlot(schedule.cron, schedule.timeZone, Date.now() + FIRE_TOLERANCE_MS);
    if (slot !== null) await runBackupSchedule(schedule.id, slot, "schedule");
  });
}

/** On taking over: each schedule's latest owed slot, at most one per schedule. */
export async function catchUpSchedules(
  schedules: readonly BackupSchedule[],
  now = Date.now(),
): Promise<number[]> {
  const latest = await latestRuns(schedules.map((schedule) => schedule.id));
  const ran: number[] = [];
  for (const schedule of schedules) {
    const since = Math.max(
      Date.parse(schedule.scheduledSince) || 0,
      latest.get(schedule.id)?.scheduledSlot ?? 0,
    );
    let slot: number | null;
    try {
      slot = missedSlot(schedule, since, now);
    } catch {
      continue;
    }
    if (slot === null) continue;
    await cronHandler(async () => {
      if ((await runBackupSchedule(schedule.id, slot, "catch-up")) !== null) ran.push(schedule.id);
    })();
  }
  return ran;
}

const state = { active: false, generation: 0, jobs: new Map<number, CronJob>() };

function stopJobs(): void {
  for (const job of state.jobs.values()) {
    try {
      job.stop();
    } catch {
      // Already stopped.
    }
  }
  state.jobs = new Map();
}

async function reload(catchUp: boolean): Promise<void> {
  const generation = ++state.generation;
  stopJobs();
  const schedules = await listEnabledSchedules();
  // Stopped, or reloaded again, while this read: the newer call owns the jobs.
  if (!state.active || generation !== state.generation) return;
  state.jobs = scheduleJobs(schedules, fire).jobs;
  if (catchUp) {
    await failStaleRuns();
    await catchUpSchedules(schedules);
  }
}

function reloadQuietly(catchUp: boolean): void {
  void reload(catchUp).catch((error: unknown) => {
    console.error("[backup] Could not load the backup schedules:", error);
  });
}

export function startBackupScheduler(): void {
  state.active = true;
  reloadQuietly(true);
}

export function stopBackupScheduler(): void {
  state.active = false;
  state.generation++;
  stopJobs();
}

onAnnouncement(SCHEDULES_CHANGED, () => {
  if (state.active) reloadQuietly(false);
});
