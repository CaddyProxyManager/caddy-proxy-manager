"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/src/lib/auth";
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
import { withTranslatedErrors } from "@/src/lib/errors/translated-action";

export type BackupOverview = {
  destinations: BackupDestinationView[];
  schedules: ScheduleListItem[];
  runs: BackupRun[];
};

const PAGE = "/settings/backup";

async function adminId(): Promise<number> {
  return Number((await requireAdmin()).user.id);
}

export async function loadBackupOverviewAction(): Promise<BackupOverview> {
  await requireAdmin();
  const [destinations, schedules, runs] = await Promise.all([
    listDestinations(),
    listSchedulesWithRuns(),
    listRuns({ limit: 20 }),
  ]);
  return { destinations, schedules, runs };
}

export async function saveDestinationAction(
  id: number | null,
  input: BackupDestinationInput,
): Promise<BackupDestinationView> {
  const userId = await adminId();
  return withTranslatedErrors(async () => {
    const saved =
      id === null
        ? await createDestinationAudited(input, userId)
        : await updateDestinationAudited(id, input, userId);
    revalidatePath(PAGE);
    return saved;
  });
}

export async function deleteDestinationAction(id: number): Promise<void> {
  const userId = await adminId();
  await withTranslatedErrors(async () => {
    await deleteDestinationAudited(id, userId);
    revalidatePath(PAGE);
  });
}

/** The form as it stands; with an id, a blank secret is the stored one. Dials what it is given. */
export async function testDestinationAction(
  id: number | null,
  input: BackupDestinationInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  await requireAdmin();
  try {
    await withTranslatedErrors(() => testDestinationInput(id, input));
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function saveScheduleAction(id: number | null, input: BackupScheduleInput) {
  const userId = await adminId();
  return withTranslatedErrors(async () => {
    const saved =
      id === null
        ? await createScheduleAudited(input, userId)
        : await updateScheduleAudited(id, input, userId);
    revalidatePath(PAGE);
    return saved;
  });
}

export async function setScheduleEnabledAction(id: number, enabled: boolean) {
  const userId = await adminId();
  return withTranslatedErrors(() => setScheduleEnabledAudited(id, enabled, userId));
}

export async function deleteScheduleAction(id: number): Promise<void> {
  const userId = await adminId();
  await withTranslatedErrors(async () => {
    await deleteScheduleAudited(id, userId);
    revalidatePath(PAGE);
  });
}

export async function runScheduleNowAction(id: number): Promise<BackupRun | null> {
  const userId = await adminId();
  return withTranslatedErrors(() => runNowAudited(id, userId));
}

export async function listRemoteBackupsAction(destinationId: number): Promise<RemoteBackup[]> {
  await requireAdmin();
  return withTranslatedErrors(() => listRemoteBackups(destinationId));
}

/** The next run for an expression being typed, or why it can't be saved. Nothing is stored. */
export async function previewTimingAction(
  cron: string,
  timeZone: string,
): Promise<{ nextRunAt: string } | { message: string }> {
  await requireAdmin();
  const problem = cronProblem(cron.trim(), timeZone.trim() || "UTC");
  if (problem) {
    const t = await getTranslations("errors");
    return { message: t(problem) };
  }
  const next = nextRun(cron.trim(), timeZone.trim() || "UTC");
  return next === null ? { message: "" } : { nextRunAt: new Date(next).toISOString() };
}
