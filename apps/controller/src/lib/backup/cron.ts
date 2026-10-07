/** Backup schedules' cron checks, in their own error codes; the arithmetic is in ../cron. */

import { cronCheck } from "../cron";

export type CronProblem = "backupCronInvalid" | "backupTimeZoneInvalid" | "backupCronNeverFires";

/** Why an expression can't be saved, or null. */
export function cronProblem(
  expression: string,
  timeZone: string,
  now = Date.now(),
): CronProblem | null {
  const problem = cronCheck(expression, timeZone, now);
  if (problem === "expression") return "backupCronInvalid";
  if (problem === "timeZone") return "backupTimeZoneInvalid";
  return problem === "never" ? "backupCronNeverFires" : null;
}

export { isOverdue, latestSlot, missedSlot, nextRun } from "../cron";
export { type SchedulePreset, presetExpression, presetOf } from "./presets";
