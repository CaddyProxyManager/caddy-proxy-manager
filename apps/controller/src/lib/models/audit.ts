import db, { toIso, nowIso } from "../db";
import { auditEvents } from "../db/schema";
import { and, asc, desc, eq, gte, isNull, like, or, count, sql } from "drizzle-orm";

export type AuditEvent = {
  id: number;
  userId: number | null;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string | null;
  createdAt: string;
};

function escapeLikePattern(input: string): string {
  return input.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

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
    const escaped = escapeLikePattern(search);
    clauses.push(
      or(
        like(auditEvents.summary, `%${escaped}%`),
        like(auditEvents.action, `%${escaped}%`),
        like(auditEvents.entityType, `%${escaped}%`),
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

export async function countAuditEvents(filter?: string | AuditEventFilter): Promise<number> {
  const [row] = await db.select({ value: count() }).from(auditEvents).where(auditWhere(filter));
  return row?.value ?? 0;
}

export async function auditFilterOptions(): Promise<{ entityTypes: string[]; actions: string[] }> {
  const [entityTypes, actions] = await Promise.all([
    db
      .selectDistinct({ value: auditEvents.entityType })
      .from(auditEvents)
      .orderBy(asc(auditEvents.entityType)),
    db
      .selectDistinct({ value: auditEvents.action })
      .from(auditEvents)
      .orderBy(asc(auditEvents.action)),
  ]);
  return {
    entityTypes: entityTypes.map((row) => row.value),
    actions: actions.map((row) => row.value),
  };
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
  await db.insert(auditEvents).values({
    userId: data.userId,
    action: data.action,
    entityType: data.entityType,
    entityId: data.entityId ?? null,
    summary: data.summary ?? null,
    data: data.data ?? null,
    createdAt: nowIso(),
  });
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
