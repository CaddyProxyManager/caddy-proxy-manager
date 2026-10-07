/**
 * SCIM connections: one per identity provider, each with its own bearer token, separate from API
 * tokens in both directions. Issued by whoever may manage both users and groups, since the token
 * creates the first and fills the second; every role its mapping hands out is checked against its
 * issuer. The plugin knows a connection only by id (verifyBearerToken in ./plugin.ts).
 */
import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import db, { nowIso, runInTransaction } from "../db";
import {
  groups,
  roles,
  scimConnections,
  scimGroups,
  scimRoleMappings,
  scimUsers,
  schemaDialect,
} from "../db/schema";
import { logAuditEvent } from "../audit";
import { diffAuditRecords } from "../audit/changes";
import { domainError } from "../errors/domain-error";
import { splitGroupList } from "../auth/oidc/groups";
import { type CapabilitySet, holds } from "../roles/capabilities";
import { type RoleGroups, rankedRoleGroups, roleForGroupNames } from "../roles/mappings";
import { assertMayAssignRole } from "../roles/store";

export const SCIM_TOKEN_PREFIX = "cpm_scim_";
const NAME_MAX_LENGTH = 100;
const LAST_USED_DEBOUNCE_MS = 60_000;

export type ScimConnection = {
  id: number;
  name: string;
  enabled: boolean;
  tokenHint: string;
  linkExisting: boolean;
  /** Role key to the provisioned group names that give a group that role. */
  roleGroups: RoleGroups;
  users: number;
  groups: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  tokenRotatedAt: string | null;
};

export type ScimConnectionInput = {
  name: string;
  enabled?: boolean;
  linkExisting?: boolean;
  roleGroups?: RoleGroups;
};

export type ScimActor = { userId: number; capabilities: CapabilitySet };

type Row = typeof scimConnections.$inferSelect;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): { token: string; tokenHash: string; tokenHint: string } {
  const token = SCIM_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token), tokenHint: token.slice(-4) };
}

/** Under SQLite the plugin is not loaded, so a connection would be a token for nothing. */
function assertSupported(): void {
  if (schemaDialect !== "postgres") {
    throw domainError("scimNeedsPostgres", {}, { status: 400 });
  }
}

export async function scimRoleGroupsFor(
  connectionIds: readonly number[],
): Promise<Map<number, RoleGroups>> {
  if (connectionIds.length === 0) return new Map();
  const rows = await db
    .select({
      key: scimRoleMappings.connectionId,
      role: scimRoleMappings.role,
      name: scimRoleMappings.externalName,
      roleId: roles.id,
    })
    .from(scimRoleMappings)
    .leftJoin(roles, eq(roles.key, scimRoleMappings.role))
    .where(inArray(scimRoleMappings.connectionId, [...connectionIds]))
    .orderBy(asc(scimRoleMappings.id));
  return rankedRoleGroups(rows, connectionIds);
}

/** The role a provisioned group named `displayName` gives its members, from its connection. */
export async function mappedGroupRole(
  connectionId: number,
  displayName: string,
): Promise<string | null> {
  const roleGroups = (await scimRoleGroupsFor([connectionId])).get(connectionId) ?? {};
  return roleForGroupNames(roleGroups, [displayName]);
}

export async function linksExistingAccounts(connectionId: number): Promise<boolean> {
  const [row] = await db
    .select({ linkExisting: scimConnections.linkExisting })
    .from(scimConnections)
    .where(eq(scimConnections.id, connectionId))
    .limit(1);
  return row?.linkExisting ?? false;
}

/** The plugin keys its rows by the connection id as text. */
async function countsBy(table: typeof scimUsers | typeof scimGroups): Promise<Map<number, number>> {
  if (schemaDialect !== "postgres") return new Map();
  const rows = await db
    .select({ id: table.connectionId, value: count() })
    .from(table)
    .groupBy(table.connectionId);
  return new Map(rows.map((row) => [Number(row.id), Number(row.value)]));
}

function toConnection(
  row: Row,
  roleGroups: RoleGroups,
  userCount: number,
  groupCount: number,
): ScimConnection {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    tokenHint: row.tokenHint,
    linkExisting: row.linkExisting,
    roleGroups,
    users: userCount,
    groups: groupCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
    tokenRotatedAt: row.tokenRotatedAt,
  };
}

export async function listScimConnections(): Promise<ScimConnection[]> {
  const rows = await db.select().from(scimConnections).orderBy(asc(scimConnections.name));
  const [mappings, userCounts, groupCounts] = await Promise.all([
    scimRoleGroupsFor(rows.map((row) => row.id)),
    countsBy(scimUsers),
    countsBy(scimGroups),
  ]);
  return rows.map((row) =>
    toConnection(
      row,
      mappings.get(row.id) ?? {},
      userCounts.get(row.id) ?? 0,
      groupCounts.get(row.id) ?? 0,
    ),
  );
}

