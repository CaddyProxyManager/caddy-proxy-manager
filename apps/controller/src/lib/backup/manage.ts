/**
 * Destinations, schedules and runs as the dashboard and GraphQL change them: each change audited
 * once here, so the two callers cannot disagree. Secrets never leave in a view.
 */
import { logAuditEvent } from "../audit";
import { nextRun } from "./cron";
import {
  type BackupDestinationInput,
  createDestination,
  deleteDestination,
  getDestination,
  listDestinations,
  openStore,
  previewDestination,
  testDestination,
  toDestinationView,
  updateDestination,
} from "./destinations";
import { isScheduleBackup } from "./retention";
import { latestRuns, listRuns } from "./runs";
import { runScheduleNow } from "./runner";
import {
  type BackupSchedule,
  type BackupScheduleInput,
  createSchedule,
  deleteSchedule,
  listSchedules,
  setScheduleEnabled,
  updateSchedule,
} from "./schedules";
import { domainError } from "../errors/domain-error";
import { describeBackup } from "./service";

function audit(
  userId: number | null,
  action: string,
  entityType: string,
  summary: string,
  id: number,
) {
  return logAuditEvent({ userId, action, entityType, entityId: id, summary });
}

export { listDestinations };

export async function createDestinationAudited(
  input: BackupDestinationInput,
  userId: number | null,
) {
  const destination = await createDestination(input);
  await audit(
    userId,
    "create",
    "backup_destination",
    `Created backup destination ${destination.name}`,
    destination.id,
  );
  return toDestinationView(destination);
}

export async function updateDestinationAudited(
  id: number,
  input: BackupDestinationInput,
  userId: number | null,
) {
  const destination = await updateDestination(id, input);
  await audit(
    userId,
    "update",
    "backup_destination",
    `Updated backup destination ${destination.name}`,
    id,
  );
  return toDestinationView(destination);
}

export async function deleteDestinationAudited(id: number, userId: number | null) {
  const destination = await deleteDestination(id);
  await audit(
    userId,
    "delete",
    "backup_destination",
    `Deleted backup destination ${destination.name}`,
    id,
  );
}

/** A saved destination by id, or the unsaved form when `input` is given. */
export async function testDestinationInput(
  id: number | null,
  input: BackupDestinationInput | null,
) {
  const destination = input
    ? await previewDestination(input, id)
    : id !== null
      ? await getDestination(id)
      : null;
  if (!destination) throw domainError("backupDestinationNotFound", {}, { status: 404 });
  await testDestination(destination);
}

export type ScheduleListItem = Awaited<ReturnType<typeof listSchedules>>[number] & {
  nextRunAt: string | null;
  lastRun: Awaited<ReturnType<typeof listRuns>>[number] | null;
};

export async function listSchedulesWithRuns(now = Date.now()): Promise<ScheduleListItem[]> {
  const schedules = await listSchedules();
  const latest = await latestRuns(schedules.map((schedule) => schedule.id));
  return schedules.map((schedule) => {
    const next = schedule.enabled ? nextRun(schedule.cron, schedule.timeZone, now) : null;
    const last = latest.get(schedule.id)?.last ?? null;
    return {
      ...schedule,
      nextRunAt: next === null ? null : new Date(next).toISOString(),
      lastRun: last ? { ...last, scheduleName: schedule.name } : null,
    };
  });
}

function scheduleView(schedule: BackupSchedule) {
  const { passphrase: _, ...rest } = schedule;
  return rest;
}

export async function createScheduleAudited(input: BackupScheduleInput, userId: number | null) {
  const schedule = await createSchedule(input);
  await audit(
    userId,
    "create",
    "backup_schedule",
    `Created backup schedule ${schedule.name}`,
    schedule.id,
  );
  return scheduleView(schedule);
}

export async function updateScheduleAudited(
  id: number,
  input: BackupScheduleInput,
  userId: number | null,
) {
  const schedule = await updateSchedule(id, input);
  await audit(userId, "update", "backup_schedule", `Updated backup schedule ${schedule.name}`, id);
  return scheduleView(schedule);
}

export async function setScheduleEnabledAudited(
  id: number,
  enabled: boolean,
  userId: number | null,
) {
  const schedule = await setScheduleEnabled(id, enabled);
  await audit(userId, "update", "backup_schedule", `Updated backup schedule ${schedule.name}`, id);
  return scheduleView(schedule);
}

export async function deleteScheduleAudited(id: number, userId: number | null) {
  const schedule = await deleteSchedule(id);
  await audit(userId, "delete", "backup_schedule", `Deleted backup schedule ${schedule.name}`, id);
}

export async function runNowAudited(scheduleId: number, userId: number | null) {
  const run = await runScheduleNow(scheduleId);
  await logAuditEvent({
    userId,
    action: "backup_run",
    entityType: "backup_schedule",
    entityId: scheduleId,
    summary: `Ran backup schedule ${run?.scheduleName ?? scheduleId} now`,
    data: { runId: run?.id ?? null, status: run?.status ?? null },
  });
  return run;
}

export { listRuns };

/** The most a destination listing shows: restoring reaches for a recent one. */
export const REMOTE_LIST_LIMIT = 100;

export type RemoteBackup = { key: string; size: number; lastModified: string | null };

/** A destination's backups, newest first, whichever schedule wrote them. */
export async function listRemoteBackups(destinationId: number): Promise<RemoteBackup[]> {
  const destination = await getDestination(destinationId);
  if (!destination) throw domainError("backupDestinationNotFound", {}, { status: 404 });
  const objects = await openStore(destination).list(destination.prefix);
  return objects
    .filter((object) => {
      const slash = object.key.lastIndexOf("/");
      return isScheduleBackup(object.key, object.key.slice(0, slash + 1));
    })
    .sort(
      (a, b) =>
        (b.lastModified ?? "").localeCompare(a.lastModified ?? "") || b.key.localeCompare(a.key),
    )
    .slice(0, REMOTE_LIST_LIMIT);
}

/** Enough for any header: a few hundred table counts. */
const HEADER_BYTES = 64 * 1024;

/** A remote backup, read whole for a restore; a key outside the destination's backups is refused. */
export async function readRemoteBackup(
  destinationId: number,
  key: string,
  options: { headerOnly?: boolean } = {},
): Promise<Buffer> {
  const destination = await getDestination(destinationId);
  if (!destination) throw domainError("backupDestinationNotFound", {}, { status: 404 });
  const slash = key.lastIndexOf("/");
  if (!key.startsWith(destination.prefix) || !isScheduleBackup(key, key.slice(0, slash + 1))) {
    throw domainError("backupObjectInvalid", {}, { status: 400 });
  }
  const store = openStore(destination);
  return options.headerOnly ? store.readHead(key, HEADER_BYTES) : store.read(key);
}

export async function describeRemoteBackup(destinationId: number, key: string) {
  return describeBackup(await readRemoteBackup(destinationId, key, { headerOnly: true }));
}
