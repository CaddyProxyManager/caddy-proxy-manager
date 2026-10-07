/**
 * Change approvals. A covered write becomes a change request carrying what it would have written;
 * approvers see its diff and impact, and the last approval it needs applies it as its requester,
 * through the same code a direct write runs (./kinds.ts). Every step is a compare-and-swap on the
 * request's status, so two approvals racing apply it once, and a target that moved since it was
 * submitted invalidates it rather than being overwritten.
 */

import { and, count, desc, eq, gte, inArray, isNull, like, lt, ne, or } from "drizzle-orm";
import { logAuditEvent } from "../audit";
import { type ApprovalStamp, withApprovalStamp } from "../audit/context";
import db, { nowIso } from "../db";
import {
  auditEvents,
  changeRequestDecisions,
  changeRequests,
  hostRevisions,
  users,
} from "../db/schema";
import { DomainError, domainError } from "../errors/domain-error";
import { groupIdsOf, rolesOfGroups } from "../models/group-grants";
import { decryptSecret, encryptSecret } from "../secrets";
import { type Access, accessFor, can } from "../users/permissions";
import {
  type Actor,
  type PayloadOf,
  type ResultOf,
  getApprovalPolicy,
  kindDefinition,
  stateHash,
} from "./kinds";
import {
  type ApprovalPolicy,
  BYPASS_REASON_MAX_LENGTH,
  DECISION_NOTE_MAX_LENGTH,
  policyCovers,
} from "./policy";
import { ChangeSubmitted } from "./submitted";
import {
  type ChangeDecision,
  type ChangeKind,
  type ChangePreview,
  type ChangeRequestView,
  type ChangeStatus,
  isChangeKind,
} from "./types";

export { getApprovalPolicy } from "./kinds";

export type Submitter = {
  userId: number;
  /** Through an API token: the policy's "Apply to API tokens" decides what happens. */
  viaToken?: boolean;
};

export type Change<K extends ChangeKind = ChangeKind> = { kind: K; payload: PayloadOf<K> };

type Route = "direct" | "skipped" | "request";

const ENTITY = "change_request";

async function actorOf(userId: number): Promise<(Actor & { role: string; status: string }) | null> {
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, userId));
  return row
    ? { userId: row.id, name: row.name ?? row.email, role: row.role, status: row.status }
    : null;
}

/** Whether `change` waits, applies, or applies with approval marked as skipped. */
export async function routeOf(
  by: Submitter,
  change: Change,
  policy?: ApprovalPolicy,
): Promise<{ route: Route; policy: ApprovalPolicy; tags: string[] }> {
  const current = policy ?? (await getApprovalPolicy());
  if (!current.enabled) return { route: "direct", policy: current, tags: [] };
  const definition = kindDefinition(change.kind);
  const tags = definition.tags ? await definition.tags(change.payload) : [];
  if (!policyCovers(current, definition.area, tags)) {
    return { route: "direct", policy: current, tags };
  }
  if (by.viaToken && !current.applyToTokens) return { route: "skipped", policy: current, tags };
  return { route: "request", policy: current, tags };
}

/** Whether the change would wait for approval, for an editor to say "Submit" instead of "Save". */
export async function needsApproval(by: Submitter, change: Change): Promise<boolean> {
  return (await routeOf(by, change)).route === "request";
}

/**
 * Applies `change` at once, or submits it and throws `ChangeSubmitted` with the request's id. The
 * entry point has already checked the caller may make it.
 */
export async function submitOrApply<K extends ChangeKind>(
  by: Submitter,
  change: Change<K>,
): Promise<ResultOf<K>> {
  const { route, policy, tags } = await routeOf(by, change);
  const definition = kindDefinition(change.kind);
  // The name only labels a settings revision, and the direct paths that make one pass it themselves.
  const actor = { userId: by.userId, name: null };
  if (route === "direct") {
    return (await definition.apply(change.payload, actor)) as ResultOf<K>;
  }
  if (route === "skipped") {
    return (await withApprovalStamp({ skipped: "apiToken" }, () =>
      definition.apply(change.payload, actor),
    )) as ResultOf<K>;
  }
  throw new ChangeSubmitted(await submitChange(by, change, policy, tags));
}

