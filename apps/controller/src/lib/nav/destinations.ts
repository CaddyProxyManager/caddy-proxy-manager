/**
 * Every nav destination, once, so the rail, tab bar, More drawer and More page cannot disagree.
 * No React: the server validates saved drawers with it, so the client attaches icons.
 */

import { type Capability, type CapabilitySet, reaches } from "../roles/capabilities";

export type DestinationId =
  | "overview"
  | "proxy-hosts"
  | "l4-proxy-hosts"
  | "agents"
  | "analytics"
  | "access-lists"
  | "groups"
  | "users"
  | "certificates"
  | "waf"
  | "security"
  | "audit-log"
  | "logs"
  | "alerts"
  | "approvals"
  | "api-docs"
  | "settings"
  | "profile";

export type MoreGroup = "access" | "security" | "reference" | "instance";

export type RailGroup = "hosts" | "access" | "security" | "observability" | "system";
export const RAIL_GROUPS: readonly RailGroup[] = [
  "hosts",
  "access",
  "security",
  "observability",
  "system",
];

/** Spelled out, not `string`, so next-intl's typed keys catch a typo at build. */
export type NavLabelKey =
  | "overview"
  | "proxyHosts"
  | "l4ProxyHosts"
  | "agents"
  | "analytics"
  | "accessLists"
  | "groups"
  | "users"
  | "certificates"
  | "waf"
  | "security"
  | "auditLog"
  | "logs"
  | "alerts"
  | "approvals"
  | "apiDocs"
  | "settings"
  | "profile";

export type Destination = {
  id: DestinationId;
  href: string;
  labelKey: NavLabelKey;
  /**
   * Needed to see it, null for everyone. Held over a single object is enough: a page of granted
   * objects, even with none granted yet, explains itself where a missing menu item does not.
   */
  capability: Capability | null;
  /** Behind More on a phone; unset for the tab bar's own. */
  moreGroup?: MoreGroup;
  /** Unset sits above the titled sections, as Overview does. */
  railGroup?: RailGroup;
};

export const DESTINATIONS: readonly Destination[] = [
  { id: "overview", href: "/", labelKey: "overview", capability: null },
  {
    id: "proxy-hosts",
    href: "/proxy-hosts",
    labelKey: "proxyHosts",
    railGroup: "hosts",
    capability: "hosts:read",
  },
  {
    id: "l4-proxy-hosts",
    href: "/l4-proxy-hosts",
    labelKey: "l4ProxyHosts",
    railGroup: "hosts",
    capability: "hosts:read",
  },
  {
    id: "agents",
    href: "/agents",
    labelKey: "agents",
    railGroup: "hosts",
    capability: "agents:read",
  },
  {
    id: "access-lists",
    href: "/access-lists",
    labelKey: "accessLists",
    railGroup: "access",
    capability: "accessLists:read",
    moreGroup: "access",
  },
  {
    id: "groups",
    href: "/groups",
    labelKey: "groups",
    railGroup: "access",
    capability: "groups:read",
    moreGroup: "access",
  },
  {
    id: "users",
    href: "/users",
    labelKey: "users",
    railGroup: "access",
    capability: "users:read",
    moreGroup: "access",
  },
  {
    id: "certificates",
    href: "/certificates",
    labelKey: "certificates",
    railGroup: "security",
    capability: "certificates:read",
    moreGroup: "security",
  },
  {
    id: "waf",
    href: "/waf",
    labelKey: "waf",
    railGroup: "security",
    capability: "security:read",
    moreGroup: "security",
  },
  {
    id: "security",
    href: "/security",
    labelKey: "security",
    railGroup: "security",
    capability: "security:read",
    moreGroup: "security",
  },
  {
    id: "analytics",
    href: "/analytics",
    labelKey: "analytics",
    railGroup: "observability",
    capability: "analytics:read",
  },
  {
    id: "audit-log",
    href: "/audit-log",
    labelKey: "auditLog",
    railGroup: "observability",
    capability: "audit:read",
    moreGroup: "reference",
  },
  {
    id: "logs",
    href: "/logs",
    labelKey: "logs",
    railGroup: "observability",
    capability: "logs:read",
    moreGroup: "reference",
  },
  {
    id: "alerts",
    href: "/alerts",
    labelKey: "alerts",
    railGroup: "observability",
    capability: "alerts:read",
    moreGroup: "reference",
  },
  // Anyone's: a requester follows their change here, and the policy, not a capability, names who
  // approves.
  {
    id: "approvals",
    href: "/approvals",
    labelKey: "approvals",
    railGroup: "system",
    capability: null,
    moreGroup: "instance",
  },
  {
    id: "api-docs",
    href: "/api-docs",
    labelKey: "apiDocs",
    railGroup: "system",
    capability: "settings:read",
    moreGroup: "reference",
  },
  {
    id: "settings",
    href: "/settings",
    labelKey: "settings",
    railGroup: "system",
    capability: "settings:read",
    moreGroup: "instance",
  },
  // The desktop rail reaches Profile from its footer; a phone has none.
  {
    id: "profile",
    href: "/profile",
    labelKey: "profile",
    capability: null,
    moreGroup: "instance",
  },
];

export const MORE_GROUPS: readonly MoreGroup[] = ["access", "security", "reference", "instance"];

/** A three-by-three grid whose ninth slot is always All pages, so no pin can push it out. */
export const MORE_DRAWER_SLOTS = 8;

export function canSee(destination: Destination, capabilities: CapabilitySet): boolean {
  return destination.capability === null || reaches(capabilities, destination.capability);
}

export function visibleDestinations(capabilities: CapabilitySet): Destination[] {
  return DESTINATIONS.filter((d) => canSee(d, capabilities));
}

export function moreDestinations(capabilities: CapabilitySet): Destination[] {
  return visibleDestinations(capabilities).filter((d) => d.moreGroup !== undefined);
}

export function isDestinationId(value: unknown): value is DestinationId {
  return typeof value === "string" && DESTINATIONS.some((d) => d.id === value);
}

/** A saved drawer is filtered by what the viewer may see: a demoted admin's may still name Settings. */
export function resolveDrawer(
  saved: readonly DestinationId[] | null,
  capabilities: CapabilitySet,
): Destination[] {
  const available = moreDestinations(capabilities);
  if (saved === null) return available.slice(0, MORE_DRAWER_SLOTS);
  return saved
    .map((id) => available.find((d) => d.id === id))
    .filter((d): d is Destination => d !== undefined)
    .slice(0, MORE_DRAWER_SLOTS);
}
