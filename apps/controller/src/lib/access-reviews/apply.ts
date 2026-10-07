/**
 * Closing a campaign, and carrying out what it revoked. Every revocation goes through the guards
 * the Users and Groups pages use, as the person closing or confirming, so a review never does what
 * that person could not do by hand: a role they cannot hand out, an account above their own, the
 * last administrator. One that fails is recorded with its reason and can be tried again.
 */
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import db from "../db";
import { accessReviewCampaigns, accessReviewItems, groupMembers } from "../db/schema";
import { logAuditEvent } from "../audit";
import { diffAuditRecords } from "../audit/changes";
import { DomainError, domainError } from "../errors/domain-error";
import { type Capability, holds } from "../roles/capabilities";
import { scimManagedUserIds } from "./collect";
import { type ReviewActor, assertRunsReviews, loadCampaign } from "./index";
import { DECISIONS, type ReviewCampaign } from "./model";

type ItemRow = typeof accessReviewItems.$inferSelect;

/** A run a crashed process left `applying` is taken over after this. */
const STALE_APPLY_MS = 10 * 60_000;

function requireHolds(actor: ReviewActor, capability: Capability): void {
  if (!holds(actor.capabilities, capability)) {
    throw domainError("accessDenied", {}, { status: 403 });
  }
}

async function stillScimManaged(item: ItemRow): Promise<boolean> {
  if (item.kind === "role" && item.userId !== null) {
    return (await scimManagedUserIds([item.userId])).has(item.userId);
  }
  if (item.kind === "membership" && item.groupId !== null) {
    const { groups } = await import("../db/schema");
    const [group] = await db
      .select({ source: groups.source })
      .from(groups)
      .where(eq(groups.id, item.groupId))
      .limit(1);
    return group?.source === "scim";
  }
  return false;
}

async function applyRole(item: ItemRow, actor: ReviewActor): Promise<"applied" | "gone"> {
  requireHolds(actor, "users:write");
  const { getUserById, updateUserRole, updateUserStatus } = await import("../models/user");
  const { assertAssignableRole, assertMayManageUser, assertNotSelf } = await import(
    "../users/admin"
  );
  const user = item.userId === null ? null : await getUserById(item.userId);
  if (!user) return "gone";
  if (item.decision === "revoke") {
    if (user.status !== "active") return "gone";
    assertNotSelf(actor.userId, user.id, "cannotChangeOwnStatus");
    await assertMayManageUser(actor.capabilities, user.id);
    await updateUserStatus(user.id, "disabled");
    await logAuditEvent({
      userId: actor.userId,
      action: "update",
      entityType: "user",
      entityId: user.id,
      summary: `Changed user ${user.id} status to disabled`,
      changes: diffAuditRecords({ status: user.status }, { status: "disabled" }),
      data: { accessReview: item.campaignId },
    });
    return "applied";
  }
  assertNotSelf(actor.userId, user.id, "cannotChangeOwnRole");
  await assertMayManageUser(actor.capabilities, user.id);
  const role = await assertAssignableRole(actor.capabilities, item.changeTo);
  await updateUserRole(user.id, role);
  await logAuditEvent({
    userId: actor.userId,
    action: "update",
    entityType: "user",
    entityId: user.id,
    summary: `Changed user ${user.id} role to ${role}`,
    changes: diffAuditRecords({ role: user.role }, { role }),
    data: { accessReview: item.campaignId },
  });
  return "applied";
}

async function applyMembership(item: ItemRow, actor: ReviewActor): Promise<"applied" | "gone"> {
  requireHolds(actor, "groups:write");
  if (item.groupId === null || item.userId === null) return "gone";
  const [member] = await db
    .select({ id: groupMembers.id })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, item.groupId), eq(groupMembers.userId, item.userId)))
    .limit(1);
  if (!member) return "gone";
  const { removeGroupMember } = await import("../models/groups");
  await removeGroupMember(item.groupId, item.userId, actor.userId);
  return "applied";
}