/** Stores the request; the preview runs every check a save would, so a bad change is refused here. */
export async function submitChange(
  by: Submitter,
  change: Change,
  policy: ApprovalPolicy,
  tags: string[],
): Promise<number> {
  const definition = kindDefinition(change.kind);
  const requester = await actorOf(by.userId);
  if (!requester) throw domainError("changeRequestRequesterGone");
  const preview = await definition.preview(change.payload, requester);
  const [target, state] = await Promise.all([
    definition.target(change.payload),
    definition.state(change.payload),
  ]);
  const [row] = await db
    .insert(changeRequests)
    .values({
      kind: change.kind,
      area: definition.area,
      targetType: target.type,
      targetId: target.id,
      targetName: target.name,
      payload: encryptSecret(JSON.stringify(change.payload ?? null)),
      preview: JSON.stringify(preview),
      baseState: stateHash(state),
      tags: JSON.stringify(tags),
      requiredApprovals: policy.requiredApprovals,
      status: "pending",
      requestedBy: requester.userId,
      requestedByName: requester.name,
      viaToken: by.viaToken === true,
      createdAt: nowIso(),
    })
    .returning({ id: changeRequests.id });
  await logAuditEvent({
    userId: requester.userId,
    action: "change_request_submitted",
    entityType: ENTITY,
    entityId: row.id,
    summary: `Submitted change request #${row.id}`,
    data: { kind: change.kind, target: target.name, viaToken: by.viaToken === true },
  });
  return row.id;
}

// ── Reading ──────────────────────────────────────────────────────────

type Row = typeof changeRequests.$inferSelect;

async function loadRow(id: number): Promise<Row> {
  const [row] = await db.select().from(changeRequests).where(eq(changeRequests.id, id));
  if (!row) throw domainError("changeRequestNotFound", {}, { status: 404 });
  return row;
}

