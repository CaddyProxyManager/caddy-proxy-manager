/**
 * Access reviews: a campaign takes a snapshot of who holds what in its scope and asks its
 * reviewers, item by item, whether it should stay. Nothing changes until the campaign is closed
 * (./apply.ts). Running campaigns takes `users:write`; a reviewer needs no capability at all, and
 * sees and decides only the items handed to them.
 */
import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm";
import db, { runInTransaction } from "../db";
import { accessReviewCampaigns, accessReviewItems, users } from "../db/schema";
import { logAuditEvent } from "../audit";
import { diffAuditRecords } from "../audit/changes";
import { domainError } from "../errors/domain-error";
import { type CapabilitySet, holds } from "../roles/capabilities";
import { type Access, can } from "../users/permissions";
import { assignReviewers, checkScope, collectItems } from "./collect";
import {
  CAMPAIGN_NAME_MAX_LENGTH,
  CAMPAIGN_STATUSES,
  DECISIONS,
  type Decision,
  HINTS,
  type Hint,
  ITEM_KINDS,
  type ItemKind,
  MAX_REVIEWERS,
  NOTE_MAX_LENGTH,
  OUTCOMES,
  REVIEW_SCOPES,
  type ReviewCampaign,
  type ReviewCounts,
  type ReviewItem,
  canChange,
} from "./model";

export * from "./model";

export type ReviewActor = { userId: number; capabilities: CapabilitySet };

export type CampaignInput = {
  name: string;
  scope: string;
  scopeRef?: string | null;
  dueOn: string;
  reviewerIds: readonly number[];
};

export type DecisionInput = { decision: string; changeTo?: string | null; note?: string | null };

type CampaignRow = typeof accessReviewCampaigns.$inferSelect;
type ItemRow = typeof accessReviewItems.$inferSelect;

/** Inserting more rows at once than this would pass SQLite's bound-variable limit. */
const INSERT_CHUNK = 400;

export function assertRunsReviews(actor: ReviewActor): void {
  if (!holds(actor.capabilities, "users:write")) {
    throw domainError("accessDenied", {}, { status: 403 });
  }
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function parseHints(stored: string): Hint[] {
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((hint) => oneOf(HINTS, hint) !== null) : [];
  } catch {
    return [];
  }
}

function emptyCounts(): ReviewCounts {
  return { total: 0, decided: 0, keep: 0, revoke: 0, change: 0, applied: 0, failed: 0 };
}

function toCampaign(
  row: CampaignRow,
  counts: ReviewCounts,
  reviewers: { id: number; label: string }[],
): ReviewCampaign {
  return {
    id: row.id,
    name: row.name,
    scope: oneOf(REVIEW_SCOPES, row.scope) ?? "allUsers",
    scopeRef: row.scopeRef,
    dueOn: row.dueOn,
    status: oneOf(CAMPAIGN_STATUSES, row.status) ?? "closed",
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    closedAt: row.closedAt,
    appliedAt: row.appliedAt,
    reviewers,
    counts,
  };
}

export function toItem(row: ItemRow, reviewerLabel: string | null): ReviewItem {
  return {
    id: row.id,
    campaignId: row.campaignId,
    kind: oneOf(ITEM_KINDS, row.kind) ?? "role",
    userId: row.userId,
    groupId: row.groupId,
    tokenId: row.tokenId,
    connectionId: row.connectionId,
    objectKind: row.objectKind,
    objectId: row.objectId,
    subjectLabel: row.subjectLabel,
    targetLabel: row.targetLabel,
    current: row.current,
    hints: parseHints(row.hints),
    scimManaged: row.scimManaged,
    reviewerId: row.reviewerId,
    reviewerLabel,
    decision: oneOf(DECISIONS, row.decision),
    changeTo: row.changeTo,
    note: row.note,
    decidedAt: row.decidedAt,
    outcome: oneOf(OUTCOMES, row.outcome),
    outcomeCode: row.outcomeCode,
  };
}

