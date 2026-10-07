"use server";

import { requireCan } from "@/src/lib/users/permissions";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { cronProblem, nextRun } from "@/src/lib/backup/cron";
import type { BackupDestinationInput, BackupDestinationView } from "@/src/lib/backup/destinations";
import {
  createDestinationAudited,
  createScheduleAudited,
  deleteDestinationAudited,
  deleteScheduleAudited,
  listDestinations,
  listRemoteBackups,
  listRuns,
  listSchedulesWithRuns,
  type RemoteBackup,
  runNowAudited,
  type ScheduleListItem,
  setScheduleEnabledAudited,
  testDestinationInput,
  updateDestinationAudited,
  updateScheduleAudited,
} from "@/src/lib/backup/manage";
import type { BackupRun } from "@/src/lib/backup/runs";
import type { BackupScheduleInput } from "@/src/lib/backup/schedules";
import type { ActionResult } from "@/src/lib/errors/action-result";
import { runAction } from "@/src/lib/errors/run-action";

export type BackupOverview = {
  destinations: BackupDestinationView[];
  schedules: ScheduleListItem[];
  runs: BackupRun[];
};

const PAGE = "/settings/backup";

async function adminId(): Promise<number> {
  return Number((await requireCan("backups:write")).user.id);
}

export async function loadBackupOverviewAction(): Promise<ActionResult<BackupOverview>> {
  return runAction(async () => {
    await requireCan("backups:read");
    const [destinations, schedules, runs] = await Promise.all([
      listDestinations(),
      listSchedulesWithRuns(),
      listRuns({ limit: 20 }),
    ]);
    return { destinations, schedules, runs };
  });
}

export async function saveDestinationAction(
  id: number | null,
  input: BackupDestinationInput,
): Promise<ActionResult<BackupDestinationView>> {
  return runAction(async () => {
    const userId = await adminId();
    const saved =
      id === null
        ? await createDestinationAudited(input, userId)
        : await updateDestinationAudited(id, input, userId);
    revalidatePath(PAGE);
    return saved;
  });
}

export async function deleteDestinationAction(id: number): Promise<ActionResult> {
  return runAction(async () => {
    const userId = await adminId();
    await deleteDestinationAudited(id, userId);
    revalidatePath(PAGE);
  });
}

/** The form as it stands; with an id, a blank secret is the stored one. Dials what it is given. */
export async function testDestinationAction(
  id: number | null,
  input: BackupDestinationInput,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireCan("backups:write");
    await testDestinationInput(id, input);
  });
}

export async function saveScheduleAction(id: number | null, input: BackupScheduleInput) {
  return runAction(async () => {
    const userId = await adminId();
    const saved =
      id === null
        ? await createScheduleAudited(input, userId)
        : await updateScheduleAudited(id, input, userId);
    revalidatePath(PAGE);
    return saved;
  });
}

export async function setScheduleEnabledAction(id: number, enabled: boolean) {
  return runAction(async () => setScheduleEnabledAudited(id, enabled, await adminId()));
}

export async function deleteScheduleAction(id: number): Promise<ActionResult> {
  return runAction(async () => {
    const userId = await adminId();
    await deleteScheduleAudited(id, userId);
    revalidatePath(PAGE);
  });
}

export async function runScheduleNowAction(id: number): Promise<ActionResult<BackupRun | null>> {
  return runAction(async () => runNowAudited(id, await adminId()));
}

export async function listRemoteBackupsAction(
  destinationId: number,
): Promise<ActionResult<RemoteBackup[]>> {
  return runAction(async () => {
    await requireCan("backups:read");
    return listRemoteBackups(destinationId);
  });
}

/** The next run for an expression being typed, or why it can't be saved. Nothing is stored. */
export async function previewTimingAction(
  cron: string,
  timeZone: string,
): Promise<ActionResult<{ nextRunAt: string } | { message: string }>> {
  return runAction(async () => {
    await requireCan("backups:read");
    const problem = cronProblem(cron.trim(), timeZone.trim() || "UTC");
    if (problem) {
      const t = await getTranslations("errors");
      return { message: t(problem) };
    }
    const next = nextRun(cron.trim(), timeZone.trim() || "UTC");
    return next === null ? { message: "" } : { nextRunAt: new Date(next).toISOString() };
  });
}
