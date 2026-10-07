/** Scheduled backups over GraphQL. Admin only, as Settings > Backup is; no secret is ever answered. */
import type { BackupDestinationInput } from "../backup/destinations";
import {
  createDestinationAudited,
  createScheduleAudited,
  deleteDestinationAudited,
  deleteScheduleAudited,
  listDestinations,
  listRuns,
  listSchedulesWithRuns,
  runNowAudited,
  testDestinationInput,
  updateDestinationAudited,
  updateScheduleAudited,
} from "../backup/manage";
import type { BackupRun } from "../backup/runs";
import type { BackupScheduleInput } from "../backup/schedules";
import { type GraphQLContext, requireAdmin } from "./context";

function runForApi(run: BackupRun | null) {
  return run && { ...run, slot: new Date(run.slot).toISOString() };
}

export const backupQueryResolvers = {
  backupDestinations: async (_: unknown, __: unknown, context: GraphQLContext) => {
    await requireAdmin(context);
    return listDestinations();
  },
  backupSchedules: async (_: unknown, __: unknown, context: GraphQLContext) => {
    await requireAdmin(context);
    return (await listSchedulesWithRuns()).map((schedule) => ({
      ...schedule,
      lastRun: runForApi(schedule.lastRun),
    }));
  },
  backupRuns: async (
    _: unknown,
    args: { scheduleId?: number | null; limit?: number | null },
    context: GraphQLContext,
  ) => {
    await requireAdmin(context);
    const runs = await listRuns({
      scheduleId: args.scheduleId ?? undefined,
      limit: args.limit ?? undefined,
    });
    return runs.map(runForApi);
  },
};

export const backupMutationResolvers = {
  createBackupDestination: async (
    _: unknown,
    args: { input: BackupDestinationInput },
    context: GraphQLContext,
  ) => {
    const { userId } = await requireAdmin(context);
    return createDestinationAudited(args.input, userId);
  },
  updateBackupDestination: async (
    _: unknown,
    args: { id: number; input: BackupDestinationInput },
    context: GraphQLContext,
  ) => {
    const { userId } = await requireAdmin(context);
    return updateDestinationAudited(args.id, args.input, userId);
  },
  deleteBackupDestination: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    const { userId } = await requireAdmin(context);
    await deleteDestinationAudited(args.id, userId);
    return true;
  },
  testBackupDestination: async (
    _: unknown,
    args: { id?: number | null; input?: BackupDestinationInput | null },
    context: GraphQLContext,
  ) => {
    await requireAdmin(context);
    await testDestinationInput(args.id ?? null, args.input ?? null);
    return true;
  },
  createBackupSchedule: async (
    _: unknown,
    args: { input: BackupScheduleInput },
    context: GraphQLContext,
  ) => {
    const { userId } = await requireAdmin(context);
    return createScheduleAudited(args.input, userId);
  },
  updateBackupSchedule: async (
    _: unknown,
    args: { id: number; input: BackupScheduleInput },
    context: GraphQLContext,
  ) => {
    const { userId } = await requireAdmin(context);
    return updateScheduleAudited(args.id, args.input, userId);
  },
  deleteBackupSchedule: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    const { userId } = await requireAdmin(context);
    await deleteScheduleAudited(args.id, userId);
    return true;
  },
  runBackupNow: async (_: unknown, args: { scheduleId: number }, context: GraphQLContext) => {
    const { userId } = await requireAdmin(context);
    return runForApi(await runNowAudited(args.scheduleId, userId));
  },
};