async function countsFor(ids: readonly number[]): Promise<Map<number, ReviewCounts>> {
  const byCampaign = new Map<number, ReviewCounts>();
  if (ids.length === 0) return byCampaign;
  const rows = await db
    .select({
      campaignId: accessReviewItems.campaignId,
      decision: accessReviewItems.decision,
      outcome: accessReviewItems.outcome,
      value: count(),
    })
    .from(accessReviewItems)
    .where(inArray(accessReviewItems.campaignId, [...ids]))
    .groupBy(accessReviewItems.campaignId, accessReviewItems.decision, accessReviewItems.outcome);
  for (const row of rows) {
    const counts = byCampaign.get(row.campaignId) ?? emptyCounts();
    const value = Number(row.value);
    counts.total += value;
    const decision = oneOf(DECISIONS, row.decision);
    if (decision) {
      counts.decided += value;
      counts[decision] += value;
    }
    if (row.outcome === "applied" || row.outcome === "gone") counts.applied += value;
    if (row.outcome === "failed") counts.failed += value;
    byCampaign.set(row.campaignId, counts);
  }
  return byCampaign;
}

async function reviewersFor(
  ids: readonly number[],
): Promise<Map<number, { id: number; label: string }[]>> {
  const byCampaign = new Map<number, { id: number; label: string }[]>();
  if (ids.length === 0) return byCampaign;
  const rows = await db
    .selectDistinct({
      campaignId: accessReviewItems.campaignId,
      id: users.id,
      email: users.email,
      name: users.name,
    })
    .from(accessReviewItems)
    .innerJoin(users, eq(accessReviewItems.reviewerId, users.id))
    .where(inArray(accessReviewItems.campaignId, [...ids]))
    .orderBy(users.email);
  for (const row of rows) {
    const list = byCampaign.get(row.campaignId) ?? [];
    list.push({ id: row.id, label: row.name || row.email });
    byCampaign.set(row.campaignId, list);
  }
  return byCampaign;
}

async function campaignsFrom(rows: CampaignRow[]): Promise<ReviewCampaign[]> {
  const ids = rows.map((row) => row.id);
  const [counts, reviewers] = await Promise.all([countsFor(ids), reviewersFor(ids)]);
  return rows.map((row) =>
    toCampaign(row, counts.get(row.id) ?? emptyCounts(), reviewers.get(row.id) ?? []),
  );
}

/** Whoever may read users sees every campaign; anyone else, those they review. */
export async function listCampaigns(viewer: Access): Promise<ReviewCampaign[]> {
  if (can(viewer, "users:read")) {
    return campaignsFrom(
      await db.select().from(accessReviewCampaigns).orderBy(desc(accessReviewCampaigns.id)),
    );
  }
  const mine = await db
    .selectDistinct({ id: accessReviewItems.campaignId })
    .from(accessReviewItems)
    .where(eq(accessReviewItems.reviewerId, viewer.userId));
  if (mine.length === 0) return [];
  return campaignsFrom(
    await db
      .select()
      .from(accessReviewCampaigns)
      .where(
        inArray(
          accessReviewCampaigns.id,
          mine.map((row) => row.id),
        ),
      )
      .orderBy(desc(accessReviewCampaigns.id)),
  );
}

async function campaignRow(id: number): Promise<CampaignRow> {
  const [row] = await db
    .select()
    .from(accessReviewCampaigns)
    .where(eq(accessReviewCampaigns.id, id))
    .limit(1);
  if (!row) throw domainError("accessReviewNotFound", {}, { status: 404 });
  return row;
}

export async function loadCampaign(id: number): Promise<ReviewCampaign> {
  const [campaign] = await campaignsFrom([await campaignRow(id)]);
  return campaign;
}