async function applyGrant(item: ItemRow, actor: ReviewActor): Promise<"applied" | "gone"> {
  requireHolds(actor, "groups:write");
  if (item.groupId === null || item.objectId === null) return "gone";
  const { assertMayGrant, listAllGrants, setGroupGrants } = await import("../models/group-grants");
  const grants = (await listAllGrants()).get(item.groupId) ?? [];
  const target = grants.find(
    (grant) => grant.resource.kind === item.objectKind && grant.resource.id === item.objectId,
  );
  if (!target) return "gone";
  const next = grants.flatMap((grant) => {
    if (grant !== target) return [{ resource: grant.resource, capability: grant.capability }];
    if (item.decision === "revoke") return [];
    return [
      { resource: grant.resource, capability: item.changeTo === "manage" ? "manage" : "view" },
    ];
  }) as Parameters<typeof setGroupGrants>[1];
  // As the Groups page saves them: the whole list, every grant in it one the closer could give.
  assertMayGrant(actor.capabilities, next);
  await setGroupGrants(item.groupId, next);
  await logAuditEvent({
    userId: actor.userId,
    action: "update",
    entityType: "group",
    entityId: item.groupId,
    summary: `Updated the management grants for group ${item.groupId}`,
    data: { grants: next, accessReview: item.campaignId },
  });
  return "applied";
}

async function applyToken(item: ItemRow, actor: ReviewActor): Promise<"applied" | "gone"> {
  requireHolds(actor, "tokens:write");
  if (item.tokenId === null) return "gone";
  const [{ deleteApiToken }, { NotFoundError }] = await Promise.all([
    import("../models/api-tokens"),
    import("../api/auth"),
  ]);
  try {
    await deleteApiToken(item.tokenId, actor.userId, true);
  } catch (error) {
    if (error instanceof NotFoundError) return "gone";
    throw error;
  }
  return "applied";
}

/** Switched off rather than deleted: deleting retires every account it provisioned. */
async function applyConnection(item: ItemRow, actor: ReviewActor): Promise<"applied" | "gone"> {
  if (item.connectionId === null) return "gone";
  const { getScimConnection, updateScimConnection } = await import("../scim/connections");
  const connection = await getScimConnection(item.connectionId);
  if (!connection) return "gone";
  if (!connection.enabled) return "gone";
  await updateScimConnection(connection.id, { name: connection.name, enabled: false }, actor);
  return "applied";
}

export async function applyItem(item: ItemRow, actor: ReviewActor): Promise<"applied" | "gone"> {
  if (item.decision === "revoke" && (await stillScimManaged(item))) {
    throw domainError("accessReviewScimManaged", {}, { status: 409 });
  }
  switch (item.kind) {
    case "role":
      return applyRole(item, actor);
    case "membership":
      return applyMembership(item, actor);
    case "grant":
      return applyGrant(item, actor);
    case "token":
      return applyToken(item, actor);
    case "scimConnection":
      return applyConnection(item, actor);
    default:
      return "gone";
  }
}

/** Revocations and changes not yet carried out, or that failed last time. */
async function outstanding(campaignId: number): Promise<ItemRow[]> {
  return db
    .select()
    .from(accessReviewItems)
    .where(
      and(
        eq(accessReviewItems.campaignId, campaignId),
        inArray(
          accessReviewItems.decision,
          DECISIONS.filter((d) => d !== "keep"),
        ),
        or(isNull(accessReviewItems.outcome), eq(accessReviewItems.outcome, "failed")),
      ),
    );
}

