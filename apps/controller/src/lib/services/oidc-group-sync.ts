/**
 * Applies an IdP's group claim to a CPM user. `mapProfileToUser` has no user id yet, so the result
 * is parked by provider + subject and consumed at session creation.
 */

import { eq } from "drizzle-orm";
import db, { nowIso } from "../db";
import { accounts, groupMembers, groups, users } from "../db/schema";
import { logAuditEvent } from "../audit";
import { type AppRole, normalizeGroupName } from "../oidc-groups";
import { mappedExternalKeys, mappedGroupNames } from "../models/group-idp-mappings";
import { isLastActiveAdmin, reportNewAdmin, withAdminLock } from "../models/user";

export type PendingOidcSync = {
  providerId: string;
  subject: string;
  providerName: string;
  /** Null when role mapping is off. */
  role: AppRole | null;
  /** Empty when group sync is off. */
  localGroups: string[];
  /** Verbatim: the explicit mappings are in the database, out of sync `mapProfileToUser`'s reach. */
  claimedGroups: string[];
  syncGroups: boolean;
};

/** A sign-in consumes its entry within seconds; this is only a leak guard. */
const PENDING_TTL_MS = 5 * 60 * 1000;

const pending = new Map<string, { entry: PendingOidcSync; expiresAt: number }>();

function pendingKey(providerId: string, subject: string): string {
  return `${providerId}\u0000${subject}`;
}

function prunePending(now: number): void {
  for (const [key, value] of pending) {
    if (value.expiresAt <= now) pending.delete(key);
  }
}

export function recordPendingOidcSync(entry: PendingOidcSync): void {
  const now = Date.now();
  prunePending(now);
  pending.set(pendingKey(entry.providerId, entry.subject), {
    entry,
    expiresAt: now + PENDING_TTL_MS,
  });
}

export function consumePendingOidcSync(
  providerId: string,
  subject: string,
): PendingOidcSync | null {
  const key = pendingKey(providerId, subject);
  const found = pending.get(key);
  pending.delete(key);
  if (!found || found.expiresAt <= Date.now()) return null;
  return found.entry;
}

/** For tests: the registry is process-wide. */
export function clearPendingOidcSyncs(): void {
  pending.clear();
}

async function applyRole(userId: number, entry: PendingOidcSync): Promise<void> {
  const role = entry.role;
  if (role === null) return;

  // Under the admin lock: two reconciliations demoting each other would both see the other admin.
  await withAdminLock(() => applyRoleLocked(userId, role, entry));
}

async function applyRoleLocked(
  userId: number,
  role: NonNullable<PendingOidcSync["role"]>,
  entry: PendingOidcSync,
): Promise<void> {
  const current = await db.query.users.findFirst({
    where: (table, { eq: equals }) => equals(table.id, userId),
  });
  if (!current || current.role === role) return;

  // Never let a claim change lock the instance out of its last administrator.
  if (current.role === "admin" && (await isLastActiveAdmin(userId))) {
    console.warn(
      `[oidc-group-sync] Skipping demotion of user ${userId} to "${entry.role}": they are the last active admin.`,
    );
    await logAuditEvent({
      userId,
      action: "oidc_role_sync_skipped",
      entityType: "user",
      entityId: userId,
      summary: `Kept admin role for user ${userId}: ${entry.providerName} groups mapped to "${entry.role}" but no other active admin exists`,
    });
    return;
  }

  await db.update(users).set({ role, updatedAt: nowIso() }).where(eq(users.id, userId));

  await logAuditEvent({
    userId,
    action: "oidc_role_sync",
    entityType: "user",
    entityId: userId,
    summary: `Role for user ${userId} set to "${entry.role}" from ${entry.providerName} groups (was "${current.role}")`,
  });
  if (role === "admin") await reportNewAdmin(current, true);
}

async function applyGroups(userId: number, entry: PendingOidcSync): Promise<void> {
  if (!entry.syncGroups) return;

  // Explicit mappings win and are kept out of the mirroring, or one claim lands in two groups.
  const [explicit, explicitKeys] = await Promise.all([
    mappedGroupNames(entry.claimedGroups, entry.providerId),
    mappedExternalKeys(entry.providerId),
  ]);
  const mirrored = entry.localGroups.filter(
    (name) => !explicitKeys.has(normalizeGroupName(name).toLowerCase()),
  );

  const desired = new Map([...explicit, ...mirrored].map((name) => [name.toLowerCase(), name]));

  const [existingGroups, memberships] = await Promise.all([
    db.select().from(groups),
    db
      .select({ groupId: groupMembers.groupId, memberId: groupMembers.id })
      .from(groupMembers)
      .where(eq(groupMembers.userId, userId)),
  ]);
  const groupsByName = new Map(existingGroups.map((group) => [group.name.toLowerCase(), group]));
  const groupsById = new Map(existingGroups.map((group) => [group.id, group]));
  const memberGroupIds = new Set(memberships.map((m) => m.groupId));

  // A mirrored name joins only an IdP-owned group: a UI group sharing the name carries grants never
  // tied to the IdP. An explicit mapping may name any group.
  const explicitNames = new Set(explicit.map((name) => name.toLowerCase()));
  const added: string[] = [];
  for (const [key, name] of desired) {
    let group = groupsByName.get(key);
    if (group && group.source !== "oidc" && !explicitNames.has(key)) {
      console.warn(
        `[oidc-group-sync] Not adding user ${userId} to "${group.name}": it was created in the UI, and no mapping names it.`,
      );
      continue;
    }
    if (!group) {
      const now = nowIso();
      const [created] = await db
        .insert(groups)
        .values({
          name,
          description: `Synced from ${entry.providerName}`,
          createdBy: null,
          source: "oidc",
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!created) continue;
      group = created;
      groupsByName.set(key, created);
    }
    if (memberGroupIds.has(group.id)) continue;
    await db.insert(groupMembers).values({ groupId: group.id, userId, createdAt: nowIso() });
    added.push(group.name);
  }

  // Only IdP-owned groups: a UI-created group keeps the membership the operator gave it.
  const removed: string[] = [];
  for (const membership of memberships) {
    const group = groupsById.get(membership.groupId);
    if (group?.source !== "oidc") continue;
    if (desired.has(group.name.toLowerCase())) continue;
    await db.delete(groupMembers).where(eq(groupMembers.id, membership.memberId));
    removed.push(group.name);
  }

  if (added.length === 0 && removed.length === 0) return;

  const parts: string[] = [];
  if (added.length) parts.push(`added to ${added.join(", ")}`);
  if (removed.length) parts.push(`removed from ${removed.join(", ")}`);
  await logAuditEvent({
    userId,
    action: "oidc_group_sync",
    entityType: "user",
    entityId: userId,
    summary: `Group membership for user ${userId} synced from ${entry.providerName}: ${parts.join("; ")}`,
    data: { added, removed },
  });
}

export async function applyOidcSync(userId: number, entry: PendingOidcSync): Promise<void> {
  await applyRole(userId, entry);
  await applyGroups(userId, entry);
}

/** Looks up via linked accounts, so concurrent sign-ins cannot pick up each other's claims. */
export async function reconcileOidcUserAfterSignIn(userId: number): Promise<void> {
  if (pending.size === 0 || !Number.isFinite(userId)) return;

  const linked = await db
    .select({ providerId: accounts.providerId, accountId: accounts.accountId })
    .from(accounts)
    .where(eq(accounts.userId, userId));

  for (const account of linked) {
    const entry = consumePendingOidcSync(account.providerId, account.accountId);
    if (!entry) continue;
    await applyOidcSync(userId, entry);
    return;
  }
}
