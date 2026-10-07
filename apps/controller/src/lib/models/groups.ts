import db, { nowIso, toIso } from "../db";
import { logAuditEvent } from "../audit";
import { diffAuditRecords } from "../audit/changes";
import { groups, groupMembers, users } from "../db/schema";
import { asc, eq, inArray, count } from "drizzle-orm";
import { DomainError, domainError } from "../errors/domain-error";
import type { CapabilitySet } from "../roles/capabilities";
import { assertMayAssignRole } from "../roles/store";

export type Group = {
  id: number;
  name: string;
  description: string | null;
  /** "ui" for operator-managed groups, "oidc" for groups an IdP sync created. */
  source: string;
  /** A role every member holds besides their own; never the built-in admin. */
  role: string | null;
  members: GroupMember[];
  createdAt: string;
  updatedAt: string;
};

export type GroupMember = {
  userId: number;
  email: string;
  name: string | null;
  createdAt: string;
};

export type GroupInput = {
  name: string;
  description?: string | null;
};

type GroupRow = typeof groups.$inferSelect;

function toGroup(row: GroupRow, members: GroupMember[]): Group {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    source: row.source,
    role: row.role,
    members,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

export async function listGroups(): Promise<Group[]> {
  const allGroups = await db.query.groups.findMany({
    orderBy: (table) => asc(table.name),
  });

  if (allGroups.length === 0) return [];

  const groupIds = allGroups.map((g) => g.id);
  const allMembers = await db
    .select({
      groupId: groupMembers.groupId,
      userId: groupMembers.userId,
      email: users.email,
      name: users.name,
      createdAt: groupMembers.createdAt,
    })
    .from(groupMembers)
    .innerJoin(users, eq(groupMembers.userId, users.id))
    .where(inArray(groupMembers.groupId, groupIds));

  const membersByGroup = new Map<number, GroupMember[]>();
  for (const m of allMembers) {
    const bucket = membersByGroup.get(m.groupId) ?? [];
    bucket.push({
      userId: m.userId,
      email: m.email,
      name: m.name,
      createdAt: toIso(m.createdAt)!,
    });
    membersByGroup.set(m.groupId, bucket);
  }

  return allGroups.map((g) => toGroup(g, membersByGroup.get(g.id) ?? []));
}

export async function countGroups(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(groups);
  return row?.value ?? 0;
}

export async function getGroup(id: number): Promise<Group | null> {
  const group = await db.query.groups.findFirst({
    where: (table, operators) => operators.eq(table.id, id),
  });
  if (!group) return null;

  const members = await db
    .select({
      userId: groupMembers.userId,
      email: users.email,
      name: users.name,
      createdAt: groupMembers.createdAt,
    })
    .from(groupMembers)
    .innerJoin(users, eq(groupMembers.userId, users.id))
    .where(eq(groupMembers.groupId, id));

  return toGroup(
    group,
    members.map((m) => ({
      userId: m.userId,
      email: m.email,
      name: m.name,
      createdAt: toIso(m.createdAt)!,
    })),
  );
}

export async function createGroup(input: GroupInput, actorUserId: number): Promise<Group> {
  const now = nowIso();

  const [row] = await db
    .insert(groups)
    .values({
      name: input.name.trim(),
      description: input.description ?? null,
      createdBy: actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!row) throw domainError("failedToCreateGroup");

  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "group",
    entityId: row.id,
    summary: `Created group ${input.name}`,
  });

  return (await getGroup(row.id))!;
}

export async function updateGroup(
  id: number,
  input: { name?: string; description?: string | null },
  actorUserId: number,
): Promise<Group> {
  const existing = await db.query.groups.findFirst({
    where: (table, operators) => operators.eq(table.id, id),
  });
  if (!existing) throw domainError("groupNotFound");

  await db
    .update(groups)
    .set({
      name: input.name ?? existing.name,
      description: input.description !== undefined ? input.description : existing.description,
      updatedAt: nowIso(),
    })
    .where(eq(groups.id, id));

  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "group",
    entityId: id,
    summary: `Updated group ${input.name ?? existing.name}`,
    changes: diffAuditRecords(
      { name: existing.name, description: existing.description },
      {
        name: input.name ?? existing.name,
        description: input.description !== undefined ? input.description : existing.description,
      },
    ),
  });

  return (await getGroup(id))!;
}

