/** Pure OIDC group-claim to role/group mapping. No I/O; side effects in oidc-group-sync.ts. */

export type AppRole = "admin" | "operator" | "user" | "viewer";

export const APP_ROLES: readonly AppRole[] = ["admin", "operator", "user", "viewer"] as const;

const ROLE_SUFFIX: Record<AppRole, string> = {
  admin: "Admin",
  operator: "Operator",
  user: "User",
  viewer: "Viewer",
};

export function isAppRole(value: unknown): value is AppRole {
  return typeof value === "string" && (APP_ROLES as readonly string[]).includes(value);
}

export type GroupMappingConfig = {
  groupsClaim: string;
  groupPrefix: string | null;
  roleMappingEnabled: boolean;
  /**
   * Role key to the group names that give it. A built-in role with none falls back to
   * `<groupPrefix><Role>`; any other role needs names of its own.
   */
  roleGroups: Readonly<Record<string, readonly string[]>>;
  /** A role key: built-in, or one an administrator made. */
  defaultRole: string;
  syncGroups: boolean;
};

/** The built-in roles' comma lists, the shape providers stored before `role_mappings`. */
type LegacyRoleLists = {
  adminGroup?: string | null;
  operatorGroup?: string | null;
  userGroup?: string | null;
  viewerGroup?: string | null;
};

export function toGroupMappingConfig(
  provider: LegacyRoleLists & {
    groupsClaim?: string | null;
    groupPrefix?: string | null;
    roleMappingEnabled?: boolean | null;
    roleGroups?: Readonly<Record<string, readonly string[]>> | null;
    defaultRole?: string | null;
    syncGroups?: boolean | null;
  },
): GroupMappingConfig {
  const lists: Record<string, string[]> = {};
  for (const [column, role] of [
    ["adminGroup", "admin"],
    ["operatorGroup", "operator"],
    ["userGroup", "user"],
    ["viewerGroup", "viewer"],
  ] as const) {
    const names = splitGroupList(provider[column]);
    if (names.length > 0) lists[role] = names;
  }
  return {
    groupsClaim: provider.groupsClaim?.trim() || "groups",
    groupPrefix: provider.groupPrefix?.trim() || null,
    roleMappingEnabled: provider.roleMappingEnabled === true,
    roleGroups: { ...lists, ...(provider.roleGroups ?? {}) },
    defaultRole: provider.defaultRole?.trim() || "user",
    syncGroups: provider.syncGroups === true,
  };
}

/** The env-configured provider's mapping, as its startup sync stores it. */
export function envGroupMapping(oauth: {
  groupsClaim: string | null;
  groupPrefix: string | null;
  roleMappingEnabled: boolean;
  adminGroup: string | null;
  operatorGroup: string | null;
  userGroup: string | null;
  viewerGroup: string | null;
  defaultRole: string | null;
  syncGroups: boolean;
}) {
  return {
    groupsClaim: oauth.groupsClaim ?? "groups",
    groupPrefix: oauth.groupPrefix ?? null,
    roleMappingEnabled: oauth.roleMappingEnabled,
    adminGroup: oauth.adminGroup ?? null,
    operatorGroup: oauth.operatorGroup ?? null,
    userGroup: oauth.userGroup ?? null,
    viewerGroup: oauth.viewerGroup ?? null,
    defaultRole: isAppRole(oauth.defaultRole) ? oauth.defaultRole : ("user" as AppRole),
    syncGroups: oauth.syncGroups,
  };
}

export function needsGroupClaims(cfg: GroupMappingConfig): boolean {
  return cfg.roleMappingEnabled || cfg.syncGroups;
}

/** Strips a Keycloak path prefix ("/Parent/X" to "X"); callers compare case-insensitively. */
export function normalizeGroupName(value: string): string {
  const trimmed = value.trim();
  const lastSegment = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed;
  return lastSegment.trim();
}

function comparableGroupName(value: string): string {
  return normalizeGroupName(value).toLowerCase();
}

