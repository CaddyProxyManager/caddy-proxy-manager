/**
 * The roles an administrator defines, beside the four built-in ones. A role can be handed out, or
 * have its capabilities set, only by someone who holds all of them outright, so a role is never a
 * way to more than its author has; and one in use cannot be deleted.
 */

import { randomBytes } from "node:crypto";
import { asc, eq, inArray, sql } from "drizzle-orm";
import db, { nowIso } from "../db";
import { groups, oauthProviders, roleMappings, roles, scimRoleMappings, users } from "../db/schema";
import { logAuditEvent } from "../audit";
import { diffAuditRecords } from "../audit/changes";
import { domainError } from "../errors/domain-error";
import { BUILT_IN_ROLES, BUILT_IN_ROLE_KEYS, isBuiltInRoleKey, isMadeRoleKey } from "./built-in";
import {
  type Capability,
  type CapabilitySet,
  type RoleDefinition,
  covers,
  normalizeCapabilities,
} from "./capabilities";

export const ROLE_NAME_MAX_LENGTH = 60;
export const ROLE_DESCRIPTION_MAX_LENGTH = 300;

export type Role = RoleDefinition & {
  /** Null for a built-in role, which is not stored. */
  id: number | null;
  /** Null for a built-in role, whose name is the reader's language's. */
  name: string | null;
  description: string | null;
  builtIn: boolean;
};

export type RoleUsage = { users: number; groups: number; mappings: number; providers: number };

export type RoleInput = {
  name: string;
  description?: string | null;
  capabilities: readonly unknown[];
  scoped?: boolean;
};

type Row = typeof roles.$inferSelect;

function builtIn(key: (typeof BUILT_IN_ROLE_KEYS)[number]): Role {
  return { ...BUILT_IN_ROLES[key], id: null, name: null, description: null, builtIn: true };
}

function parseCapabilities(stored: string): Capability[] {
  try {
    const parsed: unknown = JSON.parse(stored);
    // Unreadable or unknown entries grant nothing, which is the safe direction.
    return normalizeCapabilities(Array.isArray(parsed) ? parsed : []);
  } catch {
    return [];
  }
}

function fromRow(row: Row): Role {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    capabilities: parseCapabilities(row.capabilities),
    scoped: row.scoped,
    builtIn: false,
  };
}

/** The built-in roles first, in rank order, then the rest in the order they were made. */
export async function listRoles(): Promise<Role[]> {
  const rows = await db.select().from(roles).orderBy(asc(roles.id));
  return [...BUILT_IN_ROLE_KEYS.map(builtIn), ...rows.map(fromRow)];
}

/** The shape `newKey` makes. */
export const isCustomRoleKey = isMadeRoleKey;

export async function getRole(key: string): Promise<Role | null> {
  if (isBuiltInRoleKey(key)) return builtIn(key);
  if (!isCustomRoleKey(key)) return null;
  const row = await db.query.roles.findFirst({
    where: (table, { eq: equals }) => equals(table.key, key),
  });
  return row ? fromRow(row) : null;
}

/** Stored roles for these keys, unknown keys left out: a role that does not exist holds nothing. */
export async function storedRoleDefinitions(keys: readonly string[]): Promise<RoleDefinition[]> {
  const wanted = keys.filter(isCustomRoleKey);
  if (wanted.length === 0) return [];
  const rows = await db.select().from(roles).where(inArray(roles.key, wanted));
  return rows.map(fromRow);
}

export async function isKnownRole(key: unknown): Promise<boolean> {
  return typeof key === "string" && (await getRole(key)) !== null;
}

export async function roleUsage(key: string): Promise<RoleUsage> {
  const count = sql<number>`count(*)`;
  const [[userRows], [groupRows], [mappingRows], [scimRows], [providerRows]] = await Promise.all([
    db.select({ value: count }).from(users).where(eq(users.role, key)),
    db.select({ value: count }).from(groups).where(eq(groups.role, key)),
    db.select({ value: count }).from(roleMappings).where(eq(roleMappings.role, key)),
    db.select({ value: count }).from(scimRoleMappings).where(eq(scimRoleMappings.role, key)),
    db.select({ value: count }).from(oauthProviders).where(eq(oauthProviders.defaultRole, key)),
  ]);
  return {
    users: Number(userRows?.value ?? 0),
    groups: Number(groupRows?.value ?? 0),
    // A SCIM connection's mapping hands a role out as an identity provider's does.
    mappings: Number(mappingRows?.value ?? 0) + Number(scimRows?.value ?? 0),
    providers: Number(providerRows?.value ?? 0),
  };
}

/**
 * Whoever hands a role out must hold all of it outright, or a role would be a way to more than
 * its giver has.
 */
export async function assertMayAssignRole(holding: CapabilitySet, key: string): Promise<Role> {
  const role = await getRole(key);
  if (!role) throw domainError("invalidUserRole", {}, { status: 400 });
  if (!covers(holding, role)) throw domainError("roleExceedsYours", {}, { status: 403 });
  return role;
}

/**
 * Acting on another account (its role, status, password or second factor) is for whoever holds
 * at least what that account does, so a role that manages users cannot be turned on an
 * administrator.
 */
export async function assertMayManageAccount(
  holding: CapabilitySet,
  roleKey: string,
): Promise<void> {
  const role = await getRole(roleKey);
  // An unknown role holds nothing, so anyone who may manage users may manage the account.
  if (role && !covers(holding, role)) {
    throw domainError("accountExceedsYours", {}, { status: 403 });
  }
}

