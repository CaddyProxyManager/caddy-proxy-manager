/**
 * Backup schedules. The passphrase is stored `enc:v1` so a run needs nobody present: whoever holds
 * SESSION_SECRET can already read the database the backup is made from, so this exposes nothing
 * new. Every change is announced, so the leader re-creates its cron jobs.
 */
import { asc, eq } from "drizzle-orm";
import { announce } from "../cluster";
import db, { nowIso } from "../db";
import { backupDestinations, backupSchedules } from "../db/schema";
import { domainError } from "../errors/domain-error";
import { decryptSecret, encryptSecret } from "../secrets";
import { cronProblem } from "./cron";
import { normalizeKeyPrefix } from "./destinations";
import { MIN_PASSPHRASE_LENGTH } from "./format";

/** The announcement the scheduler listens for. */
export const SCHEDULES_CHANGED = "backup-schedules";

export const MAX_KEEP_LAST = 1000;
export const MAX_KEEP_DAYS = 3650;

export type BackupSchedule = Omit<typeof backupSchedules.$inferSelect, "passphrase"> & {
  passphrase: string;
};

export type BackupScheduleView = Omit<BackupSchedule, "passphrase"> & {
  destinationName: string;
};

export type BackupScheduleInput = {
  name: string;
  destinationId: number;
  cron: string;
  timeZone?: string;
  prefix?: string;
  includeAuditLog?: boolean;
  includeSettingsHistory?: boolean;
  keepLast?: number | null;
  keepDays?: number | null;
  /** Blank keeps the stored one. */
  passphrase?: string;
  enabled?: boolean;
};

type Row = typeof backupSchedules.$inferSelect;

function parseRow(row: Row): BackupSchedule {
  return { ...row, passphrase: decryptSecret(row.passphrase, `backup schedule "${row.name}"`) };
}

export async function listSchedules(): Promise<BackupScheduleView[]> {
  const rows = await db
    .select({ schedule: backupSchedules, destinationName: backupDestinations.name })
    .from(backupSchedules)
    .innerJoin(backupDestinations, eq(backupDestinations.id, backupSchedules.destinationId))
    .orderBy(asc(backupSchedules.name));
  return rows.map(({ schedule, destinationName }) => {
    const { passphrase: _, ...rest } = schedule;
    return { ...rest, destinationName };
  });
}

/** With the passphrase, for a run. */
export async function listEnabledSchedules(): Promise<BackupSchedule[]> {
  const rows = await db.select().from(backupSchedules).where(eq(backupSchedules.enabled, true));
  return rows.map(parseRow);
}

export async function getSchedule(id: number): Promise<BackupSchedule | null> {
  const [row] = await db.select().from(backupSchedules).where(eq(backupSchedules.id, id));
  return row ? parseRow(row) : null;
}

export async function requireSchedule(id: number): Promise<BackupSchedule> {
  const schedule = await getSchedule(id);
  if (!schedule) throw domainError("backupScheduleNotFound", {}, { status: 404 });
  return schedule;
}

function retention(value: number | null | undefined, max: number): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw domainError("backupRetentionInvalid", { max }, { status: 400 });
  }
  return value;
}

async function prepare(input: BackupScheduleInput, existing: BackupSchedule | null) {
  const name = input.name?.trim() ?? "";
  if (!name) throw domainError("backupScheduleNameRequired", {}, { status: 400 });
  const [destination] = await db
    .select({ id: backupDestinations.id })
    .from(backupDestinations)
    .where(eq(backupDestinations.id, Number(input.destinationId)));
  if (!destination) throw domainError("backupDestinationNotFound", {}, { status: 404 });
  const cron = input.cron?.trim().replace(/\s+/g, " ") ?? "";
  const timeZone = input.timeZone?.trim() || "UTC";
  const problem = cronProblem(cron, timeZone);
  if (problem) throw domainError(problem, {}, { status: 400 });
  const prefix = normalizeKeyPrefix(input.prefix ?? "");
  if (prefix === null) throw domainError("backupPrefixInvalid", {}, { status: 400 });
  const passphrase = input.passphrase ? input.passphrase : (existing?.passphrase ?? "");
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw domainError("backupPassphraseTooShort", { min: MIN_PASSPHRASE_LENGTH }, { status: 400 });
  }
  const enabled = input.enabled ?? existing?.enabled ?? true;
  const timingChanged =
    !existing ||
    existing.cron !== cron ||
    existing.timeZone !== timeZone ||
    existing.enabled !== enabled;
  return {
    name,
    destinationId: destination.id,
    cron,
    timeZone,
    prefix,
    includeAuditLog: input.includeAuditLog === true,
    includeSettingsHistory: input.includeSettingsHistory === true,
    keepLast: retention(input.keepLast, MAX_KEEP_LAST),
    keepDays: retention(input.keepDays, MAX_KEEP_DAYS),
    passphrase: encryptSecret(passphrase),
    enabled,
    ...(timingChanged && { scheduledSince: nowIso() }),
  };
}

async function assertNameFree(name: string, exceptId: number | null): Promise<void> {
  const [clash] = await db
    .select({ id: backupSchedules.id })
    .from(backupSchedules)
    .where(eq(backupSchedules.name, name));
  if (clash && clash.id !== exceptId) {
    throw domainError("backupScheduleNameTaken", { name }, { status: 409 });
  }
}

export async function createSchedule(input: BackupScheduleInput): Promise<BackupSchedule> {
  const prepared = await prepare(input, null);
  await assertNameFree(prepared.name, null);
  const now = nowIso();
  const [row] = await db
    .insert(backupSchedules)
    .values({
      ...prepared,
      scheduledSince: prepared.scheduledSince ?? now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  announce(SCHEDULES_CHANGED);
  return parseRow(row);
}

export async function updateSchedule(
  id: number,
  input: BackupScheduleInput,
): Promise<BackupSchedule> {
  const existing = await requireSchedule(id);
  const prepared = await prepare(input, existing);
  await assertNameFree(prepared.name, id);
  const [row] = await db
    .update(backupSchedules)
    .set({ ...prepared, updatedAt: nowIso() })
    .where(eq(backupSchedules.id, id))
    .returning();
  announce(SCHEDULES_CHANGED);
  return parseRow(row);
}

export async function setScheduleEnabled(id: number, enabled: boolean): Promise<BackupSchedule> {
  const existing = await requireSchedule(id);
  if (existing.enabled === enabled) return existing;
  const now = nowIso();
  const [row] = await db
    .update(backupSchedules)
    .set({ enabled, scheduledSince: now, updatedAt: now })
    .where(eq(backupSchedules.id, id))
    .returning();
  announce(SCHEDULES_CHANGED);
  return parseRow(row);
}

export async function deleteSchedule(id: number): Promise<BackupSchedule> {
  const existing = await requireSchedule(id);
  await db.delete(backupSchedules).where(eq(backupSchedules.id, id));
  announce(SCHEDULES_CHANGED);
  return existing;
}
