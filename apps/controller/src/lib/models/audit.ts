import db, { toIso, nowIso } from "../db";
import { auditEvents } from "../db/schema";
import { insertAuditRows } from "../audit";
import { type AuditChange, parseAuditChanges, parseAuditRevisionId } from "../audit/changes";
import { and, desc, eq, gte, isNull, or, count, sql } from "drizzle-orm";
import { likeContains } from "../db/like";
import { processMemo } from "../settings/process-memo";
import { AUDIT_FILTER_OPTIONS } from "../audit/filter-options";

export type AuditEvent = {
  id: number;
  userId: number | null;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string | null;
  createdAt: string;
  /** Field-level before and after, when the event recorded them. */
  changes: AuditChange[] | null;
  /** For a host write, the revision it made (lib/host-history). */
  revisionId: number | null;
};

/** A bare string is the free-text search alone, which is all the REST and GraphQL APIs pass. */
export type AuditEventFilter = {
  search?: string;
  /** null is the system actor. */
  userId?: number | null;
  entityType?: string;
  /** With entityType: one row's history. */
  entityId?: number;
  action?: string;
};

function auditWhere(filter?: string | AuditEventFilter) {
  const { search, userId, entityType, entityId, action } =
    typeof filter === "string" ? { search: filter } : (filter ?? {});
  const clauses = [];
  if (search) {
    clauses.push(
      or(
        likeContains(auditEvents.summary, search),
        likeContains(auditEvents.action, search),
        likeContains(auditEvents.entityType, search),
      ),
    );
  }
  if (userId === null) clauses.push(isNull(auditEvents.userId));
  else if (userId !== undefined) clauses.push(eq(auditEvents.userId, userId));
  if (entityType) clauses.push(eq(auditEvents.entityType, entityType));
  if (entityId !== undefined) clauses.push(eq(auditEvents.entityId, entityId));
  if (action) clauses.push(eq(auditEvents.action, action));
  return clauses.length > 0 ? and(...clauses) : undefined;
}

/** Held for a few seconds per filter: every page view counts, and the log only grows. */
const COUNT_TTL_MS = 10_000;

export async function countAuditEvents(filter?: string | AuditEventFilter): Promise<number> {
  const key = `audit-count:${JSON.stringify(filter ?? null)}`;
  return await processMemo(
    key,
    async () => {
      const [row] = await db.select({ value: count() }).from(auditEvents).where(auditWhere(filter));
      return row?.value ?? 0;
    },
    { ttlMs: COUNT_TTL_MS },
  );
}

/**
 * Read from the table once per process, then kept current by every audit insert
 * (`noteAuditFilterValues`), so the page does not scan the whole log twice per view.
 */
export async function auditFilterOptions(): Promise<{ entityTypes: string[]; actions: string[] }> {
  const known = await processMemo(AUDIT_FILTER_OPTIONS, async () => {
    const [entityTypes, actions] = await Promise.all([
      db.selectDistinct({ value: auditEvents.entityType }).from(auditEvents),
      db.selectDistinct({ value: auditEvents.action }).from(auditEvents),
    ]);
    return {
      entityTypes: new Set(entityTypes.map((row) => row.value)),
      actions: new Set(actions.map((row) => row.value)),
    };
  });
  const sorted = (values: Set<string>) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { entityTypes: sorted(known.entityTypes), actions: sorted(known.actions) };
}

export async function listAuditEvents(
  limit = 100,
  offset = 0,
  filter?: string | AuditEventFilter,
): Promise<AuditEvent[]> {
  const where = auditWhere(filter);
  const events = await db
    .select()
    .from(auditEvents)
    .where(where)
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit)
    .offset(offset);

  return events.map((event) => ({
    id: event.id,
    userId: event.userId,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    summary: event.summary,
    createdAt: toIso(event.createdAt)!,
    changes: parseAuditChanges(event.data),
    revisionId: parseAuditRevisionId(event.data),
  }));
}

export async function createAuditEvent(data: {
  userId: number | null;
  action: string;
  entityType: string;
  entityId?: number | null;
  summary?: string | null;
  data?: string | null;
}): Promise<void> {
  await insertAuditRows([
    {
      userId: data.userId,
      action: data.action,
      entityType: data.entityType,
      entityId: data.entityId ?? null,
      summary: data.summary ?? null,
      data: data.data ?? null,
      createdAt: nowIso(),
    },
  ]);
}

export type AuditActivityBucket = {
  /** ISO truncated to the hour, e.g. 2026-09-10T14. */
  hour: string;
  count: number;
};

/**
 * Grouped in SQL on the stored text's fixed-width UTC hour prefix, keeping rows out of the app.
 * Empty hours are absent; the caller knows the strip's width.
 */
export async function auditActivityByHour(sinceIso: string): Promise<AuditActivityBucket[]> {
  const hour = sql<string>`substr(${auditEvents.createdAt}, 1, 13)`;
  const rows = await db
    .select({ hour, count: count() })
    .from(auditEvents)
    .where(gte(auditEvents.createdAt, sinceIso))
    .groupBy(hour);
  return rows.map((row) => ({ hour: row.hour, count: Number(row.count) }));
}

/** Distinct actors and entity types in the same window. */
export async function auditActivitySummary(
  sinceIso: string,
): Promise<{ events: number; actors: number; entityTypes: number }> {
  const [row] = await db
    .select({
      events: count(),
      actors: sql<number>`count(distinct ${auditEvents.userId})`.mapWith(Number),
      entityTypes: sql<number>`count(distinct ${auditEvents.entityType})`.mapWith(Number),
    })
    .from(auditEvents)
    .where(gte(auditEvents.createdAt, sinceIso));
  return {
    events: row?.events ?? 0,
    actors: row?.actors ?? 0,
    entityTypes: row?.entityTypes ?? 0,
  };
}
