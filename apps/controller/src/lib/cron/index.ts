/**
 * Cron arithmetic and job plumbing shared by the backup scheduler and the alert digests, all of it
 * through `Bun.cron`, whose `parse` returns the next occurrence strictly after a time. There is no
 * "previous occurrence" call, so a past slot is found by stepping forward from a point before it.
 */

function next(expression: string, after: number, timeZone: string): number | null {
  const at = Bun.cron.parse(expression, new Date(after), { tz: timeZone });
  return at ? at.getTime() : null;
}

/** Whether an expression parses under UTC, and then in `timeZone`; and whether it ever fires. */
export function cronCheck(
  expression: string,
  timeZone: string,
  now = Date.now(),
): "expression" | "timeZone" | "never" | null {
  try {
    next(expression, now, "UTC");
  } catch {
    return "expression";
  }
  let upcoming: number | null;
  try {
    upcoming = next(expression, now, timeZone);
  } catch {
    return "timeZone";
  }
  return upcoming === null ? "never" : null;
}

/** The next run after `now`, or null for an invalid or never-firing expression. */
export function nextRun(expression: string, timeZone: string, now = Date.now()): number | null {
  try {
    return next(expression, now, timeZone);
  } catch {
    return null;
  }
}

/** Widening look-backs: a frequent schedule is found in the first, a yearly one in the last. */
const LOOK_BACK_MS = [
  3_600_000,
  86_400_000,
  32 * 86_400_000,
  366 * 86_400_000,
  5 * 366 * 86_400_000,
];

/** The latest occurrence at or before `at`, or null if there was none within five years. */
export function latestSlot(expression: string, timeZone: string, at: number): number | null {
  for (const window of LOOK_BACK_MS) {
    let slot = nextRun(expression, timeZone, at - window);
    if (slot === null || slot > at) continue;
    for (;;) {
      const following = nextRun(expression, timeZone, slot);
      if (following === null || following > at) return slot;
      slot = following;
    }
  }
  return null;
}

/**
 * The one slot a leader starting at `now` owes: the latest due, if it is newer than `since` (the
 * last run's slot, or when the timing last changed). Older misses are not replayed.
 */
export function missedSlot(
  schedule: { cron: string; timeZone: string },
  since: number,
  now: number,
): number | null {
  const slot = latestSlot(schedule.cron, schedule.timeZone, now);
  return slot !== null && slot > since ? slot : null;
}

/** Both of the last two slots past with no run at all: the schedule has stopped running. */
export function isOverdue(
  schedule: { cron: string; timeZone: string },
  since: number,
  latestRunSlot: number | null,
  now: number,
  graceMs = 15 * 60_000,
): boolean {
  const last = latestSlot(schedule.cron, schedule.timeZone, now - graceMs);
  if (last === null) return false;
  const before = latestSlot(schedule.cron, schedule.timeZone, last - 1);
  if (before === null || before <= since) return false;
  return latestRunSlot === null || latestRunSlot < before;
}

export type CronJob = { stop(): unknown; unref(): unknown };
export type CronFactory = (
  expression: string,
  handler: () => Promise<void>,
  options: { tz: string },
) => CronJob;

const defaultCron: CronFactory = (expression, handler, options) =>
  Bun.cron(expression, handler, options) as unknown as CronJob;

/**
 * What Bun calls on a fire. A rejected handler is an unhandledRejection, which with no listener
 * exits the process; so nothing escapes, and whatever the run couldn't record is logged.
 */
export function cronHandler(
  run: () => Promise<unknown>,
  onError: (error: unknown) => void = (error) =>
    console.error("[cron] A scheduled job failed before it could record why:", error),
): () => Promise<void> {
  return async () => {
    try {
      await run();
    } catch (error) {
      try {
        onError(error);
      } catch {
        // Nothing left to tell.
      }
    }
  };
}

/**
 * One cron job per schedule. Bun throws synchronously on an expression it refuses, so each is
 * created on its own: one bad row must not keep every other schedule from running.
 */
export function scheduleJobs<
  S extends { id: number; name: string; cron: string; timeZone: string },
>(
  schedules: readonly S[],
  handlerFor: (schedule: S) => () => Promise<void>,
  createCron: CronFactory = defaultCron,
  label = "backup",
): { jobs: Map<number, CronJob>; failed: number[] } {
  const jobs = new Map<number, CronJob>();
  const failed: number[] = [];
  for (const schedule of schedules) {
    try {
      const job = createCron(schedule.cron, handlerFor(schedule), { tz: schedule.timeZone });
      job.unref();
      jobs.set(schedule.id, job);
    } catch (error) {
      failed.push(schedule.id);
      console.error(`[${label}] Could not schedule "${schedule.name}":`, error);
    }
  }
  return { jobs, failed };
}
