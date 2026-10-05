/**
 * The schema's tables grouped into choices an operator recognises. `requires` pulls in groups
 * whose nullable references would otherwise silently drop, e.g. publishing a host without its
 * access list; every other cross-group reference is provenance the importer may null.
 */

export type MigrationGroupId =
  | "users"
  | "proxyHosts"
  | "certificates"
  | "accessLists"
  | "oauthProviders"
  | "agents"
  | "settings"
  | "auditLog";

export type MigrationGroup = {
  id: MigrationGroupId;
  /** Mirrored in `setup.migrationGroups.<id>`: change both, or migration-messages.test.ts fails. */
  label: string;
  description: string;
  /** The `pgTable` name, not the exported identifier. */
  tables: string[];
  requires: MigrationGroupId[];
};

/** The consequential choices first. */
export const MIGRATION_GROUPS: MigrationGroup[] = [
  {
    id: "users",
    label: "Users and their sign-in",
    description:
      "Accounts, passwords, API tokens, groups and the per-user access rules on your hosts. " +
      "Leaving these behind means creating a new administrator on the next screen.",
    tables: [
      "users",
      "sessions",
      "accounts",
      "verifications",
      "two_factors",
      "passkeys",
      "pending_oauth_links",
      "api_tokens",
      "push_subscriptions",
      "analytics_views",
      "groups",
      "group_members",
      // With the group, not the hosts: without hosts the resource column is cleared (clearedColumns
      // in import.ts), and a grant naming nothing grants nothing - the safe direction.
      "group_idp_mappings",
      "group_grants",
      "forward_auth_access",
      "forward_auth_sessions",
      "forward_auth_exchanges",
    ],
    requires: [],
  },
  {
    id: "proxyHosts",
    label: "Proxy hosts",
    description:
      "Your HTTP and layer-4 hosts, with their mTLS access rules. Certificates and access lists " +
      "come with them, because a host that lost its access list would be published unprotected.",
    tables: [
      "proxy_hosts",
      "l4_proxy_hosts",
      "mtls_access_rules",
      "forward_auth_redirect_intents",
      "proxy_host_agents",
      "l4_proxy_host_agents",
      // With the hosts: a cleared host reference would widen an exclusion to every host.
      "waf_exclusions",
    ],
    // Agents too: lost placement rows read as "no assignment", which means every agent.
    requires: ["certificates", "accessLists", "agents"],
  },
  {
    id: "certificates",
    label: "Certificates",
    description:
      "Issued and uploaded certificates, certificate authorities, client certificates and mTLS " +
      "roles.",
    tables: [
      "certificates",
      "ca_certificates",
      "issued_client_certificates",
      "mtls_roles",
      "mtls_certificate_roles",
    ],
    requires: [],
  },
  {
    id: "accessLists",
    label: "Access lists",
    description: "Basic-auth lists and the usernames in them.",
    tables: [
      "access_lists",
      "access_list_entries",
      "access_list_ip_rules",
      "access_list_dns_cache",
    ],
    requires: [],
  },
  {
    id: "oauthProviders",
    label: "OAuth providers",
    description:
      "Configured identity providers, including their client secrets. Bringing an enabled " +
      "provider across is a way in on its own, even without the old user accounts.",
    tables: ["oauth_providers", "oauth_states"],
    requires: [],
  },
  {
    id: "agents",
    label: "Agents",
    description: "Remote agents this controller had paired with, and their shared secrets.",
    tables: ["agents"],
    requires: [],
  },
  {
    id: "settings",
    label: "Settings",
    description:
      "The stored configuration the Settings page writes - primary domain, ACME details, and the " +
      "rest.",
    // Staged and revisions are claimed only for coverage: always empty in a legacy source.
    // waf_presets and crs_plugins because WAF settings select them; a lost one drops just itself.
    tables: [
      "settings",
      "settings_staged",
      "settings_revisions",
      "waf_presets",
      "crs_plugins",
      "blocked_sources",
    ],
    requires: [],
  },
  {
    id: "auditLog",
    label: "Audit log",
    description:
      "The history of who changed what. Usually the largest table, and never load-bearing.",
    tables: ["audit_events", "waf_event_reviews"],
    requires: [],
  },
];

export const ALL_MIGRATION_GROUP_IDS: MigrationGroupId[] = MIGRATION_GROUPS.map(
  (group) => group.id,
);

const BY_ID = new Map(MIGRATION_GROUPS.map((group) => [group.id, group]));

export function groupForTable(table: string): MigrationGroup | null {
  return MIGRATION_GROUPS.find((group) => group.tables.includes(table)) ?? null;
}

export function isMigrationGroupId(value: string): value is MigrationGroupId {
  return BY_ID.has(value as MigrationGroupId);
}

/** Applied by the checkboxes to show it, and again by the action, which cannot trust the form. */
export function withRequiredGroups(ids: Iterable<MigrationGroupId>): MigrationGroupId[] {
  const resolved = new Set<MigrationGroupId>();

  function add(id: MigrationGroupId): void {
    if (resolved.has(id)) return;
    resolved.add(id);
    for (const required of BY_ID.get(id)?.requires ?? []) add(required);
  }

  for (const id of ids) add(id);
  // Declaration order, so reports and tests are stable.
  return ALL_MIGRATION_GROUP_IDS.filter((id) => resolved.has(id));
}

export function parseMigrationSelection(values: Iterable<string>): MigrationGroupId[] {
  return withRequiredGroups([...values].filter(isMigrationGroupId));
}

export function tablesForSelection(ids: Iterable<MigrationGroupId>): Set<string> {
  const tables = new Set<string>();
  for (const id of withRequiredGroups(ids)) {
    for (const table of BY_ID.get(id)?.tables ?? []) tables.add(table);
  }
  return tables;
}