/** Whether `userId` may approve under `policy`: their role, a role their groups carry, or a group. */
export async function isApprover(
  policy: ApprovalPolicy,
  userId: number,
  role: string,
): Promise<boolean> {
  if (policy.approverRoles.includes(role)) return true;
  const groupIds = await groupIdsOf(userId);
  if (groupIds.some((id) => policy.approverGroupIds.includes(id))) return true;
  if (policy.approverRoles.length === 0 || groupIds.length === 0) return false;
  const groupRoles = await rolesOfGroups(groupIds);
  return groupRoles.some((key) => policy.approverRoles.includes(key));
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function decisionsOf(ids: number[]): Promise<Map<number, ChangeDecision[]>> {
  const out = new Map<number, ChangeDecision[]>();
  if (ids.length === 0) return out;
  const rows = await db
    .select()
    .from(changeRequestDecisions)
    .where(inArray(changeRequestDecisions.requestId, ids))
    .orderBy(changeRequestDecisions.id);
  for (const row of rows) {
    const list = out.get(row.requestId) ?? [];
    list.push({
      userId: row.userId,
      userName: row.userName,
      decision: row.decision === "reject" ? "reject" : "approve",
      note: row.note,
      createdAt: row.createdAt,
    });
    out.set(row.requestId, list);
  }
  return out;
}

export type Viewer = { access: Access };

async function viewerStanding(viewer: Viewer, policy: ApprovalPolicy) {
  const { access } = viewer;
  return {
    approver: await isApprover(policy, access.userId, access.role),
    // The audit log already shows every write; whoever reads it may read these too.
    seesAll: can(access, "audit:read"),
    admin: access.role === "admin",
  };
}

function toView(
  row: Row,
  decisions: ChangeDecision[],
  viewer: Viewer,
  standing: { approver: boolean; admin: boolean },
): ChangeRequestView {
  const pending = row.status === "pending";
  const own = row.requestedBy === viewer.access.userId;
  const decided = decisions.some((decision) => decision.userId === viewer.access.userId);
  return {
    id: row.id,
    kind: isChangeKind(row.kind) ? row.kind : "settingsApply",
    area: row.area as ChangeRequestView["area"],
    targetType: row.targetType,
    targetId: row.targetId,
    targetName: row.targetName,
    tags: parseJson<string[]>(row.tags, []),
    status: row.status as ChangeStatus,
    requiredApprovals: row.requiredApprovals,
    approvals: decisions.filter((decision) => decision.decision === "approve").length,
    requestedBy: row.requestedBy,
    requestedByName: row.requestedByName,
    viaToken: row.viaToken,
    bypassedByName: row.bypassedByName,
    bypassReason: row.bypassReason,
    resultCode: row.resultCode,
    error: row.error,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    appliedAt: row.appliedAt,
    decisions,
    preview: parseJson<ChangePreview>(row.preview, { type: "fields", changes: [] }),
    mayDecide: pending && standing.approver && !own && !decided,
    mayWithdraw: pending && own,
    mayBypass: pending && standing.admin,
  };
}

export type ListFilter = { status?: "pending" | "decided"; limit?: number };

/**
 * Pending first, then newest. Approvers and audit readers see every request; anyone else sees
 * only their own. Pending requests whose target moved are invalidated on the way.
 */
export async function listChangeRequests(
  viewer: Viewer,
  filter: ListFilter = {},
): Promise<ChangeRequestView[]> {
  await sweepInvalidated();
  const policy = await getApprovalPolicy();
  const standing = await viewerStanding(viewer, policy);
  const conditions = [];
  if (filter.status === "pending") conditions.push(eq(changeRequests.status, "pending"));
  if (filter.status === "decided") {
    conditions.push(
      inArray(changeRequests.status, [
        "applying",
        "applied",
        "failed",
        "rejected",
        "withdrawn",
        "invalidated",
      ]),
    );
  }
  if (!standing.approver && !standing.seesAll) {
    conditions.push(eq(changeRequests.requestedBy, viewer.access.userId));
  }
  const rows = await db
    .select()
    .from(changeRequests)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(changeRequests.id))
    .limit(Math.min(Math.max(filter.limit ?? 200, 1), 500));
  const decisions = await decisionsOf(rows.map((row) => row.id));
  const views = rows.map((row) => toView(row, decisions.get(row.id) ?? [], viewer, standing));
  return views.sort(
    (a, b) => Number(b.status === "pending") - Number(a.status === "pending") || b.id - a.id,
  );
}

export async function getChangeRequest(
  id: number,
  viewer: Viewer,
): Promise<ChangeRequestView | null> {
  let [row] = await db.select().from(changeRequests).where(eq(changeRequests.id, id));
  if (!row) return null;
  if (row.status === "applying" && (await recoverStalledApplies()) > 0) row = await loadRow(id);
  const policy = await getApprovalPolicy();
  const standing = await viewerStanding(viewer, policy);
  if (!standing.approver && !standing.seesAll && row.requestedBy !== viewer.access.userId) {
    return null;
  }
  const decisions = await decisionsOf([id]);
  return toView(row, decisions.get(id) ?? [], viewer, standing);
}

