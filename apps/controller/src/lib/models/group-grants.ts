/**
 * What a group is allowed to manage.
 *
 * Grants are **additive and non-subtractive**: they widen what an `operator` can reach and change
 * nothing at all for an `admin`, a `user` or a `viewer`. That is the property that makes this safe
 * to ship into an existing deployment - until someone is deliberately given the operator role,
 * every row in this table is inert.
 *
 * Resources are named by one nullable column each rather than a polymorphic (type, id) pair, so
 * every reference is a real foreign key: deleting a host takes its grants with it instead of
 * leaving a row pointing at an id something else will later reuse.
 */

import { eq, inArray } from "drizzle-orm";
import db, { nowIso } from "../db";
import { groupGrants, groupMembers } from "../db/schema";

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

/**
 * Anything that is not exactly "manage" reads as "view".
 *
 * The permissive direction would be the wrong default for a column that decides privilege: a row
 * with a typo in it, or one edited by hand, must not silently grant more than it says. The writer
 * only ever stores the two literals, so this only matters when something has already gone wrong -
 * which is exactly when it should fail closed.
 */
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

/** Every grant, keyed by group id - for the page that lists all the groups at once. */
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

/**
 * Replace a group's grants.
 *
 * Delete-then-insert, unlike host assignments: an empty grant list means "this group manages
 * nothing", which is the safe direction. The transient state a reader could see between the two
 * statements is *less* access, not more.
 */
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

/** What one user's group memberships add up to. Empty for a user in no groups. */
export type EffectiveGrants = {
  proxyHosts: Map<number, GrantCapability>;
  l4ProxyHosts: Map<number, GrantCapability>;
  agents: Map<number, GrantCapability>;
};

export function emptyGrants(): EffectiveGrants {
  return { proxyHosts: new Map(), l4ProxyHosts: new Map(), agents: new Map() };
}

function merge(into: Map<number, GrantCapability>, id: number, capability: GrantCapability): void {
  // The most permissive grant wins. Two groups reaching the same host, one with view and one with
  // manage, must not depend on which row came back first.
  if (into.get(id) === "manage") return;
  into.set(id, capability);
}

/**
 * Everything this user's groups grant, unioned.
 *
 * Role is not consulted here: this answers "what did the grants say", and the caller decides what
 * the role does with it. Keeping the two apart is what lets `lib/permissions.ts` state the rule
 * that an admin ignores grants entirely in one place.
 */
export async function grantsForUser(userId: number): Promise<EffectiveGrants> {
  const memberships = await db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(eq(groupMembers.userId, userId));
  return await grantsForGroups(memberships.map((row) => row.groupId));
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
