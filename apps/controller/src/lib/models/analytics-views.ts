/**
 * Saved analytics views: a name and the page's query string, per user. Shared ones are listed to
 * everyone who can open analytics, but only their owner changes them.
 */

import { and, asc, count, eq, or } from "drizzle-orm";
import db, { nowIso, toIso } from "../db";
import { logAuditEvent } from "../audit";
import { analyticsViews, users } from "../db/schema";
import { domainError } from "../errors/domain-error";
import { parseExploreState, serializeExploreState } from "../analytics/explore-state";

export const MAX_ANALYTICS_VIEWS_PER_USER = 100;
export const MAX_ANALYTICS_VIEW_NAME = 80;

export type AnalyticsView = {
  id: number;
  name: string;
  /** Sanitised: what the page would itself write for this state. */
  query: string;
  shared: boolean;
  ownerId: number;
  ownerName: string | null;
  /** Whether the reader may rename, update or delete it. */
  own: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AnalyticsViewInput = {
  name?: unknown;
  query?: unknown;
  shared?: unknown;
};

function validName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw domainError("analyticsViewNameRequired", {}, { status: 400 });
  if (name.length > MAX_ANALYTICS_VIEW_NAME) {
    throw domainError(
      "analyticsViewNameTooLong",
      { max: MAX_ANALYTICS_VIEW_NAME },
      { status: 400 },
    );
  }
  return name;
}

/** Re-parsed, so a crafted query string is stored as the page would have written it. */
export function normalizeViewQuery(value: unknown): string {
  const raw = typeof value === "string" ? value.replace(/^\?/, "") : "";
  return serializeExploreState(parseExploreState(new URLSearchParams(raw))).toString();
}

type Row = typeof analyticsViews.$inferSelect & { ownerName?: string | null };

function toView(row: Row, viewerId: number): AnalyticsView {
  return {
    id: row.id,
    name: row.name,
    query: normalizeViewQuery(row.query),
    shared: Boolean(row.shared),
    ownerId: row.userId,
    ownerName: row.ownerName ?? null,
    own: row.userId === viewerId,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

/** The reader's own views and everyone's shared ones, by name. */
export async function listAnalyticsViews(viewerId: number): Promise<AnalyticsView[]> {
  const rows = await db
    .select({
      id: analyticsViews.id,
      userId: analyticsViews.userId,
      name: analyticsViews.name,
      query: analyticsViews.query,
      shared: analyticsViews.shared,
      createdAt: analyticsViews.createdAt,
      updatedAt: analyticsViews.updatedAt,
      ownerName: users.name,
    })
    .from(analyticsViews)
    .leftJoin(users, eq(users.id, analyticsViews.userId))
    .where(or(eq(analyticsViews.userId, viewerId), eq(analyticsViews.shared, true)))
    .orderBy(asc(analyticsViews.name), asc(analyticsViews.id));
  return rows.map((row) => toView(row, viewerId));
}

async function ownedView(viewerId: number, id: number): Promise<Row> {
  const [row] = await db
    .select()
    .from(analyticsViews)
    .where(and(eq(analyticsViews.id, id), eq(analyticsViews.userId, viewerId)));
  // Someone else's view, shared or not, reads as missing: nobody edits another's view.
  if (!row) throw domainError("analyticsViewNotFound", {}, { status: 404 });
  return row;
}

export async function createAnalyticsView(
  viewerId: number,
  input: AnalyticsViewInput,
): Promise<AnalyticsView> {
  const name = validName(input.name);
  const query = normalizeViewQuery(input.query);
  const [{ total }] = await db
    .select({ total: count() })
    .from(analyticsViews)
    .where(eq(analyticsViews.userId, viewerId));
  if (Number(total) >= MAX_ANALYTICS_VIEWS_PER_USER) {
    throw domainError("analyticsViewLimit", { max: MAX_ANALYTICS_VIEWS_PER_USER }, { status: 400 });
  }
  const now = nowIso();
  const [row] = await db
    .insert(analyticsViews)
    .values({
      userId: viewerId,
      name,
      query,
      shared: input.shared === true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await logAuditEvent({
    userId: viewerId,
    action: "create",
    entityType: "analytics_view",
    entityId: row!.id,
    summary: `Created analytics view ${name}`,
    data: { query, shared: row!.shared },
  });
  return toView(row!, viewerId);
}

/** Rename, re-save the state, or share; whatever the input carries. */
export async function updateAnalyticsView(
  viewerId: number,
  id: number,
  input: AnalyticsViewInput,
): Promise<AnalyticsView> {
  const current = await ownedView(viewerId, id);
  const patch: Partial<typeof analyticsViews.$inferInsert> = { updatedAt: nowIso() };
  if (input.name !== undefined) patch.name = validName(input.name);
  if (input.query !== undefined) patch.query = normalizeViewQuery(input.query);
  if (input.shared !== undefined) patch.shared = input.shared === true;
  const [row] = await db
    .update(analyticsViews)
    .set(patch)
    .where(eq(analyticsViews.id, id))
    .returning();
  const renamed = patch.name !== undefined && patch.name !== current.name;
  await logAuditEvent({
    userId: viewerId,
    action: "update",
    entityType: "analytics_view",
    entityId: id,
    summary: renamed
      ? `Renamed analytics view ${current.name} to ${patch.name}`
      : `Updated analytics view ${row!.name}`,
    data: { query: row!.query, shared: row!.shared },
  });
  return toView(row!, viewerId);
}

export async function deleteAnalyticsView(viewerId: number, id: number): Promise<void> {
  const current = await ownedView(viewerId, id);
  await db.delete(analyticsViews).where(eq(analyticsViews.id, id));
  await logAuditEvent({
    userId: viewerId,
    action: "delete",
    entityType: "analytics_view",
    entityId: id,
    summary: `Deleted analytics view ${current.name}`,
  });
}