/** For the nav: requests the viewer could decide now. */
export async function countAwaiting(viewer: Viewer): Promise<number> {
  const policy = await getApprovalPolicy();
  if (!(await isApprover(policy, viewer.access.userId, viewer.access.role))) return 0;
  const pending = await db
    .select({ id: changeRequests.id, requestedBy: changeRequests.requestedBy })
    .from(changeRequests)
    .where(eq(changeRequests.status, "pending"));
  if (pending.length === 0) return 0;
  const decided = await db
    .select({ requestId: changeRequestDecisions.requestId })
    .from(changeRequestDecisions)
    .where(
      and(
        eq(changeRequestDecisions.userId, viewer.access.userId),
        inArray(
          changeRequestDecisions.requestId,
          pending.map((row) => row.id),
        ),
      ),
    );
  const mine = new Set(decided.map((row) => row.requestId));
  return pending.filter((row) => row.requestedBy !== viewer.access.userId && !mine.has(row.id))
    .length;
}

// ── Deciding ─────────────────────────────────────────────────────────

function payloadOf(row: Row): unknown {
  return JSON.parse(decryptSecret(row.payload, `change request ${row.id}`));
}

async function currentState(row: Row): Promise<string | null> {
  if (!isChangeKind(row.kind)) return null;
  try {
    return stateHash(await kindDefinition(row.kind).state(payloadOf(row)));
  } catch {
    // A target the state read cannot find any more has moved as surely as one edited.
    return null;
  }
}

/** Moves a pending request on, if it is still in `from`; false when someone else got there first. */
async function transition(
  id: number,
  from: ChangeStatus[],
  set: Partial<typeof changeRequests.$inferInsert>,
): Promise<boolean> {
  const updated = await db
    .update(changeRequests)
    .set(set)
    .where(and(eq(changeRequests.id, id), inArray(changeRequests.status, from)))
    .returning({ id: changeRequests.id });
  return updated.length > 0;
}

async function invalidate(row: Row): Promise<boolean> {
  const moved = await transition(row.id, ["pending", "applying"], {
    status: "invalidated",
    resultCode: "changeRequestTargetChanged",
    error: domainError("changeRequestTargetChanged").message,
    decidedAt: nowIso(),
  });
  if (moved) {
    await logAuditEvent({
      userId: null,
      action: "change_request_invalidated",
      entityType: ENTITY,
      entityId: row.id,
      summary: `Invalidated change request #${row.id}`,
    });
  }
  return moved;
}

/** Pending requests whose target changed since they were submitted. */
export async function sweepInvalidated(): Promise<number> {
  await recoverStalledApplies();
  const pending = await db
    .select()
    .from(changeRequests)
    .where(eq(changeRequests.status, "pending"));
  let invalidated = 0;
  for (const row of pending) {
    if ((await currentState(row)) !== row.baseState && (await invalidate(row))) invalidated++;
  }
  return invalidated;
}

function cleanNote(note: string | null | undefined, max: number): string | null {
  const text = (note ?? "").trim();
  if (text.length > max) throw domainError("changeRequestNoteTooLong", { max }, { status: 400 });
  return text || null;
}

async function requirePending(id: number): Promise<Row> {
  const row = await loadRow(id);
  if (row.status !== "pending") {
    throw domainError("changeRequestNotPending", {}, { status: 409 });
  }
  return row;
}

async function decider(access: Access) {
  const actor = await actorOf(access.userId);
  if (!actor) throw domainError("changeRequestRequesterGone");
  return actor;
}

async function recordDecision(
  row: Row,
  actor: Actor,
  decision: "approve" | "reject",
  note: string | null,
) {
  try {
    await db.insert(changeRequestDecisions).values({
      requestId: row.id,
      userId: actor.userId,
      userName: actor.name,
      decision,
      note,
      createdAt: nowIso(),
    });
  } catch {
    // The unique index: this approver already decided, possibly a moment ago in another tab.
    throw domainError("changeRequestAlreadyDecided", {}, { status: 409 });
  }
}

async function assertMayDecide(row: Row, access: Access) {
  if (row.requestedBy === access.userId) {
    throw domainError("changeRequestSelfApproval", {}, { status: 403 });
  }
  const policy = await getApprovalPolicy();
  if (!(await isApprover(policy, access.userId, access.role))) {
    throw domainError("changeRequestNotApprover", {}, { status: 403 });
  }
}

