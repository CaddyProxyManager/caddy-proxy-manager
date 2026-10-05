/**
 * What an API token may do, beside its owner's role. A scope only ever narrows: every route and
 * resolver still checks the role, and a token passes only where both agree. No server imports, so
 * the Profile form can list the areas.
 */
import { domainError } from "../errors/domain-error";

/** Each area names the screens and API resources an administrator would recognise. */
export const TOKEN_AREAS = [
  "overview",
  "hosts",
  "accessLists",
  "certificates",
  "security",
  "analytics",
  "agents",
  "users",
  "settings",
  "audit",
  "tokens",
] as const;

export type TokenArea = (typeof TOKEN_AREAS)[number];

export type TokenAccess = "read" | "write";

export type TokenPermission = `${TokenArea}:${TokenAccess}`;

export const TOKEN_SCOPE_KINDS = ["full", "read", "custom"] as const;

export type TokenScopeKind = (typeof TOKEN_SCOPE_KINDS)[number];

export type TokenScope =
  | { kind: "full" }
  | { kind: "read" }
  | { kind: "custom"; permissions: TokenPermission[] };

export const FULL_SCOPE: TokenScope = { kind: "full" };

const PERMISSIONS: ReadonlySet<string> = new Set(
  TOKEN_AREAS.flatMap((area) => [`${area}:read`, `${area}:write`]),
);

export function isTokenPermission(value: unknown): value is TokenPermission {
  return typeof value === "string" && PERMISSIONS.has(value);
}

/** Write implies read, as a manage grant implies view. */
export function scopeAllows(scope: TokenScope, area: TokenArea, access: TokenAccess): boolean {
  if (scope.kind === "full") return true;
  if (scope.kind === "read") return access === "read";
  return (
    scope.permissions.includes(`${area}:write`) ||
    (access === "read" && scope.permissions.includes(`${area}:read`))
  );
}

/** Deduplicated, a write dropping its own read, in area order so a stored list compares equal. */
function normalizePermissions(values: readonly TokenPermission[]): TokenPermission[] {
  const set = new Set(values);
  return TOKEN_AREAS.flatMap((area): TokenPermission[] =>
    set.has(`${area}:write`) ? [`${area}:write`] : set.has(`${area}:read`) ? [`${area}:read`] : [],
  );
}

/** Input from a form, REST or GraphQL. Unset is full scope, today's behaviour. */
export function parseTokenScope(scope: unknown, permissions: unknown): TokenScope {
  if (scope === undefined || scope === null || scope === "" || scope === "full") return FULL_SCOPE;
  if (scope === "read") return { kind: "read" };
  if (scope !== "custom") {
    throw domainError("apiTokenScopeInvalid", {}, { status: 400 });
  }
  const list = Array.isArray(permissions) ? permissions : [];
  const invalid = list.filter((value) => !isTokenPermission(value));
  if (invalid.length > 0) {
    throw domainError(
      "apiTokenPermissionInvalid",
      { permissions: invalid.map(String) },
      { status: 400 },
    );
  }
  const normalized = normalizePermissions(list as TokenPermission[]);
  if (normalized.length === 0) {
    throw domainError("apiTokenPermissionsRequired", {}, { status: 400 });
  }
  return { kind: "custom", permissions: normalized };
}

/** From the stored columns. Anything unreadable grants nothing rather than everything. */
export function scopeFromColumns(scope: string, permissions: string | null): TokenScope {
  if (scope === "full") return FULL_SCOPE;
  if (scope === "read") return { kind: "read" };
  let list: unknown = [];
  try {
    list = permissions ? JSON.parse(permissions) : [];
  } catch {
    list = [];
  }
  return {
    kind: "custom",
    permissions: normalizePermissions((Array.isArray(list) ? list : []).filter(isTokenPermission)),
  };
}

/** Flat, as REST and GraphQL show a token: `permissions` is empty unless the scope is custom. */
export function flattenScope(scope: TokenScope): {
  scope: TokenScopeKind;
  permissions: TokenPermission[];
} {
  return { scope: scope.kind, permissions: scope.kind === "custom" ? scope.permissions : [] };
}

export function unflattenScope(flat: {
  scope: TokenScopeKind;
  permissions: readonly TokenPermission[];
}): TokenScope {
  return flat.scope === "custom"
    ? { kind: "custom", permissions: [...flat.permissions] }
    : { kind: flat.scope };
}

export function scopeToColumns(scope: TokenScope): { scope: string; permissions: string | null } {
  return {
    scope: scope.kind,
    permissions: scope.kind === "custom" ? JSON.stringify(scope.permissions) : null,
  };
}