async function applyAll(campaignId: number, actor: ReviewActor): Promise<number> {
  let failed = 0;
  for (const item of await outstanding(campaignId)) {
    let outcome: "applied" | "gone" | "failed";
    let code: string | null = null;
    try {
      outcome = await applyItem(item, actor);
    } catch (error) {
      outcome = "failed";
      if (error instanceof DomainError) {
        code = error.code;
      } else {
        console.error(`[access-reviews] could not apply item ${item.id}:`, error);
        code = "accessReviewApplyFailed";
      }
      failed++;
    }
    await db
      .update(accessReviewItems)
      .set({ outcome, outcomeCode: code, appliedAt: new Date().toISOString() })
      .where(eq(accessReviewItems.id, item.id));
  }
  return failed;
}

/** Compare-and-swap, so two people closing or confirming at once apply nothing twice. */
async function claim(
  id: number,
  from: "open" | "confirming",
  set: Partial<typeof accessReviewCampaigns.$inferInsert>,
): Promise<boolean> {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - STALE_APPLY_MS).toISOString();
  const won = await db
    .update(accessReviewCampaigns)
    .set({ ...set, updatedAt: now })
    .where(
      and(
        eq(accessReviewCampaigns.id, id),
        from === "open"
          ? eq(accessReviewCampaigns.status, "open")
          : or(
              eq(accessReviewCampaigns.status, "confirming"),
              and(
                eq(accessReviewCampaigns.status, "applying"),
                lt(accessReviewCampaigns.updatedAt, stale),
              ),
            ),
      ),
    )
    .returning({ id: accessReviewCampaigns.id });
  return won.length > 0;
}

async function finish(id: number, actor: ReviewActor): Promise<void> {
  const failed = await applyAll(id, actor);
  const now = new Date().toISOString();
  await db
    .update(accessReviewCampaigns)
    .set(
      failed > 0
        ? { status: "confirming", updatedAt: now }
        : { status: "closed", appliedAt: now, appliedBy: actor.userId, updatedAt: now },
    )
    .where(eq(accessReviewCampaigns.id, id));
}

/**
 * Ends the reviewing. Revocations apply now, as `actor`, unless Settings says they wait for an
 * administrator's confirmation; undecided items are left as they are.
 */
export async function closeCampaign(id: number, actor: ReviewActor): Promise<ReviewCampaign> {
  assertRunsReviews(actor);
  const before = await loadCampaign(id);
  const [{ accessReviewConfirmRevocations }, { getSetting }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);
  const confirm = await getSetting(accessReviewConfirmRevocations);
  const pending = (await outstanding(id)).length;
  const waits = confirm && pending > 0;
  const now = new Date().toISOString();
  const won = await claim(id, "open", {
    status: waits ? "confirming" : "applying",
    closedAt: now,
    closedBy: actor.userId,
  });
  if (!won) throw domainError("accessReviewNotOpen", {}, { status: 409 });
  await logAuditEvent({
    userId: actor.userId,
    action: "access_review_closed",
    entityType: "access_review",
    entityId: id,
    summary: `Closed access review ${before.name}`,
    data: { decided: before.counts.decided, total: before.counts.total, revocations: pending },
  });
  if (waits) {
    const { notify } = await import("../notifications");
    await notify(
      `access-review-confirm:${id}`,
      { kind: "accessReviewConfirm", campaignId: id, campaign: before.name, revocations: pending },
      "forever",
    );
  } else {
    await finish(id, actor);
  }
  return loadCampaign(id);
}

/** An administrator's go-ahead for what a closed campaign revoked, or another try at failures. */
export async function confirmCampaign(id: number, actor: ReviewActor): Promise<ReviewCampaign> {
  assertRunsReviews(actor);
  const before = await loadCampaign(id);
  if (!(await claim(id, "confirming", { status: "applying" }))) {
    throw domainError("accessReviewNotConfirming", {}, { status: 409 });
  }
  await logAuditEvent({
    userId: actor.userId,
    action: "access_review_applied",
    entityType: "access_review",
    entityId: id,
    summary: `Applied the revocations of access review ${before.name}`,
  });
  await finish(id, actor);
  return loadCampaign(id);
}