export async function getScimConnection(id: number): Promise<ScimConnection | null> {
  return (await listScimConnections()).find((connection) => connection.id === id) ?? null;
}

async function existingRow(id: number): Promise<Row> {
  const [row] = await db.select().from(scimConnections).where(eq(scimConnections.id, id)).limit(1);
  if (!row) throw domainError("scimConnectionNotFound", {}, { status: 404 });
  return row;
}

/** The token makes accounts and fills groups, so issuing one is for whoever may do both. */
function assertMayIssue(actor: ScimActor): void {
  assertSupported();
  if (!holds(actor.capabilities, "users:write") || !holds(actor.capabilities, "groups:write")) {
    throw domainError("scimConnectionNeedsUsersAndGroups", {}, { status: 403 });
  }
}

type Checked = { name: string; enabled: boolean; linkExisting: boolean; roleGroups: RoleGroups };

async function checkInput(
  input: ScimConnectionInput,
  actor: ScimActor,
  current: Row | null,
): Promise<Checked> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw domainError("scimConnectionNameRequired", {}, { status: 400 });
  if (name.length > NAME_MAX_LENGTH) {
    throw domainError("scimConnectionNameTooLong", { max: NAME_MAX_LENGTH }, { status: 400 });
  }
  const [clash] = await db
    .select({ id: scimConnections.id })
    .from(scimConnections)
    .where(eq(scimConnections.name, name))
    .limit(1);
  if (clash && clash.id !== current?.id) {
    throw domainError("scimConnectionNameTaken", {}, { status: 409 });
  }
  const enabled = input.enabled ?? current?.enabled ?? true;
  const linkExisting = input.linkExisting ?? current?.linkExisting ?? true;

  // Left out, the mappings stay as they are, unchecked: nothing is being handed out.
  if (input.roleGroups === undefined && current) {
    const roleGroups = (await scimRoleGroupsFor([current.id])).get(current.id) ?? {};
    return { name, enabled, linkExisting, roleGroups };
  }
  const roleGroups: RoleGroups = {};
  for (const [role, names] of Object.entries(input.roleGroups ?? {})) {
    const list = splitGroupList((names ?? []).join(","));
    if (list.length === 0) continue;
    // Groups cannot give admin, and a provisioned one is no different.
    if (role === "admin") throw domainError("groupRoleAdmin", {}, { status: 400 });
    await assertMayAssignRole(actor.capabilities, role);
    roleGroups[role] = list;
  }
  return { name, enabled, linkExisting, roleGroups };
}

function mappingRows(connectionId: number, roleGroups: RoleGroups, now: string) {
  return Object.entries(roleGroups).flatMap(([role, names]) =>
    names.map((externalName) => ({ connectionId, role, externalName, createdAt: now })),
  );
}

/** CPM's twins of the connection's provisioned groups. */
async function mirroredGroups(connectionId: number) {
  return db
    .select({ id: groups.id, name: groups.name, role: groups.role })
    .from(groups)
    .innerJoin(scimGroups, eq(groups.scimGroupId, sql`cast(${scimGroups.id} as text)`))
    .where(and(eq(groups.source, "scim"), eq(scimGroups.connectionId, String(connectionId))));
}

/** A changed mapping reaches the groups the connection already provisioned at once. */
async function reprojectGroupRoles(connectionId: number, roleGroups: RoleGroups): Promise<void> {
  const changed = (await mirroredGroups(connectionId))
    .map((group) => ({ ...group, wanted: roleForGroupNames(roleGroups, [group.name]) }))
    .filter((group) => group.wanted !== group.role);
  if (changed.length === 0) return;
  const now = nowIso();
  await runInTransaction((tx) =>
    changed.map((group) =>
      tx.update(groups).set({ role: group.wanted, updatedAt: now }).where(eq(groups.id, group.id)),
    ),
  );
}

