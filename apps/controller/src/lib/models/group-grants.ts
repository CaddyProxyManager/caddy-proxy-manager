/**
 * Grants only widen what a scoped role such as `operator` reaches; other roles ignore them, so
 * rows are inert until a member holds one. One nullable column per resource, not a polymorphic
 * (type, id), so each is a real foreign key and deleting a host takes its grants with it.
 */

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import db, { nowIso } from "../db";
import { groupGrants, groupMembers, groups } from "../db/schema";
import { domainError } from "../errors/domain-error";
import { type CapabilitySet, holds } from "../roles/capabilities";

/** A manage grant implies view; there is no third level. */
export type GrantCapability = "view" | "manage";

export type GrantResource =
  | { kind: "proxyHost"; id: number }
  | { kind: "l4ProxyHost"; id: number }
  | { kind: "agent"; id: number };

export type GroupGrant = {
  id: number;
  groupId: number;
  resource: GrantResource;
  capability: GrantCapability;
};

/** Anything but exactly "manage" reads as "view": a corrupt privilege row must fail closed. */
function toCapability(value: string): GrantCapability {
  return value === "manage" ? "manage" : "view";
}

function toResource(row: typeof groupGrants.$inferSelect): GrantResource | null {
  if (row.proxyHostId !== null) return { kind: "proxyHost", id: row.proxyHostId };
  if (row.l4ProxyHostId !== null) return { kind: "l4ProxyHost", id: row.l4ProxyHostId };
  if (row.agentId !== null) return { kind: "agent", id: row.agentId };
  // A row naming nothing grants nothing. Only reachable by hand-editing the table.
  return null;
}

function toGrant(row: typeof groupGrants.$inferSelect): GroupGrant | null {
  const resource = toResource(row);
  if (!resource) return null;
  return {
    id: row.id,
    groupId: row.groupId,
    resource,
    capability: toCapability(row.capability),
  };
}

/** Keyed by group id. */
export async function listAllGrants(): Promise<Map<number, GroupGrant[]>> {
  const rows = await db.select().from(groupGrants);
  const byGroup = new Map<number, GroupGrant[]>();
  for (const row of rows) {
    const grant = toGrant(row);
    if (!grant) continue;
    const bucket = byGroup.get(grant.groupId) ?? [];
    bucket.push(grant);
    byGroup.set(grant.groupId, bucket);
  }
  return byGroup;
}

function columnsFor(resource: GrantResource) {
  return {
    proxyHostId: resource.kind === "proxyHost" ? resource.id : null,
    l4ProxyHostId: resource.kind === "l4ProxyHost" ? resource.id : null,
    agentId: resource.kind === "agent" ? resource.id : null,
  };
}

/** Delete-then-insert is safe here: the transient state a reader could see is less access. */
export async function setGroupGrants(
  groupId: number,
  grants: { resource: GrantResource; capability: GrantCapability }[],
): Promise<void> {
  await db.delete(groupGrants).where(eq(groupGrants.groupId, groupId));
  if (grants.length === 0) return;

  const seen = new Set<string>();
  const rows = [];
  const now = nowIso();
  for (const grant of grants) {
    const key = `${grant.resource.kind}:${grant.resource.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      groupId,
      ...columnsFor(grant.resource),
      capability: grant.capability,
      createdAt: now,
    });
  }
  if (rows.length > 0) await db.insert(groupGrants).values(rows);
}

export type EffectiveGrants = {
  proxyHosts: Map<number, GrantCapability>;
  l4ProxyHosts: Map<number, GrantCapability>;
  agents: Map<number, GrantCapability>;
};

export function emptyGrants(): EffectiveGrants {
  return { proxyHosts: new Map(), l4ProxyHosts: new Map(), agents: new Map() };
}

function merge(into: Map<number, GrantCapability>, id: number, capability: GrantCapability): void {
  // Most permissive wins, independent of row order.
  if (into.get(id) === "manage") return;
  into.set(id, capability);
}

/** Ignores role, so `lib/users/permissions.ts` alone decides what a role does with grants. */
export async function grantsForUser(userId: number): Promise<EffectiveGrants> {
  return await grantsForGroups(await groupIdsOf(userId));
}

export async function groupIdsOf(userId: number): Promise<number[]> {
  const memberships = await db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(eq(groupMembers.userId, userId));
  return memberships.map((row) => row.groupId);
}

/** The roles these groups carry, each once. */
export async function rolesOfGroups(groupIds: number[]): Promise<string[]> {
  if (groupIds.length === 0) return [];
  const rows = await db
    .select({ role: groups.role })
    .from(groups)
    .where(and(inArray(groups.id, groupIds), isNotNull(groups.role)));
  return [...new Set(rows.flatMap((row) => (row.role ? [row.role] : [])))];
}

export async function grantsForGroups(groupIds: number[]): Promise<EffectiveGrants> {
  if (groupIds.length === 0) return emptyGrants();

  const rows = await db.select().from(groupGrants).where(inArray(groupGrants.groupId, groupIds));

  const effective = emptyGrants();
  for (const row of rows) {
    const grant = toGrant(row);
    if (!grant) continue;
    if (grant.resource.kind === "proxyHost") {
      merge(effective.proxyHosts, grant.resource.id, grant.capability);
    } else if (grant.resource.kind === "l4ProxyHost") {
      merge(effective.l4ProxyHosts, grant.resource.id, grant.capability);
    } else {
      merge(effective.agents, grant.resource.id, grant.capability);
    }
  }
  return effective;
}

/**
 * A grant hands its group's scoped members part of what the giver manages, so only someone who
 * manages every host (or agent) may give one.
 */
export function assertMayGrant(
  holding: CapabilitySet,
  grants: readonly { resource: GrantResource }[],
): void {
  for (const { resource } of grants) {
    const capability = resource.kind === "agent" ? "agents:write" : "hosts:write";
    if (!holds(holding, capability)) throw domainError("roleExceedsYours", {}, { status: 403 });
  }
}