/** Dot-separated, so buried groups (Keycloak's `resource_access.<client>.roles`) work. */
export function readClaim(claims: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  let current: unknown = claims;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function coerceGroupEntry(entry: unknown): string | null {
  if (typeof entry === "string") return entry.trim() || null;
  if (entry && typeof entry === "object") {
    // Some IdPs return objects rather than plain strings.
    const record = entry as Record<string, unknown>;
    for (const key of ["name", "displayName", "path", "id"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

/** Only commas split a string: group names contain spaces. */
export function extractGroups(claims: Record<string, unknown>, groupsClaim: string): string[] {
  const raw = readClaim(claims, groupsClaim);
  if (raw === undefined || raw === null) return [];

  let entries: unknown[];
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        entries = Array.isArray(parsed) ? parsed : [trimmed];
      } catch {
        entries = trimmed.split(",");
      }
    } else {
      entries = trimmed.split(",");
    }
  } else {
    return [];
  }

  const seen = new Set<string>();
  const groups: string[] = [];
  for (const entry of entries) {
    const value = coerceGroupEntry(entry);
    if (!value) continue;
    const normalized = normalizeGroupName(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push(normalized);
  }
  return groups;
}

/** Commas only, as for a string claim, so names keep their spaces. */
export function parseGroupNames(value: string | null): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of value.split(",")) {
    const name = normalizeGroupName(part);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/** Commas only, trimmed, a repeat once: names as typed, for storing. */
export function splitGroupList(value: string | null | undefined): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * First match wins: `admin`, then `operator`, then the roles an administrator made in the order
 * `roleGroups` lists them, then `user` and `viewer`, which manage nothing (they are forward-auth
 * identities).
 */
export function roleOrder(cfg: GroupMappingConfig): string[] {
  const made = Object.keys(cfg.roleGroups).filter((role) => !isAppRole(role));
  return ["admin", "operator", ...made, "user", "viewer"];
}

/** Per role: its configured names, else `<groupPrefix><Role>` for a built-in one. */
export function resolveRoleGroups(cfg: GroupMappingConfig): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const role of roleOrder(cfg)) {
    const names = parseGroupNames((cfg.roleGroups[role] ?? []).join(","));
    result[role] =
      names.length > 0
        ? names
        : isAppRole(role) && cfg.groupPrefix
          ? [`${cfg.groupPrefix}${ROLE_SUFFIX[role]}`]
          : [];
  }
  return result;
}

/** `null` when off, else authoritative: no match gives `defaultRole`, so losing admin demotes. */
export function mapGroupsToRole(groups: string[], cfg: GroupMappingConfig): string | null {
  if (!cfg.roleMappingEnabled) return null;

  const claimed = new Set(groups.map(comparableGroupName));
  const roleGroups = resolveRoleGroups(cfg);
  for (const role of roleOrder(cfg)) {
    if (roleGroups[role].some((name) => claimed.has(comparableGroupName(name)))) return role;
  }
  return cfg.defaultRole;
}

/** Prefixed groups, prefix stripped, minus role groups; with no prefix, every group verbatim. */
export function mapGroupsToLocalGroups(groups: string[], cfg: GroupMappingConfig): string[] {
  if (!cfg.syncGroups) return [];

  const roleGroupNames = new Set(
    Object.values(resolveRoleGroups(cfg)).flat().map(comparableGroupName),
  );

  const prefix = cfg.groupPrefix;
  const seen = new Set<string>();
  const result: string[] = [];

  for (const group of groups) {
    const normalized = normalizeGroupName(group);
    if (!normalized) continue;
    if (cfg.roleMappingEnabled && roleGroupNames.has(normalized.toLowerCase())) continue;

    let name = normalized;
    if (prefix) {
      if (!normalized.toLowerCase().startsWith(prefix.toLowerCase())) continue;
      name = normalized.slice(prefix.length).trim();
      if (!name) continue;
    }

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }

  return result;
}
