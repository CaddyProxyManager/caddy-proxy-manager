/**
 * The four roles every instance has. They are fixed: the editor shows them and refuses changes,
 * and code may rely on `admin` holding everything. No server imports.
 */
import { CAPABILITIES, type Capability, type RoleDefinition } from "./capabilities";

export const BUILT_IN_ROLE_KEYS = ["admin", "operator", "user", "viewer"] as const;

export type BuiltInRoleKey = (typeof BUILT_IN_ROLE_KEYS)[number];

export function isBuiltInRoleKey(value: unknown): value is BuiltInRoleKey {
  return typeof value === "string" && (BUILT_IN_ROLE_KEYS as readonly string[]).includes(value);
}

const OPERATOR: readonly Capability[] = ["hosts:write", "agents:write"];

/**
 * `operator` manages the hosts and agents its groups are granted, and nothing until then. `user`
 * and `viewer` hold nothing: they are identities for forward auth, and differ only in name.
 */
export const BUILT_IN_ROLES: Readonly<Record<BuiltInRoleKey, RoleDefinition>> = {
  admin: { key: "admin", capabilities: CAPABILITIES, scoped: false },
  operator: { key: "operator", capabilities: OPERATOR, scoped: true },
  user: { key: "user", capabilities: [], scoped: false },
  viewer: { key: "viewer", capabilities: [], scoped: false },
};

/** The shape a made role's key takes, so anything else is known not to be one without asking. */
export function isMadeRoleKey(value: unknown): value is string {
  return typeof value === "string" && /^role-[0-9a-f]{12}$/.test(value);
}