export async function createScimConnection(
  input: ScimConnectionInput,
  actor: ScimActor,
): Promise<{ connection: ScimConnection; token: string }> {
  assertMayIssue(actor);
  const checked = await checkInput(input, actor, null);
  const { token, tokenHash, tokenHint } = newToken();
  const now = nowIso();
  const [row] = await db
    .insert(scimConnections)
    .values({
      name: checked.name,
      enabled: checked.enabled,
      tokenHash,
      tokenHint,
      linkExisting: checked.linkExisting,
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const mappings = mappingRows(row.id, checked.roleGroups, now);
  if (mappings.length > 0) await db.insert(scimRoleMappings).values(mappings);
  await logAuditEvent({
    userId: actor.userId,
    action: "create",
    entityType: "scim_connection",
    entityId: row.id,
    summary: `Created SCIM connection ${row.name}`,
    data: { linkExisting: checked.linkExisting, roleGroups: checked.roleGroups },
  });
  return { connection: toConnection(row, checked.roleGroups, 0, 0), token };
}

export async function updateScimConnection(
  id: number,
  input: ScimConnectionInput,
  actor: ScimActor,
): Promise<ScimConnection> {
  assertMayIssue(actor);
  const current = await existingRow(id);
  const checked = await checkInput(input, actor, current);
  const before = (await scimRoleGroupsFor([id])).get(id) ?? {};
  const now = nowIso();
  await runInTransaction((tx) => {
    const mappings = mappingRows(id, checked.roleGroups, now);
    return [
      tx
        .update(scimConnections)
        .set({
          name: checked.name,
          enabled: checked.enabled,
          linkExisting: checked.linkExisting,
          updatedAt: now,
        })
        .where(eq(scimConnections.id, id)),
      tx.delete(scimRoleMappings).where(eq(scimRoleMappings.connectionId, id)),
      ...(mappings.length > 0 ? [tx.insert(scimRoleMappings).values(mappings)] : []),
    ];
  });
  await reprojectGroupRoles(id, checked.roleGroups);
  await logAuditEvent({
    userId: actor.userId,
    action: "update",
    entityType: "scim_connection",
    entityId: id,
    summary: `Updated SCIM connection ${checked.name}`,
    changes: diffAuditRecords(
      {
        name: current.name,
        enabled: current.enabled,
        linkExisting: current.linkExisting,
        roleGroups: JSON.stringify(before),
      },
      {
        name: checked.name,
        enabled: checked.enabled,
        linkExisting: checked.linkExisting,
        roleGroups: JSON.stringify(checked.roleGroups),
      },
    ),
  });
  return (await getScimConnection(id)) as ScimConnection;
}

/** The old token stops working at once: an identity provider takes the new one in one step. */
export async function rotateScimConnectionToken(
  id: number,
  actor: ScimActor,
): Promise<{ connection: ScimConnection; token: string }> {
  assertMayIssue(actor);
  const current = await existingRow(id);
  const { token, tokenHash, tokenHint } = newToken();
  const now = nowIso();
  await db
    .update(scimConnections)
    .set({ tokenHash, tokenHint, tokenRotatedAt: now, updatedAt: now })
    .where(eq(scimConnections.id, id));
  await logAuditEvent({
    userId: actor.userId,
    action: "update",
    entityType: "scim_connection",
    entityId: id,
    summary: `Rotated the token of SCIM connection ${current.name}`,
  });
  return { connection: (await getScimConnection(id)) as ScimConnection, token };
}

/**
 * Its groups are handed to the Groups page first, members and all, since nothing would update
 * them any more; then the plugin retires the connection, which signs its accounts out but leaves
 * them enabled (reconcileAccount ignores an account with no source left).
 */
export async function deleteScimConnection(id: number, actor: ScimActor): Promise<void> {
  assertMayIssue(actor);
  const current = await existingRow(id);
  const owned = await mirroredGroups(id);
  const now = nowIso();
  if (owned.length > 0) {
    await db
      .update(groups)
      .set({ source: "ui", scimGroupId: null, updatedAt: now })
      .where(
        inArray(
          groups.id,
          owned.map((group) => group.id),
        ),
      );
  }
  const [{ getScimAuth }, { SCIM_DOMAIN }] = await Promise.all([
    import("./auth"),
    import("./plugin"),
  ]);
  const api = (await getScimAuth()).api as unknown as {
    decommissionSCIMConnection: (input: {
      body: { connectionId: string; provisioningDomainId: string };
    }) => Promise<unknown>;
  };
  await api.decommissionSCIMConnection({
    body: { connectionId: String(id), provisioningDomainId: SCIM_DOMAIN },
  });
  await db.delete(scimConnections).where(eq(scimConnections.id, id));
  await logAuditEvent({
    userId: actor.userId,
    action: "delete",
    entityType: "scim_connection",
    entityId: id,
    summary: `Deleted SCIM connection ${current.name}`,
  });
}

/** The enabled connection a bearer token belongs to, or null. API tokens never match. */
export async function authenticateScimToken(
  token: string,
): Promise<{ id: number; name: string } | null> {
  if (!token.startsWith(SCIM_TOKEN_PREFIX)) return null;
  const [row] = await db
    .select()
    .from(scimConnections)
    .where(eq(scimConnections.tokenHash, hashToken(token)))
    .limit(1);
  if (!row?.enabled) return null;
  const lastUsed = row.lastUsedAt ? Date.parse(row.lastUsedAt) : 0;
  if (Date.now() - lastUsed > LAST_USED_DEBOUNCE_MS) {
    await db
      .update(scimConnections)
      .set({ lastUsedAt: nowIso() })
      .where(eq(scimConnections.id, row.id));
  }
  return { id: row.id, name: row.name };
}
