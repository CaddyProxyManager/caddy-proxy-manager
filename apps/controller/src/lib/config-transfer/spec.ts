/**
 * What a portable config carries and how each row is recognised on another instance. Rows match
 * by a natural key (a name, an email, a rule's scope), never by id; ids are remapped on the way in,
 * including the ones kept inside JSON columns.
 */
import { SECTION_STORAGE_KEYS } from "../settings/section-keys";
import { SETTING_DEFINITIONS } from "../settings/registry";
import type { ConfigSection } from "./format";

export type Row = Record<string, unknown>;
/** The natural key of the row `id` of `table` points at, or null when it cannot be told. */
export type RefKey = (table: string, id: unknown) => string | null;

export type EmbeddedRef = {
  /** Dotted, with `[]` stepping into an array: `mtls.trusted_role_ids[]`. */
  path: string;
  target: string;
  /** Only rows this accepts carry the reference (a settings key). */
  when?: (row: Row) => boolean;
};

export type TableSpec = {
  table: string;
  section: ConfigSection;
  /** Replaced as a set along with this parent, never matched one by one. */
  parent?: {
    table: string;
    column: string;
    /** A row naming something this instance lacks: drop it (narrows access) or skip its parent. */
    onMissing: "dropRow" | "skipParent";
  };
  /** Nullable references that must resolve, since nulling them would widen what the row allows. */
  mustResolve?: readonly string[];
  embedded?: Record<string, readonly EmbeddedRef[]>;
};

/** Planning order: everything a row points at is planned before it. */
export const CONFIG_TABLES: readonly TableSpec[] = [
  { table: "waf_presets", section: "security" },
  { table: "crs_plugins", section: "security" },
  { table: "certificates", section: "certificates" },
  { table: "ca_certificates", section: "certificates" },
  { table: "issued_client_certificates", section: "certificates" },
  { table: "mtls_roles", section: "certificates" },
  {
    table: "mtls_certificate_roles",
    section: "certificates",
    parent: { table: "mtls_roles", column: "mtlsRoleId", onMissing: "dropRow" },
  },
  { table: "access_lists", section: "accessLists" },
  {
    table: "access_list_entries",
    section: "accessLists",
    parent: { table: "access_lists", column: "accessListId", onMissing: "dropRow" },
  },
  {
    table: "access_list_ip_rules",
    section: "accessLists",
    parent: { table: "access_lists", column: "accessListId", onMissing: "dropRow" },
  },
  { table: "groups", section: "groups" },
  {
    table: "group_members",
    section: "groups",
    parent: { table: "groups", column: "groupId", onMissing: "dropRow" },
  },
  {
    table: "group_idp_mappings",
    section: "groups",
    parent: { table: "groups", column: "groupId", onMissing: "dropRow" },
    // Null is "any provider".
    mustResolve: ["providerId"],
  },
  {
    table: "proxy_hosts",
    section: "hosts",
    // Null would drop the protection, or ask a public CA for names the certificate covered.
    mustResolve: ["certificateId", "accessListId"],
    embedded: {
      meta: [
        { path: "waf.preset_ids[]", target: "waf_presets" },
        { path: "waf.plugin_ids[]", target: "crs_plugins" },
        { path: "location_rules[].access_list_id", target: "access_lists" },
        { path: "mtls.trusted_client_cert_ids[]", target: "issued_client_certificates" },
        { path: "mtls.trusted_role_ids[]", target: "mtls_roles" },
        { path: "mtls.ca_certificate_ids[]", target: "ca_certificates" },
      ],
    },
  },
  {
    table: "proxy_host_agents",
    section: "hosts",
    // Without its pins a host is served by every agent.
    parent: { table: "proxy_hosts", column: "proxyHostId", onMissing: "skipParent" },
  },
  {
    table: "mtls_access_rules",
    section: "hosts",
    parent: { table: "proxy_hosts", column: "proxyHostId", onMissing: "skipParent" },
    embedded: {
      allowedRoleIds: [{ path: "[]", target: "mtls_roles" }],
      allowedCertIds: [{ path: "[]", target: "issued_client_certificates" }],
    },
  },
  {
    table: "forward_auth_access",
    section: "hosts",
    parent: { table: "proxy_hosts", column: "proxyHostId", onMissing: "dropRow" },
    mustResolve: ["userId", "groupId"],
  },
  { table: "l4_proxy_hosts", section: "hosts", mustResolve: ["accessListId"] },
  {
    table: "l4_proxy_host_agents",
    section: "hosts",
    parent: { table: "l4_proxy_hosts", column: "l4ProxyHostId", onMissing: "skipParent" },
  },
  {
    table: "group_grants",
    section: "groups",
    parent: { table: "groups", column: "groupId", onMissing: "dropRow" },
    mustResolve: ["proxyHostId", "l4ProxyHostId", "agentId"],
  },
  // Null host is every host.
  { table: "waf_exclusions", section: "security", mustResolve: ["proxyHostId"] },
  { table: "blocked_sources", section: "security" },
  {
    table: "settings",
    section: "settings",
    embedded: {
      value: [
        { path: "preset_ids[]", target: "waf_presets", when: (row) => row.key === "waf" },
        { path: "plugin_ids[]", target: "crs_plugins", when: (row) => row.key === "waf" },
      ],
    },
  },
];

export const SPEC_BY_TABLE = new Map(CONFIG_TABLES.map((spec) => [spec.table, spec]));

/**
 * Settings the file carries: every section's rows and the registry's, less the dashboard host,
 * which is this instance's own address and agents.
 */
export const PORTABLE_SETTING_KEYS: ReadonlySet<string> = new Set(
  [
    ...Object.values(SECTION_STORAGE_KEYS).flatMap((section) => section.keys),
    ...SETTING_DEFINITIONS.map((definition) => definition.key),
  ].filter((key) => key !== "dashboard"),
);

/** Bookkeeping and provenance: copied where they resolve, never compared. */
export const NOT_COMPARED = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "createdBy",
  "ownerUserId",
  "sourceReadAt",
  "sourceError",
]);

/** Columns an import may set but never clear: a revoked certificate stays revoked. */
export const ONE_WAY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  issued_client_certificates: ["revokedAt"],
};

const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));

/** Null when the row cannot be keyed, e.g. it points at something that has no key either. */
export function naturalKey(table: string, row: Row, ref: RefKey): string | null {
  switch (table) {
    case "users":
      return text(row.email).toLowerCase() || null;
    // An agent names itself, after its Caddy container by default, so the name says little.
    case "agents":
      return text(row.agentId) || null;
    case "issued_client_certificates":
      return text(row.fingerprintSha256) || null;
    case "waf_exclusions": {
      const host = row.proxyHostId == null ? "*" : ref("proxy_hosts", row.proxyHostId);
      return host === null
        ? null
        : [text(row.ruleId), host, text(row.path), text(row.target)].join("|");
    }
    case "blocked_sources":
      return `${text(row.kind)}|${text(row.value)}`;
    case "settings":
      return text(row.key) || null;
    default:
      return text(row.name) || null;
  }
}

/** What the preview calls a row. */
export function itemLabel(table: string, key: string): string {
  if (table === "waf_exclusions") {
    const [rule, host, path, target] = key.split("|");
    return [rule, host === "*" ? "" : host, path, target].filter(Boolean).join(" ");
  }
  if (table === "blocked_sources") return key.replace("|", " ");
  return key;
}
