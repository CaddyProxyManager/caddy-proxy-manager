/**
 * What a campaign asks about: its scope read once when it opens, each item with the names and
 * hints it had then, spread over the reviewers so nobody is asked about their own access.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import db, { toIso } from "../db";
import {
  agents,
  apiTokens,
  groupGrants,
  groupMembers,
  groups,
  l4ProxyHosts,
  proxyHosts,
  scimConnections,
  scimUsers,
  users,
} from "../db/schema";
import { domainError } from "../errors/domain-error";
import { getRole } from "../roles/store";
import { HINT_DAYS, type Hint, type ItemKind, type ReviewScope } from "./model";

export type ItemDraft = {
  kind: ItemKind;
  userId: number | null;
  groupId: number | null;
  tokenId: number | null;
  connectionId: number | null;
  objectKind: string | null;
  objectId: number | null;
  subjectLabel: string;
  targetLabel: string | null;
  current: string | null;
  hints: Hint[];
  scimManaged: boolean;
};

const DAY_MS = 86_400_000;

/** Last used (or signed in) longer ago than the hint's days; never used counts from creation. */
export function unusedFor(
  lastAt: string | null,
  createdAt: string | null,
  now: number,
  days = HINT_DAYS,
): boolean {
  const reference = Date.parse(lastAt ?? createdAt ?? "");
  return Number.isFinite(reference) && now - reference > days * DAY_MS;
}

type Person = { id: number; email: string; lastSignInAt: string | null; createdAt: string | null };

function blank(kind: ItemKind, subjectLabel: string): ItemDraft {
  return {
    kind,
    userId: null,
    groupId: null,
    tokenId: null,
    connectionId: null,
    objectKind: null,
    objectId: null,
    subjectLabel,
    targetLabel: null,
    current: null,
    hints: [],
    scimManaged: false,
  };
}

function personHints(person: Person, now: number): Hint[] {
  return unusedFor(person.lastSignInAt, person.createdAt, now) ? ["noRecentSignIn"] : [];
}

/** Disabled accounts hold nothing, so only active ones are reviewed. */
async function activePeople(
  ids?: readonly number[],
): Promise<Map<number, Person & { role: string }>> {
  if (ids && ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      lastSignInAt: users.lastSignInAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(
      ids
        ? and(eq(users.status, "active"), inArray(users.id, [...ids]))
        : eq(users.status, "active"),
    )
    .orderBy(users.email);
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        email: row.email,
        role: row.role,
        lastSignInAt: toIso(row.lastSignInAt),
        createdAt: toIso(row.createdAt),
      },
    ]),
  );
}

/**
 * Accounts a live SCIM connection provisioned: the identity provider would undo a CPM-side
 * disable on its next write, so such a revocation is refused rather than recorded as done.
 */
export async function scimManagedUserIds(ids: readonly number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ userId: scimUsers.userId })
    .from(scimUsers)
    .innerJoin(
      scimConnections,
      eq(scimUsers.connectionId, sql`cast(${scimConnections.id} as text)`),
    )
    .where(inArray(scimUsers.userId, [...ids]));
  return new Set(rows.map((row) => row.userId));
}

function roleItems(
  people: Iterable<Person & { role: string }>,
  managed: ReadonlySet<number>,
  now: number,
): ItemDraft[] {
  return [...people].map((person) => ({
    ...blank("role", person.email),
    userId: person.id,
    current: person.role,
    hints: personHints(person, now),
    scimManaged: managed.has(person.id),
  }));
}