function cleanInput(input: RoleInput): {
  name: string;
  description: string | null;
  capabilities: Capability[];
  scoped: boolean;
} {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > ROLE_NAME_MAX_LENGTH) {
    throw domainError("roleNameInvalid", { max: ROLE_NAME_MAX_LENGTH }, { status: 400 });
  }
  const description =
    typeof input.description === "string" && input.description.trim()
      ? input.description.trim()
      : null;
  if (description && description.length > ROLE_DESCRIPTION_MAX_LENGTH) {
    throw domainError(
      "roleDescriptionTooLong",
      { max: ROLE_DESCRIPTION_MAX_LENGTH },
      { status: 400 },
    );
  }
  const unknown = (input.capabilities ?? []).filter(
    (value) => normalizeCapabilities([value]).length === 0,
  );
  if (unknown.length > 0) {
    throw domainError(
      "roleCapabilityInvalid",
      { capabilities: unknown.map(String) },
      { status: 400 },
    );
  }
  return {
    name,
    description,
    capabilities: normalizeCapabilities(input.capabilities ?? []),
    scoped: input.scoped === true,
  };
}

/** Names compare without case, and a built-in key counts as taken. */
async function assertNameFree(name: string, exceptKey?: string): Promise<void> {
  const lowered = name.toLowerCase();
  if ((BUILT_IN_ROLE_KEYS as readonly string[]).includes(lowered)) {
    throw domainError("roleNameTaken", {}, { status: 409 });
  }
  const rows = await db.select({ key: roles.key, name: roles.name }).from(roles);
  if (rows.some((row) => row.key !== exceptKey && row.name.toLowerCase() === lowered)) {
    throw domainError("roleNameTaken", {}, { status: 409 });
  }
}

function newKey(): string {
  // Stable for the role's life whatever it is renamed to; never one of the built-in keys.
  return `role-${randomBytes(6).toString("hex")}`;
}

export async function createRole(
  input: RoleInput,
  actor: { userId: number; capabilities: CapabilitySet },
): Promise<Role> {
  const clean = cleanInput(input);
  await assertNameFree(clean.name);
  const key = newKey();
  if (!covers(actor.capabilities, { key, ...clean }))
    throw domainError("roleExceedsYours", {}, { status: 403 });
  const now = nowIso();
  const [row] = await db
    .insert(roles)
    .values({
      key,
      name: clean.name,
      description: clean.description,
      capabilities: JSON.stringify(clean.capabilities),
      scoped: clean.scoped,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: roles.id });
  await logAuditEvent({
    userId: actor.userId,
    action: "create",
    entityType: "role",
    entityId: row?.id ?? null,
    summary: `Created role ${clean.name}`,
    data: { key, capabilities: clean.capabilities, scoped: clean.scoped },
  });
  return (await getRole(key)) as Role;
}

/** The role the actor holds is not theirs to change: they could take away their own way back. */
function assertNotOwnRole(actorRole: string, key: string): void {
  if (actorRole === key) throw domainError("cannotEditOwnRole", {}, { status: 403 });
}

export async function updateRole(
  key: string,
  input: RoleInput,
  actor: { userId: number; role: string; capabilities: CapabilitySet },
): Promise<Role> {
  if (isBuiltInRoleKey(key)) throw domainError("roleBuiltIn", {}, { status: 400 });
  const existing = await getRole(key);
  if (!existing) throw domainError("roleNotFound", {}, { status: 404 });
  assertNotOwnRole(actor.role, key);
  const clean = cleanInput(input);
  await assertNameFree(clean.name, key);
  // Both: no taking away what one does not hold either, which would be acting above oneself.
  if (!covers(actor.capabilities, existing) || !covers(actor.capabilities, { key, ...clean })) {
    throw domainError("roleExceedsYours", {}, { status: 403 });
  }
  await db
    .update(roles)
    .set({
      name: clean.name,
      description: clean.description,
      capabilities: JSON.stringify(clean.capabilities),
      scoped: clean.scoped,
      updatedAt: nowIso(),
    })
    .where(eq(roles.key, key));
  await logAuditEvent({
    userId: actor.userId,
    action: "update",
    entityType: "role",
    entityId: existing.id,
    summary: `Updated role ${clean.name}`,
    data: { key },
    changes: diffAuditRecords(
      {
        name: existing.name,
        description: existing.description,
        capabilities: existing.capabilities.join(", "),
        scoped: existing.scoped,
      },
      {
        name: clean.name,
        description: clean.description,
        capabilities: clean.capabilities.join(", "),
        scoped: clean.scoped,
      },
    ),
  });
  return (await getRole(key)) as Role;
}

export async function deleteRole(
  key: string,
  actor: { userId: number; role: string; capabilities: CapabilitySet },
): Promise<void> {
  if (isBuiltInRoleKey(key)) throw domainError("roleBuiltIn", {}, { status: 400 });
  const existing = await getRole(key);
  if (!existing) throw domainError("roleNotFound", {}, { status: 404 });
  assertNotOwnRole(actor.role, key);
  if (!covers(actor.capabilities, existing))
    throw domainError("roleExceedsYours", {}, { status: 403 });
  const usage = await roleUsage(key);
  if (usage.users + usage.groups + usage.mappings + usage.providers > 0) {
    throw domainError("roleInUse", usage, { status: 409 });
  }
  await db.delete(roles).where(eq(roles.key, key));
  await logAuditEvent({
    userId: actor.userId,
    action: "delete",
    entityType: "role",
    entityId: existing.id,
    summary: `Deleted role ${existing.name}`,
    data: { key },
  });
}
