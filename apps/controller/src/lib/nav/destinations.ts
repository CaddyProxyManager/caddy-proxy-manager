/**
 * Every nav destination, once, so the rail, tab bar, More drawer and More page cannot disagree.
 * No React: the server validates saved drawers with it, so the client attaches icons.
 */

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
  | "apiDocs"
  | "settings"
  | "profile";

export type Destination = {
  id: DestinationId;
  href: string;
  labelKey: NavLabelKey;
  adminOnly: boolean;
  /** Shown even with no grants: an empty page explains itself, a missing menu item does not. */
  operator: boolean;
  /** Behind More on a phone; unset for the tab bar's own. */
  moreGroup?: MoreGroup;
  /** Unset sits above the titled sections, as Overview does. */
  railGroup?: RailGroup;
};

export const DESTINATIONS: readonly Destination[] = [
  { id: "overview", href: "/", labelKey: "overview", adminOnly: false, operator: false },
  {
    id: "proxy-hosts",
    href: "/proxy-hosts",
    labelKey: "proxyHosts",
    railGroup: "hosts",
    adminOnly: true,
    operator: true,
  },
  {
    id: "l4-proxy-hosts",
    href: "/l4-proxy-hosts",
    labelKey: "l4ProxyHosts",
    railGroup: "hosts",
    adminOnly: true,
    operator: true,
  },
  {
    id: "agents",
    href: "/agents",
    labelKey: "agents",
    railGroup: "hosts",
    adminOnly: true,
    operator: true,
  },
  {
    id: "access-lists",
    href: "/access-lists",
    labelKey: "accessLists",
    railGroup: "access",
    adminOnly: true,
    operator: false,
    moreGroup: "access",
  },
  {
    id: "groups",
    href: "/groups",
    labelKey: "groups",
    railGroup: "access",
    adminOnly: true,
    operator: false,
    moreGroup: "access",
  },
  {
    id: "users",
    href: "/users",
    labelKey: "users",
    railGroup: "access",
    adminOnly: true,
    operator: false,
    moreGroup: "access",
  },
  {
    id: "certificates",
    href: "/certificates",
    labelKey: "certificates",
    railGroup: "security",
    adminOnly: true,
    operator: false,
    moreGroup: "security",
  },
  {
    id: "waf",
    href: "/waf",
    labelKey: "waf",
    railGroup: "security",
    adminOnly: true,
    operator: false,
    moreGroup: "security",
  },
  {
    id: "security",
    href: "/security",
    labelKey: "security",
    railGroup: "security",
    adminOnly: true,
    operator: false,
    moreGroup: "security",
  },
  {
    id: "analytics",
    href: "/analytics",
    labelKey: "analytics",
    railGroup: "observability",
    adminOnly: true,
    operator: false,
  },
  {
    id: "audit-log",
    href: "/audit-log",
    labelKey: "auditLog",
    railGroup: "observability",
    adminOnly: true,
    operator: false,
    moreGroup: "reference",
  },
  {
    id: "logs",
    href: "/logs",
    labelKey: "logs",
    railGroup: "observability",
    adminOnly: true,
    operator: false,
    moreGroup: "reference",
  },
  {
    id: "api-docs",
    href: "/api-docs",
    labelKey: "apiDocs",
    railGroup: "system",
    adminOnly: true,
    operator: false,
    moreGroup: "reference",
  },
  {
    id: "settings",
    href: "/settings",
    labelKey: "settings",
    railGroup: "system",
    adminOnly: true,
    operator: false,
    moreGroup: "instance",
  },
  // The desktop rail reaches Profile from its footer; a phone has none.
  {
    id: "profile",
    href: "/profile",
    labelKey: "profile",
    adminOnly: false,
    operator: false,
    moreGroup: "instance",
  },
];

export const MORE_GROUPS: readonly MoreGroup[] = ["access", "security", "reference", "instance"];

/** A three-by-three grid whose ninth slot is always All pages, so no pin can push it out. */
export const MORE_DRAWER_SLOTS = 8;

export function canSee(destination: Destination, role: string | undefined): boolean {
  if (!destination.adminOnly) return true;
  if (role === "admin") return true;
  return role === "operator" && destination.operator;
}

export function visibleDestinations(role: string | undefined): Destination[] {
  return DESTINATIONS.filter((d) => canSee(d, role));
}

export function moreDestinations(role: string | undefined): Destination[] {
  return visibleDestinations(role).filter((d) => d.moreGroup !== undefined);
}

export function isDestinationId(value: unknown): value is DestinationId {
  return typeof value === "string" && DESTINATIONS.some((d) => d.id === value);
}

/** A saved drawer is filtered by role: a demoted admin's may still name Settings. */
export function resolveDrawer(
  saved: readonly DestinationId[] | null,
  role: string | undefined,
): Destination[] {
  const available = moreDestinations(role);
  if (saved === null) return available.slice(0, MORE_DRAWER_SLOTS);
  return saved
    .map((id) => available.find((d) => d.id === id))
    .filter((d): d is Destination => d !== undefined)
    .slice(0, MORE_DRAWER_SLOTS);
}