async function membershipItems(
  groupIds: readonly number[] | null,
  now: number,
): Promise<ItemDraft[]> {
  if (groupIds && groupIds.length === 0) return [];
  const rows = await db
    .select({
      groupId: groupMembers.groupId,
      userId: groupMembers.userId,
      groupName: groups.name,
      source: groups.source,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .where(groupIds ? inArray(groupMembers.groupId, [...groupIds]) : undefined)
    .orderBy(groups.name);
  const people = await activePeople([...new Set(rows.map((row) => row.userId))]);
  return rows.flatMap((row) => {
    const person = people.get(row.userId);
    if (!person) return [];
    return [
      {
        ...blank("membership", person.email),
        userId: person.id,
        groupId: row.groupId,
        targetLabel: row.groupName,
        hints: personHints(person, now),
        // The identity provider owns a provisioned group's members.
        scimManaged: row.source === "scim",
      },
    ];
  });
}

async function objectNames(): Promise<Record<string, Map<number, string>>> {
  const [hosts, l4, agentRows] = await Promise.all([
    db.select({ id: proxyHosts.id, name: proxyHosts.name }).from(proxyHosts),
    db.select({ id: l4ProxyHosts.id, name: l4ProxyHosts.name }).from(l4ProxyHosts),
    db.select({ id: agents.id, name: agents.name }).from(agents),
  ]);
  const byId = (rows: { id: number; name: string }[]) =>
    new Map(rows.map((row) => [row.id, row.name]));
  return { proxyHost: byId(hosts), l4ProxyHost: byId(l4), agent: byId(agentRows) };
}

async function grantItems(groupIds: readonly number[] | null): Promise<ItemDraft[]> {
  if (groupIds && groupIds.length === 0) return [];
  const rows = await db
    .select({
      groupId: groupGrants.groupId,
      groupName: groups.name,
      proxyHostId: groupGrants.proxyHostId,
      l4ProxyHostId: groupGrants.l4ProxyHostId,
      agentId: groupGrants.agentId,
      capability: groupGrants.capability,
    })
    .from(groupGrants)
    .innerJoin(groups, eq(groupGrants.groupId, groups.id))
    .where(groupIds ? inArray(groupGrants.groupId, [...groupIds]) : undefined)
    .orderBy(groups.name, groupGrants.id);
  if (rows.length === 0) return [];
  const [names, members] = await Promise.all([
    objectNames(),
    db
      .selectDistinct({ groupId: groupMembers.groupId })
      .from(groupMembers)
      .where(inArray(groupMembers.groupId, [...new Set(rows.map((row) => row.groupId))])),
  ]);
  const occupied = new Set(members.map((row) => row.groupId));
  return rows.flatMap((row) => {
    const object =
      row.proxyHostId !== null
        ? { kind: "proxyHost", id: row.proxyHostId }
        : row.l4ProxyHostId !== null
          ? { kind: "l4ProxyHost", id: row.l4ProxyHostId }
          : row.agentId !== null
            ? { kind: "agent", id: row.agentId }
            : null;
    // A row naming nothing grants nothing (models/group-grants.ts).
    if (!object) return [];
    return [
      {
        ...blank("grant", row.groupName),
        groupId: row.groupId,
        objectKind: object.kind,
        objectId: object.id,
        targetLabel: names[object.kind]?.get(object.id) ?? `#${object.id}`,
        current: row.capability === "manage" ? "manage" : "view",
        hints: occupied.has(row.groupId) ? [] : (["groupEmpty"] as Hint[]),
      },
    ];
  });
}

async function tokenItems(now: number): Promise<ItemDraft[]> {
  const rows = await db.select().from(apiTokens).orderBy(apiTokens.name);
  const owners = await activePeople([...new Set(rows.map((row) => row.createdBy))]);
  return rows.flatMap((row) => {
    const owner = owners.get(row.createdBy);
    // An expired token, or one whose owner is disabled, already opens nothing.
    if (!owner || (row.expiresAt && Date.parse(row.expiresAt) <= now)) return [];
    const hints: Hint[] = unusedFor(row.lastUsedAt, toIso(row.createdAt), now)
      ? ["tokenUnused"]
      : [];
    return [
      {
        ...blank("token", row.name),
        userId: owner.id,
        tokenId: row.id,
        targetLabel: owner.email,
        hints: [...hints, ...personHints(owner, now)],
      },
    ];
  });
}

async function connectionItems(now: number): Promise<ItemDraft[]> {
  const rows = await db.select().from(scimConnections).orderBy(scimConnections.name);
  return rows.map((row) => ({
    ...blank("scimConnection", row.name),
    connectionId: row.id,
    current: row.enabled ? "enabled" : "disabled",
    hints: unusedFor(row.lastUsedAt, row.createdAt, now) ? (["connectionUnused"] as Hint[]) : [],
  }));
}

/** The scope's reference, checked: a role that exists, or a group's id. */
export async function checkScope(
  scope: ReviewScope,
  scopeRef: string | null | undefined,
): Promise<string | null> {
  if (scope === "role") {
    if (!scopeRef || !(await getRole(scopeRef))) {
      throw domainError("accessReviewScopeInvalid", {}, { status: 400 });
    }
    return scopeRef;
  }
  if (scope === "group") {
    const id = Number(scopeRef);
    const [row] = Number.isInteger(id)
      ? await db.select({ id: groups.id }).from(groups).where(eq(groups.id, id)).limit(1)
      : [];
    if (!row) throw domainError("accessReviewScopeInvalid", {}, { status: 400 });
    return String(row.id);
  }
  return null;
}

export async function collectItems(
  scope: ReviewScope,
  scopeRef: string | null,
  now = Date.now(),
): Promise<ItemDraft[]> {
  switch (scope) {
    case "allUsers": {
      const people = await activePeople();
      const managed = await scimManagedUserIds([...people.keys()]);
      return [...roleItems(people.values(), managed, now), ...(await membershipItems(null, now))];
    }
    case "role": {
      const people = [...(await activePeople()).values()].filter((p) => p.role === scopeRef);
      const managed = await scimManagedUserIds(people.map((person) => person.id));
      // Whoever holds the role through a group holds it too.
      const carrying = await db
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.role, scopeRef ?? ""));
      return [
        ...roleItems(people, managed, now),
        ...(await membershipItems(
          carrying.map((row) => row.id),
          now,
        )),
      ];
    }
    case "group": {
      const id = Number(scopeRef);
      return [...(await membershipItems([id], now)), ...(await grantItems([id]))];
    }
    case "grants":
      return grantItems(null);
    case "tokens":
      return tokenItems(now);
    case "scim":
      return connectionItems(now);
  }
}

/** Whose access an item is: a reviewer is never handed their own. */
function ownerOf(item: ItemDraft): number | null {
  return item.kind === "role" || item.kind === "membership" || item.kind === "token"
    ? item.userId
    : null;
}

/**
 * Round robin by whose access it is, so one person's items stay with one reviewer. An item whose
 * only reviewer is its subject goes to the campaign's author, or to nobody until reassigned.
 */
export function assignReviewers(
  items: readonly ItemDraft[],
  reviewerIds: readonly number[],
  fallback: number,
): (number | null)[] {
  const chosen = new Map<string, number | null>();
  let next = 0;
  return items.map((item) => {
    const owner = ownerOf(item);
    const key =
      owner !== null
        ? `u${owner}`
        : item.groupId !== null
          ? `g${item.groupId}`
          : `c${item.connectionId}`;
    const known = chosen.get(key);
    if (known !== undefined) return known;
    let pick: number | null = null;
    for (let tried = 0; tried < reviewerIds.length; tried++) {
      const candidate = reviewerIds[(next + tried) % reviewerIds.length];
      if (candidate !== owner) {
        pick = candidate;
        next = (next + tried + 1) % reviewerIds.length;
        break;
      }
    }
    if (pick === null && fallback !== owner) pick = fallback;
    chosen.set(key, pick);
    return pick;
  });
}
