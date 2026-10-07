/**
 * Daily digests: a time of day in a time zone, and the channels it goes to. Every change is
 * announced, so the leader re-creates its cron jobs; a change of timing moves `scheduledSince`,
 * so catch-up never sends a slot from before it.
 */

import { asc, desc, eq, inArray } from "drizzle-orm";
import { announce } from "../cluster";
import { cronCheck, nextRun } from "../cron";
import { logAuditEvent } from "../audit";
import db, { nowIso } from "../db";
import { alertDigestRuns, alertDigests, notificationChannels } from "../db/schema";
import { domainError } from "../errors/domain-error";
import { jsonArray } from "../notifications/rules";

export const DIGESTS_CHANGED = "alert-digests";

export type DigestInput = {
  name?: string | null;
  /** HH:MM. */
  time?: string | null;
  timeZone?: string | null;
  channelIds?: number[] | null;
  enabled?: boolean | null;
};

export type Digest = Omit<typeof alertDigests.$inferSelect, "channelIds"> & {
  channelIds: number[];
  cron: string;
};

export type DigestRun = Omit<typeof alertDigestRuns.$inferSelect, "results"> & {
  results: { channelId: number; name: string; ok: boolean; error?: string }[];
};

export type DigestView = Digest & { nextRunAt: string | null; lastRun: DigestRun | null };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Five-field cron for the time of day. */
export function digestCron(time: string): string {
  const [, hours = "0", minutes = "0"] = TIME.exec(time) ?? [];
  return `${Number(minutes)} ${Number(hours)} * * *`;
}

function parse(row: typeof alertDigests.$inferSelect): Digest {
  return {
    ...row,
    channelIds: jsonArray(row.channelIds).filter((id): id is number => typeof id === "number"),
    cron: digestCron(row.time),
  };
}

export function parseRun(row: typeof alertDigestRuns.$inferSelect): DigestRun {
  return {
    ...row,
    results: jsonArray(row.results) as DigestRun["results"],
  };
}

export async function listDigests(): Promise<DigestView[]> {
  const rows = await db.select().from(alertDigests).orderBy(asc(alertDigests.name));
  const digests = rows.map(parse);
  const runs =
    digests.length === 0
      ? []
      : await db
          .select()
          .from(alertDigestRuns)
          .where(
            inArray(
              alertDigestRuns.digestId,
              digests.map((digest) => digest.id),
            ),
          )
          .orderBy(desc(alertDigestRuns.id));
  return digests.map((digest) => {
    const last = runs.find((run) => run.digestId === digest.id);
    const next = digest.enabled ? nextRun(digest.cron, digest.timeZone) : null;
    return {
      ...digest,
      nextRunAt: next === null ? null : new Date(next).toISOString(),
      lastRun: last ? parseRun(last) : null,
    };
  });
}

export async function listEnabledDigests(): Promise<Digest[]> {
  const rows = await db.select().from(alertDigests).where(eq(alertDigests.enabled, true));
  return rows.map(parse);
}

export async function getDigest(id: number): Promise<Digest | null> {
  const [row] = await db.select().from(alertDigests).where(eq(alertDigests.id, id));
  return row ? parse(row) : null;
}

export async function requireDigest(id: number): Promise<Digest> {
  const digest = await getDigest(id);
  if (!digest) throw domainError("alertDigestNotFound", {}, { status: 404 });
  return digest;
}

export async function listDigestRuns(digestId: number, limit = 20): Promise<DigestRun[]> {
  const rows = await db
    .select()
    .from(alertDigestRuns)
    .where(eq(alertDigestRuns.digestId, digestId))
    .orderBy(desc(alertDigestRuns.id))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map(parseRun);
}

async function prepare(input: DigestInput, existing: Digest | null) {
  const name = input.name?.trim() ?? existing?.name ?? "";
  if (!name || name.length > 100) throw domainError("alertDigestNameRequired", {}, { status: 400 });
  const time = (input.time ?? existing?.time ?? "").trim();
  if (!TIME.test(time)) throw domainError("alertDigestTimeInvalid", {}, { status: 400 });
  const timeZone = input.timeZone?.trim() || existing?.timeZone || "UTC";
  if (cronCheck(digestCron(time), timeZone) !== null) {
    throw domainError("backupTimeZoneInvalid", {}, { status: 400 });
  }
  const ids = [...new Set(input.channelIds ?? existing?.channelIds ?? [])];
  const channels = await db
    .select({ id: notificationChannels.id, builtin: notificationChannels.builtin })
    .from(notificationChannels);
  // Push carries a line, not a report.
  const usable = channels.filter((channel) => channel.builtin !== "push");
  if (ids.length === 0 || !ids.every((id) => usable.some((channel) => channel.id === id))) {
    throw domainError("alertRuleChannelsInvalid", {}, { status: 400 });
  }
  const enabled = input.enabled ?? existing?.enabled ?? true;
  const timingChanged =
    !existing ||
    existing.time !== time ||
    existing.timeZone !== timeZone ||
    existing.enabled !== enabled;
  return {
    name,
    time,
    timeZone,
    channelIds: JSON.stringify(ids),
    enabled,
    ...(timingChanged && { scheduledSince: nowIso() }),
  };
}

async function assertNameFree(name: string, exceptId: number | null): Promise<void> {
  const [clash] = await db
    .select({ id: alertDigests.id })
    .from(alertDigests)
    .where(eq(alertDigests.name, name));
  if (clash && clash.id !== exceptId) {
    throw domainError("alertDigestNameTaken", { name }, { status: 409 });
  }
}

export async function createDigest(input: DigestInput, userId: number | null): Promise<Digest> {
  const prepared = await prepare(input, null);
  await assertNameFree(prepared.name, null);
  const at = nowIso();
  const [row] = await db
    .insert(alertDigests)
    .values({
      ...prepared,
      scheduledSince: prepared.scheduledSince ?? at,
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  announce(DIGESTS_CHANGED);
  await logAuditEvent({
    userId,
    action: "create",
    entityType: "alert_digest",
    entityId: row.id,
    summary: `Created alert digest ${row.name}`,
  });
  return parse(row);
}

export async function updateDigest(
  id: number,
  input: DigestInput,
  userId: number | null,
): Promise<Digest> {
  const existing = await requireDigest(id);
  const prepared = await prepare(input, existing);
  await assertNameFree(prepared.name, id);
  const [row] = await db
    .update(alertDigests)
    .set({ ...prepared, updatedAt: nowIso() })
    .where(eq(alertDigests.id, id))
    .returning();
  announce(DIGESTS_CHANGED);
  await logAuditEvent({
    userId,
    action: "update",
    entityType: "alert_digest",
    entityId: id,
    summary: `Updated alert digest ${row.name}`,
  });
  return parse(row);
}

export async function deleteDigest(id: number, userId: number | null): Promise<void> {
  const existing = await requireDigest(id);
  await db.delete(alertDigests).where(eq(alertDigests.id, id));
  announce(DIGESTS_CHANGED);
  await logAuditEvent({
    userId,
    action: "delete",
    entityType: "alert_digest",
    entityId: id,
    summary: `Deleted alert digest ${existing.name}`,
  });
}