export async function deleteGroup(id: number, actorUserId: number): Promise<void> {
  const existing = await db.query.groups.findFirst({
    where: (table, operators) => operators.eq(table.id, id),
  });
  if (!existing) throw domainError("groupNotFound");

  await db.delete(groups).where(eq(groups.id, id));

  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "group",
    entityId: id,
    summary: `Deleted group ${existing.name}`,
  });
}

export async function addGroupMember(
  groupId: number,
  userId: number,
  actorUserId: number,
): Promise<Group> {
  const group = await db.query.groups.findFirst({
    where: (table, operators) => operators.eq(table.id, groupId),
  });
  if (!group) throw domainError("groupNotFound");

  await db.insert(groupMembers).values({
    groupId,
    userId,
    createdAt: nowIso(),
  });

  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "group_member",
    entityId: groupId,
    summary: `Added user ${userId} to group ${group.name}`,
  });

  return (await getGroup(groupId))!;
}

export async function removeGroupMember(
  groupId: number,
  userId: number,
  actorUserId: number,
): Promise<Group> {
  const group = await db.query.groups.findFirst({
    where: (table, operators) => operators.eq(table.id, groupId),
  });
  if (!group) throw domainError("groupNotFound");

  const member = await db.query.groupMembers.findFirst({
    where: (table, operators) =>
      operators.and(operators.eq(table.groupId, groupId), operators.eq(table.userId, userId)),
  });
  if (!member) throw domainError("memberNotFoundInGroup");

  await db.delete(groupMembers).where(eq(groupMembers.id, member.id));

  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "group_member",
    entityId: groupId,
    summary: `Removed user ${userId} from group ${group.name}`,
  });

  return (await getGroup(groupId))!;
}

export async function getGroupsForUser(userId: number): Promise<{ id: number; name: string }[]> {
  const rows = await db
    .select({ id: groups.id, name: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .where(eq(groupMembers.userId, userId));

  return rows;
}

/**
 * The role a group gives its members, or none. Never the built-in admin: an administrator is a
 * person the second-factor policy and the last-administrator guard can name, which a group is not.
 */
export async function setGroupRole(
  id: number,
  role: string | null,
  actor: { userId: number; capabilities: CapabilitySet },
): Promise<Group> {
  const existing = await db.query.groups.findFirst({
    where: (table, operators) => operators.eq(table.id, id),
  });
  if (!existing) throw domainError("groupNotFound");
  if (role === "admin") throw domainError("groupRoleAdmin");
  if (role !== null) await assertMayAssignRole(actor.capabilities, role);
  // Taking a role away hands nothing out, but changing one the actor could not give is acting
  // above themselves.
  if (existing.role !== null)
    await assertMayAssignRole(actor.capabilities, existing.role).catch((error) => {
      if (error instanceof DomainError && error.code === "invalidUserRole") return;
      throw error;
    });
  if (existing.role === role) return (await getGroup(id))!;

  await db.update(groups).set({ role, updatedAt: nowIso() }).where(eq(groups.id, id));
  await logAuditEvent({
    userId: actor.userId,
    action: "update",
    entityType: "group",
    entityId: id,
    summary: `Updated group ${existing.name}`,
    changes: diffAuditRecords({ role: existing.role }, { role }),
  });
  return (await getGroup(id))!;
}

/**
 * Joining a group gives its role, so adding someone is handing it out: only for whoever could
 * give that role directly.
 */
export async function assertMayAddToGroup(holding: CapabilitySet, groupId: number): Promise<void> {
  const group = await db.query.groups.findFirst({
    where: (table, operators) => operators.eq(table.id, groupId),
    columns: { role: true },
  });
  if (group?.role) await assertMayAssignRole(holding, group.role);
}