export type DecisionResult = { status: ChangeStatus; approvals: number; required: number };

/**
 * Records the approval; the one that brings the count to what the request needs applies it. Two
 * approvers racing both count, both try to claim it, and only one claim succeeds.
 */
export async function approveChange(
  id: number,
  access: Access,
  note?: string | null,
): Promise<DecisionResult> {
  const row = await requirePending(id);
  await assertMayDecide(row, access);
  const actor = await decider(access);
  const text = cleanNote(note, DECISION_NOTE_MAX_LENGTH);
  if ((await currentState(row)) !== row.baseState) {
    await invalidate(row);
    throw domainError("changeRequestTargetChanged", {}, { status: 409 });
  }
  await recordDecision(row, actor, "approve", text);
  await logAuditEvent({
    userId: actor.userId,
    action: "change_request_approved",
    entityType: ENTITY,
    entityId: row.id,
    summary: `Approved change request #${row.id}`,
    data: text ? { note: text } : undefined,
  });
  const [{ value }] = await db
    .select({ value: count() })
    .from(changeRequestDecisions)
    .where(
      and(
        eq(changeRequestDecisions.requestId, row.id),
        eq(changeRequestDecisions.decision, "approve"),
      ),
    );
  const approvals = Number(value);
  if (approvals < row.requiredApprovals) {
    return { status: "pending", approvals, required: row.requiredApprovals };
  }
  const status = await applyRequest(row.id, null);
  return { status, approvals, required: row.requiredApprovals };
}

/** One rejection ends it: an approver who says no is not outvoted by the next one. */
export async function rejectChange(
  id: number,
  access: Access,
  note?: string | null,
): Promise<DecisionResult> {
  const row = await requirePending(id);
  await assertMayDecide(row, access);
  const actor = await decider(access);
  const text = cleanNote(note, DECISION_NOTE_MAX_LENGTH);
  await recordDecision(row, actor, "reject", text);
  if (!(await transition(row.id, ["pending"], { status: "rejected", decidedAt: nowIso() }))) {
    throw domainError("changeRequestNotPending", {}, { status: 409 });
  }
  await logAuditEvent({
    userId: actor.userId,
    action: "change_request_rejected",
    entityType: ENTITY,
    entityId: row.id,
    summary: `Rejected change request #${row.id}`,
    data: text ? { note: text } : undefined,
  });
  return { status: "rejected", approvals: 0, required: row.requiredApprovals };
}

export async function withdrawChange(id: number, access: Access): Promise<void> {
  const row = await requirePending(id);
  if (row.requestedBy !== access.userId) {
    throw domainError("changeRequestNotYours", {}, { status: 403 });
  }
  if (!(await transition(row.id, ["pending"], { status: "withdrawn", decidedAt: nowIso() }))) {
    throw domainError("changeRequestNotPending", {}, { status: 409 });
  }
  await logAuditEvent({
    userId: access.userId,
    action: "change_request_withdrawn",
    entityType: ENTITY,
    entityId: row.id,
    summary: `Withdrew change request #${row.id}`,
  });
}

/**
 * An administrator applies a pending request without its approvals, for an emergency. Still as
 * its requester and still refused if its target moved; audited, and raised as an alert.
 */
