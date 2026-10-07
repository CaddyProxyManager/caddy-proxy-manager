/**
 * Which identity-provider groups give which role, per OIDC provider or LDAP directory. One row a
 * name; the order rows were written is the order a form shows them back.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import db, { nowIso, runInTransaction } from "../db";
import { roleMappings, roles } from "../db/schema";
import { normalizeGroupName, splitGroupList } from "../auth/oidc/groups";
import { domainError } from "../errors/domain-error";
import { BUILT_IN_ROLE_KEYS, isBuiltInRoleKey } from "./built-in";

/** Role key to the group names that give it, as typed. Insertion order is precedence order. */
export type RoleGroups = Record<string, string[]>;

/** The built-in roles' names as comma lists, the shape forms and the REST API have always used. */
export type LegacyRoleColumns = {
  adminGroup: string | null;
  operatorGroup: string | null;
  userGroup: string | null;
  viewerGroup: string | null;
};

const LEGACY: ReadonlyArray<readonly [keyof LegacyRoleColumns, string]> = [
  ["adminGroup", "admin"],
  ["operatorGroup", "operator"],
  ["userGroup", "user"],
  ["viewerGroup", "viewer"],
];

export function legacyColumns(groups: RoleGroups): LegacyRoleColumns {
  return Object.fromEntries(
    LEGACY.map(([column, role]) => [column, groups[role]?.length ? groups[role].join(", ") : null]),
  ) as LegacyRoleColumns;
}

/** The legacy fields present in an input, as role groups; an absent field leaves its role alone. */
export function fromLegacyColumns(input: Partial<LegacyRoleColumns>): RoleGroups {
  const groups: RoleGroups = {};
  for (const [column, role] of LEGACY) {
    if (input[column] !== undefined) groups[role] = splitGroupList(input[column]);
  }
  return groups;
}

/**
 * Per provider: built-in roles first in rank order, then the others in the order they were made,
 * which is how `mapGroupsToRole` ranks them when several match.
 */
export async function roleGroupsFor(
  providerIds: readonly string[],
): Promise<Map<string, RoleGroups>> {
  if (providerIds.length === 0) return new Map();
  const rows = await db
    .select({
      key: roleMappings.providerId,
      role: roleMappings.role,
      name: roleMappings.externalName,
      roleId: roles.id,
    })
    .from(roleMappings)
    .leftJoin(roles, eq(roles.key, roleMappings.role))
    .where(inArray(roleMappings.providerId, [...providerIds]))
    .orderBy(asc(roleMappings.id));
  return rankedRoleGroups(rows, providerIds);
}

/** Mapping rows, oldest first, as role groups per key in the precedence `roleGroupsFor` gives. */
export function rankedRoleGroups<K>(
  rows: ReadonlyArray<{ key: K; role: string; name: string; roleId: number | null }>,
  keys: readonly K[],
): Map<K, RoleGroups> {
  const result = new Map<K, RoleGroups>(keys.map((key) => [key, {}]));
  const rank = (row: (typeof rows)[number]) => {
    const builtIn = (BUILT_IN_ROLE_KEYS as readonly string[]).indexOf(row.role);
    return builtIn >= 0
      ? builtIn - BUILT_IN_ROLE_KEYS.length
      : (row.roleId ?? Number.MAX_SAFE_INTEGER);
  };
  const sorted = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index);
  for (const { row } of sorted) {
    const groups = result.get(row.key);
    if (!groups) continue;
    groups[row.role] ??= [];
    groups[row.role].push(row.name);
  }
  return result;
}

/** The first role, in precedence order, one of whose names is among `names`; as OIDC compares. */
export function roleForGroupNames(groups: RoleGroups, names: readonly string[]): string | null {
  const comparable = (value: string) => normalizeGroupName(value).toLowerCase();
  const held = new Set(names.map(comparable));
  for (const [role, roleNames] of Object.entries(groups)) {
    if (roleNames.some((name) => held.has(comparable(name)))) return role;
  }
  return null;
}

export async function roleGroupsOf(providerId: string): Promise<RoleGroups> {
  return (await roleGroupsFor([providerId])).get(providerId) ?? {};
}

/** Replaces the names of each role named in `groups`; roles it leaves out keep theirs. */
export async function setRoleGroups(providerId: string, groups: RoleGroups): Promise<void> {
  const current = await roleGroupsOf(providerId);
  const wanted = Object.fromEntries(
    Object.entries(groups).map(([role, names]) => [role, splitGroupList(names.join(","))]),
  );
  // Only what changes is rewritten, so saving an untouched form writes nothing.
  const keys = Object.keys(wanted).filter(
    (role) => JSON.stringify(wanted[role]) !== JSON.stringify(current[role] ?? []),
  );
  if (keys.length === 0) return;
  const custom = keys.filter((key) => !isBuiltInRoleKey(key) && wanted[key].length > 0);
  if (custom.length > 0) {
    const known = await db.select({ key: roles.key }).from(roles).where(inArray(roles.key, custom));
    if (known.length !== custom.length) throw domainError("invalidUserRole", {}, { status: 400 });
  }
  const now = nowIso();
  await runInTransaction((tx) => [
    tx
      .delete(roleMappings)
      .where(and(eq(roleMappings.providerId, providerId), inArray(roleMappings.role, keys))),
    ...keys.flatMap((role) =>
      wanted[role].length === 0
        ? []
        : [
            tx.insert(roleMappings).values(
              wanted[role].map((externalName) => ({
                providerId,
                role,
                externalName,
                createdAt: now,
              })),
            ),
          ],
    ),
  ]);
}

/** Rows with their role groups attached, both as a map and as the built-in roles' comma lists. */
export async function withRoleGroups<T extends { id: string }>(
  rows: readonly T[],
): Promise<Array<T & LegacyRoleColumns & { roleGroups: RoleGroups }>> {
  const groups = await roleGroupsFor(rows.map((row) => row.id));
  return rows.map((row) => {
    const roleGroups = groups.get(row.id) ?? {};
    return { ...row, ...legacyColumns(roleGroups), roleGroups };
  });
}

/** What an input asks for: the built-in roles' comma lists, then any role named in `roleGroups`. */
export function requestedRoleGroups(
  input: Partial<LegacyRoleColumns> & { roleGroups?: RoleGroups | null },
): RoleGroups {
  return { ...fromLegacyColumns(input), ...(input.roleGroups ?? {}) };
}

/**
 * A backup or legacy database from before `role_mappings` kept each provider's role groups as
 * comma lists on the provider: as rows here, ids and order as the migration that moved them.
 */
export function legacyRoleMappings(
  providers: Record<string, unknown>[] | undefined,
): Record<string, unknown>[] | undefined {
  if (!providers?.some((row) => "adminGroup" in row)) return undefined;
  const columns = [
    ["adminGroup", "admin"],
    ["operatorGroup", "operator"],
    ["userGroup", "user"],
    ["viewerGroup", "viewer"],
  ] as const;
  const sorted = [...providers].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
  return sorted
    .flatMap((provider) =>
      columns.flatMap(([column, role]) =>
        splitGroupList(typeof provider[column] === "string" ? provider[column] : null).map(
          (externalName) => ({
            providerId: provider.id,
            role,
            externalName,
            createdAt: provider.updatedAt,
          }),
        ),
      ),
    )
    .map((row, index) => ({ id: index + 1, ...row }));
}