/** Every item, for whoever runs reviews; null for anyone it does not concern. */
export async function getCampaign(
  id: number,
  viewer: Access,
): Promise<{ campaign: ReviewCampaign; items: ReviewItem[] } | null> {
  const [row] = await db
    .select()
    .from(accessReviewCampaigns)
    .where(eq(accessReviewCampaigns.id, id))
    .limit(1);
  if (!row) return null;
  const all = can(viewer, "users:read");
  const rows = await db
    .select({ item: accessReviewItems, email: users.email, name: users.name })
    .from(accessReviewItems)
    .leftJoin(users, eq(accessReviewItems.reviewerId, users.id))
    .where(
      all
        ? eq(accessReviewItems.campaignId, id)
        : and(
            eq(accessReviewItems.campaignId, id),
            eq(accessReviewItems.reviewerId, viewer.userId),
          ),
    )
    .orderBy(asc(accessReviewItems.id));
  if (!all && rows.length === 0) return null;
  const [campaign] = await campaignsFrom([row]);
  return {
    campaign,
    items: rows.map((entry) => toItem(entry.item, entry.name || entry.email || null)),
  };
}

/** What waits on this person: undecided items in open campaigns, and the soonest due. */
export async function pendingReviewsFor(
  userId: number,
): Promise<{ count: number; dueOn: string | null }> {
  const rows = await db
    .select({ dueOn: accessReviewCampaigns.dueOn, value: count() })
    .from(accessReviewItems)
    .innerJoin(accessReviewCampaigns, eq(accessReviewItems.campaignId, accessReviewCampaigns.id))
    .where(
      and(
        eq(accessReviewItems.reviewerId, userId),
        isNull(accessReviewItems.decision),
        eq(accessReviewCampaigns.status, "open"),
      ),
    )
    .groupBy(accessReviewCampaigns.dueOn)
    .orderBy(asc(accessReviewCampaigns.dueOn));
  return {
    count: rows.reduce((sum, row) => sum + Number(row.value), 0),
    dueOn: rows[0]?.dueOn ?? null,
  };
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > CAMPAIGN_NAME_MAX_LENGTH) {
    throw domainError(
      "accessReviewNameInvalid",
      { max: CAMPAIGN_NAME_MAX_LENGTH },
      { status: 400 },
    );
  }
  return name;
}

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** A real calendar day, today or later. */
function cleanDueOn(value: unknown, now: number): string {
  const dueOn = typeof value === "string" ? value.trim() : "";
  const valid =
    /^\d{4}-\d{2}-\d{2}$/.test(dueOn) &&
    new Date(`${dueOn}T00:00:00Z`).toISOString().slice(0, 10) === dueOn;
  if (!valid || dueOn < today(now)) {
    throw domainError("accessReviewDueInvalid", {}, { status: 400 });
  }
  return dueOn;
}

async function activeUserIds(ids: readonly number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...ids]), eq(users.status, "active")));
  return new Set(rows.map((row) => row.id));
}

async function cleanReviewers(values: readonly unknown[]): Promise<number[]> {
  const ids = [...new Set((values ?? []).map(Number))].filter((id) => Number.isInteger(id));
  if (ids.length === 0 || ids.length > MAX_REVIEWERS) {
    throw domainError("accessReviewReviewersInvalid", { max: MAX_REVIEWERS }, { status: 400 });
  }
  const active = await activeUserIds(ids);
  if (active.size !== ids.length) {
    throw domainError("accessReviewReviewersInvalid", { max: MAX_REVIEWERS }, { status: 400 });
  }
  return ids;
}