export async function bypassChange(
  id: number,
  access: Access,
  reason: string,
): Promise<ChangeStatus> {
  if (access.role !== "admin") throw domainError("changeRequestBypassAdmin", {}, { status: 403 });
  const text = (reason ?? "").trim();
  if (!text) throw domainError("changeRequestBypassReason", {}, { status: 400 });
  if (text.length > BYPASS_REASON_MAX_LENGTH) {
    throw domainError(
      "changeRequestNoteTooLong",
      { max: BYPASS_REASON_MAX_LENGTH },
      { status: 400 },
    );
  }
  const row = await requirePending(id);
  const actor = await decider(access);
  await logAuditEvent({
    userId: actor.userId,
    action: "change_request_bypassed",
    entityType: ENTITY,
    entityId: row.id,
    summary: `Bypassed approval for change request #${row.id}`,
    data: { reason: text },
  });
  const { notify } = await import("../notifications");
  await notify(`change-approval-bypassed:${row.id}`, {
    kind: "changeApprovalBypassed",
    requestId: row.id,
    change: row.targetName ?? `#${row.id}`,
    by: actor.name ?? `#${actor.userId}`,
    reason: text,
  });
  return applyRequest(row.id, { by: actor.userId, name: actor.name, reason: text });
}

/**
 * Claims the request, checks its target and requester, and applies it as the requester. Only the
 * caller whose claim moved it from pending gets this far; anyone else reads the outcome.
 */
async function applyRequest(
  id: number,
  bypass: { by: number; name: string | null; reason: string } | null,
): Promise<ChangeStatus> {
  const claimed = await transition(id, ["pending"], {
    status: "applying",
    // When the claim was made, so a takeover can tell a crashed apply from a slow one.
    decidedAt: nowIso(),
    ...(bypass
      ? { bypassedBy: bypass.by, bypassedByName: bypass.name, bypassReason: bypass.reason }
      : {}),
  });
  const row = await loadRow(id);
  if (!claimed) return row.status as ChangeStatus;
  if ((await currentState(row)) !== row.baseState) {
    await invalidate(row);
    return "invalidated";
  }
  const decisions = (await decisionsOf([id])).get(id) ?? [];
  const stamp: ApprovalStamp = {
    changeRequest: id,
    approvedBy: decisions
      .filter((decision) => decision.decision === "approve")
      .map((decision) => ({ id: decision.userId, name: decision.userName })),
    ...(bypass ? { bypass: { by: bypass.by, reason: bypass.reason } } : {}),
  };
  try {
    if (!isChangeKind(row.kind)) throw domainError("changeRequestUnknownKind");
    const definition = kindDefinition(row.kind);
    const payload = payloadOf(row);
    const requester = row.requestedBy === null ? null : await actorOf(row.requestedBy);
    if (requester?.status !== "active") {
      throw domainError("changeRequestRequesterGone");
    }
    // As the requester: an approval lends no permission they lost since submitting.
    const access = await accessFor(requester.userId, requester.role);
    for (const need of definition.needs(payload)) {
      if (!can(access, need.capability, need.object)) {
        throw domainError("changeRequestRequesterLacks");
      }
    }
    await withApprovalStamp(stamp, () => definition.apply(payload, requester));
  } catch (error) {
    const code = error instanceof DomainError ? error.code : null;
    await transition(id, ["applying"], {
      status: "failed",
      resultCode: code,
      error: error instanceof Error ? error.message.slice(0, 1000) : String(error),
      decidedAt: nowIso(),
    });
    await logAuditEvent({
      userId: row.requestedBy,
      action: "change_request_failed",
      entityType: ENTITY,
      entityId: id,
      summary: `Change request #${id} failed to apply`,
      data: { code },
    });
    return "failed";
  }
  const now = nowIso();
  await transition(id, ["applying"], { status: "applied", decidedAt: now, appliedAt: now });
  await logAuditEvent({
    userId: row.requestedBy,
    action: "change_request_applied",
    entityType: ENTITY,
    entityId: id,
    summary: `Applied change request #${id}`,
    data: { approvedBy: stamp.approvedBy, bypassed: bypass !== null },
  });
  return "applied";
}

// ── Takeover ─────────────────────────────────────────────────────────

/** An apply still `applying` after this was left by a process that died mid-write. */
export const STALE_APPLY_MS = 10 * 60_000;

