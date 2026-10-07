/**
 * What a role may do, as `resource:read` and `resource:write`. The resources are the API token
 * areas, split where one area is too coarse to hand a person (users from groups and roles,
 * settings from backups and alerts, analytics from logs), so a token's scope still names each
 * capability's area. No server imports: the role editor and the nav read it.
 */
import type { TokenAccess, TokenArea } from "../api-tokens/scope";

/** The objects a group grant can name. */
export type ObjectKind = "proxyHost" | "l4ProxyHost" | "agent";

type ResourceDefinition = {
  /** The token area a scoped token must hold for it. */
  area: TokenArea;
  /** Set where a grant can hand out single objects, which is what a scoped role reaches. */
  objects?: readonly ObjectKind[];
};

export const CAPABILITY_RESOURCES = {
  overview: { area: "overview" },
  hosts: { area: "hosts", objects: ["proxyHost", "l4ProxyHost"] },
  agents: { area: "agents", objects: ["agent"] },
  accessLists: { area: "accessLists" },
  certificates: { area: "certificates" },
  security: { area: "security" },
  analytics: { area: "analytics" },
  logs: { area: "analytics" },
  users: { area: "users" },
  groups: { area: "users" },
  roles: { area: "users" },
  settings: { area: "settings" },
  backups: { area: "settings" },
  alerts: { area: "settings" },
  audit: { area: "audit" },
  tokens: { area: "tokens" },
} as const satisfies Record<string, ResourceDefinition>;

export type CapabilityResource = keyof typeof CAPABILITY_RESOURCES;

export const CAPABILITY_RESOURCE_LIST = Object.keys(CAPABILITY_RESOURCES) as CapabilityResource[];

export type CapabilityLevel = TokenAccess;

export type Capability = `${CapabilityResource}:${CapabilityLevel}`;

export const CAPABILITIES: readonly Capability[] = CAPABILITY_RESOURCE_LIST.flatMap(
  (resource): Capability[] => [`${resource}:read`, `${resource}:write`],
);

const KNOWN: ReadonlySet<string> = new Set(CAPABILITIES);

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && KNOWN.has(value);
}

export function splitCapability(capability: Capability): [CapabilityResource, CapabilityLevel] {
  return capability.split(":") as [CapabilityResource, CapabilityLevel];
}

export function capabilityArea(capability: Capability): { area: TokenArea; access: TokenAccess } {
  const [resource, access] = splitCapability(capability);
  return { area: CAPABILITY_RESOURCES[resource].area, access };
}

export function objectKindsOf(resource: CapabilityResource): readonly ObjectKind[] {
  const definition: ResourceDefinition = CAPABILITY_RESOURCES[resource];
  return definition.objects ?? [];
}

export function resourceOfKind(kind: ObjectKind): CapabilityResource {
  return kind === "agent" ? "agents" : "hosts";
}

/** Deduplicated, each write bringing its read, in catalog order so stored lists compare equal. */
export function normalizeCapabilities(values: readonly unknown[]): Capability[] {
  const set = new Set(values.filter(isCapability));
  for (const capability of [...set]) {
    const [resource, level] = splitCapability(capability);
    if (level === "write") set.add(`${resource}:read`);
  }
  return CAPABILITIES.filter((capability) => set.has(capability));
}

/**
 * How far a capability reaches: every object, or only those a group grant names. Only
 * object-bound resources can be `granted`; anything else a role holds, it holds outright.
 */
export type Reach = "all" | "granted";

/** Serializable, so the layout can hand it to the nav. */
export type CapabilitySet = Partial<Record<Capability, Reach>>;

/** The shape both a built-in and a stored role take. */
export type RoleDefinition = {
  key: string;
  capabilities: readonly Capability[];
  /** Object-bound capabilities reach only what the holder's groups are granted. */
  scoped: boolean;
};

/** Several roles at once (one's own and its groups'): the widest reach of each capability wins. */
export function capabilitySetOf(roles: readonly RoleDefinition[]): CapabilitySet {
  const set: CapabilitySet = {};
  for (const role of roles) {
    for (const capability of normalizeCapabilities(role.capabilities)) {
      const [resource] = splitCapability(capability);
      const reach: Reach = role.scoped && objectKindsOf(resource).length > 0 ? "granted" : "all";
      if (set[capability] !== "all") set[capability] = reach;
    }
  }
  return set;
}

/** Outright, over every object or none in particular: what creating or any global page needs. */
export function holds(set: CapabilitySet, capability: Capability): boolean {
  return set[capability] === "all";
}

/** Over at least one object, which opens a list page whose rows are then filtered. */
export function reaches(set: CapabilitySet, capability: Capability): boolean {
  return set[capability] !== undefined;
}

/**
 * Whether `set` holds outright everything `role` would hand out, so nobody grants more than they
 * have. Outright even for a scoped role: its holder's grants may name objects the giver's don't.
 */
export function covers(set: CapabilitySet, role: RoleDefinition): boolean {
  return normalizeCapabilities(role.capabilities).every((capability) => holds(set, capability));
}