export async function createCampaign(
  input: CampaignInput,
  actor: ReviewActor,
  now = Date.now(),
): Promise<ReviewCampaign> {
  assertRunsReviews(actor);
  const name = cleanName(input.name);
  const scope = oneOf(REVIEW_SCOPES, input.scope);
  if (!scope) throw domainError("accessReviewScopeInvalid", {}, { status: 400 });
  const scopeRef = await checkScope(scope, input.scopeRef);
  const dueOn = cleanDueOn(input.dueOn, now);
  const reviewerIds = await cleanReviewers(input.reviewerIds);
  const drafts = await collectItems(scope, scopeRef, now);
  if (drafts.length === 0) throw domainError("accessReviewEmpty", {}, { status: 400 });
  const assigned = assignReviewers(drafts, reviewerIds, actor.userId);

  const at = new Date(now).toISOString();
  const [row] = await db
    .insert(accessReviewCampaigns)
    .values({ name, scope, scopeRef, dueOn, createdBy: actor.userId, createdAt: at, updatedAt: at })
    .returning();
  const values = drafts.map((draft, index) => ({
    ...draft,
    hints: JSON.stringify(draft.hints),
    campaignId: row.id,
    reviewerId: assigned[index],
  }));
  try {
    await runInTransaction((tx) => {
      const statements = [];
      for (let start = 0; start < values.length; start += INSERT_CHUNK) {
        statements.push(
          tx.insert(accessReviewItems).values(values.slice(start, start + INSERT_CHUNK)),
        );
      }
      return statements;
    });
  } catch (error) {
    // Its items never landed, so the campaign would ask about nothing.
    await db.delete(accessReviewCampaigns).where(eq(accessReviewCampaigns.id, row.id));
    throw error;
  }
  await logAuditEvent({
    userId: actor.userId,
    action: "create",
    entityType: "access_review",
    entityId: row.id,
    summary: `Created access review ${name}`,
    data: { scope, scopeRef, dueOn, reviewerIds, items: drafts.length },
  });
  return loadCampaign(row.id);
}

async function openRow(id: number): Promise<CampaignRow> {
  const row = await campaignRow(id);
  if (row.status !== "open") throw domainError("accessReviewNotOpen", {}, { status: 409 });
  return row;
}

/** Its name and due date; the scope is what it asked about, so it stays. */
export async function updateCampaign(
  id: number,
  input: { name?: string; dueOn?: string },
  actor: ReviewActor,
  now = Date.now(),
): Promise<ReviewCampaign> {
  assertRunsReviews(actor);
  const row = await openRow(id);
  const name = input.name === undefined ? row.name : cleanName(input.name);
  const dueOn = input.dueOn === undefined ? row.dueOn : cleanDueOn(input.dueOn, now);
  await db
    .update(accessReviewCampaigns)
    .set({ name, dueOn, updatedAt: new Date(now).toISOString() })
    .where(eq(accessReviewCampaigns.id, id));
  await logAuditEvent({
    userId: actor.userId,
    action: "update",
    entityType: "access_review",
    entityId: id,
    summary: `Updated access review ${name}`,
    changes: diffAuditRecords({ name: row.name, dueOn: row.dueOn }, { name, dueOn }),
  });
  return loadCampaign(id);
}

/** Hands items to another reviewer, never to the person they are about. */
export async function reassignItems(
  campaignId: number,
  itemIds: readonly number[],
  reviewerId: number,
  actor: ReviewActor,
): Promise<ReviewCampaign> {
  assertRunsReviews(actor);
  const row = await openRow(campaignId);
  if (!(await activeUserIds([reviewerId])).has(reviewerId)) {
    throw domainError("accessReviewReviewersInvalid", { max: MAX_REVIEWERS }, { status: 400 });
  }
  const ids = [...new Set(itemIds.map(Number))].filter((id) => Number.isInteger(id));
  const items = ids.length
    ? await db
        .select()
        .from(accessReviewItems)
        .where(
          and(eq(accessReviewItems.campaignId, campaignId), inArray(accessReviewItems.id, ids)),
        )
    : [];
  if (items.length !== ids.length || items.length === 0) {
    throw domainError("accessReviewItemNotFound", {}, { status: 404 });
  }
  if (items.some((item) => ownsItem(item, reviewerId))) {
    throw domainError("accessReviewOwnItem", {}, { status: 400 });
  }
  await db.update(accessReviewItems).set({ reviewerId }).where(inArray(accessReviewItems.id, ids));
  await logAuditEvent({
    userId: actor.userId,
    action: "access_review_reassigned",
    entityType: "access_review",
    entityId: campaignId,
    summary: `Reassigned ${ids.length} items of access review ${row.name}`,
    data: { itemIds: ids, reviewerId },
  });
  return loadCampaign(campaignId);
}