/** Whether the write left a trace stamped with this request: an audit event or a host revision. */
async function leftTrace(row: Row): Promise<boolean> {
  const since = row.createdAt;
  const [event] = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        gte(auditEvents.createdAt, since),
        ne(auditEvents.entityType, ENTITY),
        like(auditEvents.data, `%"approval":{"changeRequest":${row.id},%`),
      ),
    )
    .limit(1);
  if (event) return true;
  const [revision] = await db
    .select({ id: hostRevisions.id })
    .from(hostRevisions)
    .where(
      and(
        gte(hostRevisions.createdAt, since),
        like(hostRevisions.detail, `%"changeRequest":${row.id}}`),
      ),
    )
    .limit(1);
  return revision !== undefined;
}

/**
 * Applied, not applied, or no way to tell. Never re-applies: a write that committed without its
 * trace would land twice. Unchanged state proves nothing for a kind whose state is always null.
 */
async function verdictOf(
  row: Row,
): Promise<"applied" | "changeRequestInterrupted" | "changeRequestInterruptedUnknown"> {
  if (await leftTrace(row)) return "applied";
  if (!isChangeKind(row.kind)) return "changeRequestInterruptedUnknown";
  let state: unknown;
  try {
    state = await kindDefinition(row.kind).state(payloadOf(row));
  } catch {
    return "changeRequestInterruptedUnknown";
  }
  return state != null && stateHash(state) === row.baseState
    ? "changeRequestInterrupted"
    : "changeRequestInterruptedUnknown";
}

/**
 * Settles requests a crashed apply left `applying`. Each settles with a compare-and-swap on the
 * claim it read, so replicas sweeping at once settle it once.
 */
export async function recoverStalledApplies(now = Date.now()): Promise<number> {
  const stale = new Date(now - STALE_APPLY_MS).toISOString();
  const rows = await db
    .select()
    .from(changeRequests)
    .where(
      and(
        eq(changeRequests.status, "applying"),
        or(isNull(changeRequests.decidedAt), lt(changeRequests.decidedAt, stale)),
      ),
    );
  let settled = 0;
  for (const row of rows) {
    const verdict = await verdictOf(row);
    const at = nowIso();
    const set: Partial<typeof changeRequests.$inferInsert> =
      verdict === "applied"
        ? { status: "applied", decidedAt: at, appliedAt: at }
        : {
            status: "failed",
            resultCode: verdict,
            error: domainError(verdict).message,
            decidedAt: at,
          };
    const won = await db
      .update(changeRequests)
      .set(set)
      .where(
        and(
          eq(changeRequests.id, row.id),
          eq(changeRequests.status, "applying"),
          row.decidedAt === null
            ? isNull(changeRequests.decidedAt)
            : eq(changeRequests.decidedAt, row.decidedAt),
        ),
      )
      .returning({ id: changeRequests.id });
    if (won.length === 0) continue;
    settled++;
    await logAuditEvent({
      userId: row.requestedBy,
      action: verdict === "applied" ? "change_request_applied" : "change_request_failed",
      entityType: ENTITY,
      entityId: row.id,
      summary:
        verdict === "applied"
          ? `Applied change request #${row.id}`
          : `Change request #${row.id} failed to apply`,
      data: verdict === "applied" ? { recovered: true } : { code: verdict, recovered: true },
    });
  }
  return settled;
}

/** A REST or GraphQL caller: a bearer token is what "Apply to API tokens" is about. */
export function apiSubmitter(caller: {
  userId: number;
  authMethod: "bearer" | "session";
}): Submitter {
  return { userId: caller.userId, viaToken: caller.authMethod === "bearer" };
}

/**
 * Submits `change` when the policy holds it, for a caller that applies it its own way otherwise:
 * staged settings apply under their lock and clear the staged set. Null means go ahead.
 */
export async function submitIfCovered(by: Submitter, change: Change): Promise<number | null> {
  const { route, policy, tags } = await routeOf(by, change);
  if (route !== "request") return null;
  return submitChange(by, change, policy, tags);
}