export async function deleteCampaign(id: number, actor: ReviewActor): Promise<void> {
  assertRunsReviews(actor);
  const row = await campaignRow(id);
  await db.delete(accessReviewCampaigns).where(eq(accessReviewCampaigns.id, id));
  await logAuditEvent({
    userId: actor.userId,
    action: "delete",
    entityType: "access_review",
    entityId: id,
    summary: `Deleted access review ${row.name}`,
  });
}

/** Nobody reviews their own access, whoever assigned it. */
function ownsItem(item: ItemRow, userId: number): boolean {
  return (
    (item.kind === "role" || item.kind === "membership" || item.kind === "token") &&
    item.userId === userId
  );
}

/**
 * Only by the item's reviewer, while the campaign is open, and changeable until it closes. A
 * revocation the identity provider would undo is refused here, so it is never recorded as done.
 */
export async function decideItem(
  itemId: number,
  input: DecisionInput,
  reviewerId: number,
  now = Date.now(),
): Promise<ReviewItem> {
  const [item] = await db
    .select()
    .from(accessReviewItems)
    .where(eq(accessReviewItems.id, itemId))
    .limit(1);
  // Someone else's item answers as if it did not exist.
  if (!item || item.reviewerId !== reviewerId) {
    throw domainError("accessReviewItemNotFound", {}, { status: 404 });
  }
  const campaign = await openRow(item.campaignId);
  if (ownsItem(item, reviewerId)) throw domainError("accessReviewOwnItem", {}, { status: 400 });
  const decision = oneOf(DECISIONS, input.decision);
  if (!decision) throw domainError("accessReviewDecisionInvalid", {}, { status: 400 });
  const kind = oneOf(ITEM_KINDS, item.kind) as ItemKind;
  const changeTo = await checkChange(kind, item, decision, input.changeTo);
  if (decision === "revoke" && item.scimManaged && (kind === "role" || kind === "membership")) {
    throw domainError("accessReviewScimManaged", {}, { status: 409 });
  }
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : null;
  if (note && note.length > NOTE_MAX_LENGTH) {
    throw domainError("accessReviewNoteTooLong", { max: NOTE_MAX_LENGTH }, { status: 400 });
  }
  const decidedAt = new Date(now).toISOString();
  const [updated] = await db
    .update(accessReviewItems)
    .set({ decision, changeTo, note, decidedBy: reviewerId, decidedAt })
    .where(eq(accessReviewItems.id, itemId))
    .returning();
  await logAuditEvent({
    userId: reviewerId,
    action: "access_review_decision",
    entityType: "access_review",
    entityId: campaign.id,
    summary: `Decided ${decision} for item ${itemId} of access review ${campaign.name}`,
    data: {
      itemId,
      kind,
      subject: item.subjectLabel,
      target: item.targetLabel,
      current: item.current,
      decision,
      changeTo,
      note,
    },
  });
  return toItem(updated, null);
}

async function checkChange(
  kind: ItemKind,
  item: ItemRow,
  decision: Decision,
  value: unknown,
): Promise<string | null> {
  if (decision !== "change") return null;
  if (!canChange(kind)) throw domainError("accessReviewChangeUnavailable", {}, { status: 400 });
  const changeTo = typeof value === "string" ? value.trim() : "";
  if (!changeTo || changeTo === item.current) {
    throw domainError("accessReviewChangeInvalid", {}, { status: 400 });
  }
  if (kind === "grant" && changeTo !== "view" && changeTo !== "manage") {
    throw domainError("accessReviewChangeInvalid", {}, { status: 400 });
  }
  if (kind === "role") {
    const { getRole } = await import("../roles/store");
    if (!(await getRole(changeTo)))
      throw domainError("accessReviewChangeInvalid", {}, { status: 400 });
  }
  return changeTo;
}
