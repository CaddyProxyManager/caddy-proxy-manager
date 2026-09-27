// The application's tables, and the hand-edited source of truth for both backends. After editing,
// regenerate the SQLite mirror with `bun scripts/generate-sqlite-schema.ts`, then the migrations with
// `bun run db:generate` once per dialect (see drizzle.config.ts).
import {
  boolean,
  index,
  integer,
  pgTable,
  serial,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { isoTimestamp } from "./columns.pg";

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name"),
    passwordHash: text("passwordHash"),
    // When the login password was last set. Null for a user without one, and for one whose password
    // predates this column - the credential account's updatedAt cannot stand in for it, because the
    // environment-seeded admin rewrites that row on every start.
    passwordChangedAt: isoTimestamp("passwordChangedAt"),
    role: text("role").notNull().default("user"),
    provider: text("provider"),
    subject: text("subject"),
    avatarUrl: text("avatarUrl"),
    status: text("status").notNull().default("active"),
    username: text("username"),
    displayUsername: text("displayUsername"),
    emailVerified: boolean("emailVerified").notNull().default(false),
    // Set by Better Auth's two-factor plugin once TOTP is verified; local accounts only.
    twoFactorEnabled: boolean("twoFactorEnabled").notNull().default(false),
    createdAt: isoTimestamp("createdAt").notNull(),
    updatedAt: isoTimestamp("updatedAt").notNull(),
  },
  (table) => ({
    emailUnique: uniqueIndex("users_email_unique").on(table.email),
  }),
);

// Auth tables use camelCase DB columns to match Better Auth's Kysely adapter.
export const sessions = pgTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    userId: integer("userId")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    token: text("token").notNull(),
    expiresAt: isoTimestamp("expiresAt").notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    // Which IdP session this one came from, when it came from one at all. OIDC back-channel
    // logout names the session to end by its `sid`, which is only unique within an issuer - so
    // the provider is stored beside it rather than matching on `sid` alone. Both stay null for
    // credential sign-ins and for providers that issue no `sid`.
    oidcProviderId: text("oidcProviderId"),
    oidcSid: text("oidcSid"),
    // An admin's "view as" preview; narrows this session only. Groups are a JSON array of ids.
    viewAsRole: text("viewAsRole"),
    viewAsGroupIds: text("viewAsGroupIds"),
    viewAsExpiresAt: isoTimestamp("viewAsExpiresAt"),
    createdAt: isoTimestamp("createdAt").notNull(),
    updatedAt: isoTimestamp("updatedAt").notNull(),
  },
  (table) => ({
    tokenUnique: uniqueIndex("sessions_token_unique").on(table.token),
    userIdx: index("sessions_user_idx").on(table.userId),
    oidcSessionIdx: index("sessions_oidc_session_idx").on(table.oidcProviderId, table.oidcSid),
  }),
);

export const accounts = pgTable(
  "accounts",
  {
    id: serial("id").primaryKey(),
    userId: integer("userId")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: isoTimestamp("accessTokenExpiresAt"),
    refreshTokenExpiresAt: isoTimestamp("refreshTokenExpiresAt"),
    scope: text("scope"),
    password: text("password"),
    createdAt: isoTimestamp("createdAt").notNull(),
    updatedAt: isoTimestamp("updatedAt").notNull(),
  },
  (table) => ({
    providerAccountIdx: uniqueIndex("accounts_provider_account_idx").on(
      table.providerId,
      table.accountId,
    ),
    userIdx: index("accounts_user_idx").on(table.userId),
  }),
);

export const verifications = pgTable("verifications", {
  id: serial("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: isoTimestamp("expiresAt").notNull(),
  createdAt: isoTimestamp("createdAt"),
  updatedAt: isoTimestamp("updatedAt"),
});

// Better Auth's `twoFactor` model. `secret` and `backupCodes` are encrypted by the plugin with the
// auth secret; the lockout columns cap consecutive wrong codes per account.
export const twoFactors = pgTable(
  "two_factors",
  {
    id: serial("id").primaryKey(),
    userId: integer("userId")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    secret: text("secret").notNull(),
    backupCodes: text("backupCodes").notNull(),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failedVerificationCount").notNull().default(0),
    lockedUntil: isoTimestamp("lockedUntil"),
  },
  (table) => ({
    userUnique: uniqueIndex("two_factors_user_unique").on(table.userId),
  }),
);

export const oauthProviders = pgTable(
  "oauth_providers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull().default("oidc"),
    clientId: text("clientId").notNull(),
    clientSecret: text("clientSecret").notNull(),
    issuer: text("issuer"),
    authorizationUrl: text("authorizationUrl"),
    tokenUrl: text("tokenUrl"),
    userinfoUrl: text("userinfoUrl"),
    scopes: text("scopes").notNull().default("openid email profile"),
    autoLink: boolean("autoLink").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    source: text("source").notNull().default("ui"),
    // ── OIDC group mapping ────────────────────────────────────────────────
    // Claim holding the user's groups. Dot-separated paths address nested claims (e.g.
    // "resource_access.cpm.roles").
    groupsClaim: text("groupsClaim").notNull().default("groups"),
    // Convention prefix: with "CPM_", membership of "CPM_Admin" grants admin.
    groupPrefix: text("groupPrefix"),
    roleMappingEnabled: boolean("roleMappingEnabled").notNull().default(false),
    // Explicit overrides; when unset they are derived from groupPrefix.
    adminGroup: text("adminGroup"),
    operatorGroup: text("operatorGroup"),
    userGroup: text("userGroup"),
    viewerGroup: text("viewerGroup"),
    // Role assigned when no role group matched.
    defaultRole: text("defaultRole").notNull().default("user"),
    // Mirror the remaining prefixed IdP groups into CPM groups.
    syncGroups: boolean("syncGroups").notNull().default(false),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => ({
    nameUnique: uniqueIndex("oauth_providers_name_unique").on(table.name),
  }),
);

export const oauthStates = pgTable(
  "oauth_states",
  {
    id: serial("id").primaryKey(),
    state: text("state").notNull(),
    codeVerifier: text("codeVerifier").notNull(),
    redirectTo: text("redirectTo"),
    createdAt: text("createdAt").notNull(),
    expiresAt: text("expiresAt").notNull(),
  },
  (table) => ({
    stateUnique: uniqueIndex("oauth_state_unique").on(table.state),
  }),
);

export const pendingOAuthLinks = pgTable(
  "pending_oauth_links",
  {
    id: serial("id").primaryKey(),
    userId: integer("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 50 }).notNull(),
    userEmail: text("userEmail").notNull(), // Email of the user who initiated linking
    createdAt: text("createdAt").notNull(),
    expiresAt: text("expiresAt").notNull(),
  },
  (table) => ({
    // Ensure only one pending link per user per provider (prevents race conditions)
    userProviderUnique: uniqueIndex("pending_oauth_user_provider_unique").on(
      table.userId,
      table.provider,
    ),
  }),
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

/**
 * Settings edited but not yet applied, held per operator.
 *
 * Same `key` and serialized `value` as `settings`, so a staged row is a drop-in for the stored one
 * and the read path parses both identically. Scoped by user because two admins editing at once
 * must not see each other's half-finished work land in their own apply - the row moves into
 * `settings` only when its owner applies.
 */
export const settingsStaged = pgTable(
  "settings_staged",
  {
    key: text("key").notNull(),
    userId: integer("userId")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    value: text("value").notNull(),
    stagedAt: text("stagedAt").notNull(),
  },
  (table) => ({
    pk: uniqueIndex("settings_staged_user_key_idx").on(table.userId, table.key),
  }),
);

/**
 * One row per apply, so an operator can see what changed and when it reached Caddy.
 *
 * `id` is the revision number the UI shows. `summary` is the human-readable change list rendered
 * at apply time rather than derived later: the settings it describes have moved on by then, and a
 * history that re-reads current values would narrate the present, not what happened.
 *
 * `changes` is each committed key's serialized value before and after, as JSON. It is what makes
 * two revisions comparable and an old one restorable; null on rows written before it existed.
 */
export const settingsRevisions = pgTable("settings_revisions", {
  id: serial("id").primaryKey(),
  appliedBy: integer("appliedBy").references(() => users.id, { onDelete: "set null" }),
  appliedByName: text("appliedByName"),
  summary: text("summary").notNull(),
  keys: text("keys").notNull(),
  changes: text("changes"),
  outcome: text("outcome").notNull(),
  error: text("error"),
  appliedAt: text("appliedAt").notNull(),
});

/**
 * Agents this controller has paired with.
 *
 * No address, because the controller never dials one: agents connect inbound and hold an event
 * stream open, so whether an agent is reachable is a question about `lib/agent/registry.ts` and
 * this table cannot answer it. What lives here is the half that must outlive a restart - who the
 * agent is, and the secret it signs with.
 *
 * `agentId` is the identity the agent asserts on every request and the key pairing upserts on, so
 * an agent that re-pairs replaces its row rather than accumulating one per attempt.
 */
export const agents = pgTable(
  "agents",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    /** The agent's own stable id, minted once on its host and reported at pairing. */
    agentId: text("agentId").notNull(),
    /** Shared secret, encrypted at rest. Never leaves the server. */
    secret: text("secret").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /**
     * This agent's own Caddy build selection, as JSON, or null to follow the fleet default.
     *
     * Null rather than a copy of the default: an agent that has never been configured separately
     * must keep tracking the fleet selection, so enabling a module for everyone does not silently
     * skip the hosts nobody thought to open.
     */
    buildSettings: text("buildSettings"),
    lastSeenAt: text("lastSeenAt"),
    lastError: text("lastError"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => ({
    agentIdUnique: uniqueIndex("agents_agentId_unique").on(table.agentId),
  }),
);

export const accessLists = pgTable("access_lists", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  // What a request matching none of the IP rules gets; only consulted while there are rules.
  ipDefault: text("ipDefault").notNull().default("deny"),
  // "all": pass the IP rules and the password. "any": either will do.
  satisfy: text("satisfy").notNull().default("all"),
  // Forward the basic-auth Authorization header to the upstream.
  passAuth: boolean("passAuth").notNull().default(false),
  createdBy: integer("createdBy").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

export const accessListEntries = pgTable(
  "access_list_entries",
  {
    id: serial("id").primaryKey(),
    accessListId: integer("accessListId")
      .references(() => accessLists.id, { onDelete: "cascade" })
      .notNull(),
    username: text("username").notNull(),
    passwordHash: text("passwordHash").notNull(),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => ({
    accessListIdIdx: index("access_list_entries_list_idx").on(table.accessListId),
  }),
);

/** Ordered allow/deny rules on client IPs; the first that matches decides. */
export const accessListIpRules = pgTable(
  "access_list_ip_rules",
  {
    id: serial("id").primaryKey(),
    accessListId: integer("accessListId")
      .references(() => accessLists.id, { onDelete: "cascade" })
      .notNull(),
    action: text("action").notNull(),
    cidr: text("cidr").notNull(),
    note: text("note"),
    sortOrder: integer("sortOrder").notNull(),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => ({
    accessListIdIdx: index("access_list_ip_rules_list_idx").on(table.accessListId),
  }),
);

export const certificates = pgTable("certificates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  domainNames: text("domainNames").notNull(),
  autoRenew: boolean("autoRenew").notNull().default(true),
  providerOptions: text("providerOptions"),
  certificatePem: text("certificatePem"),
  privateKeyPem: text("privateKeyPem"),
  createdBy: integer("createdBy").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

export const caCertificates = pgTable("ca_certificates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  certificatePem: text("certificatePem").notNull(),
  privateKeyPem: text("privateKeyPem"),
  createdBy: integer("createdBy").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

export const issuedClientCertificates = pgTable(
  "issued_client_certificates",
  {
    id: serial("id").primaryKey(),
    caCertificateId: integer("caCertificateId")
      .references(() => caCertificates.id, { onDelete: "cascade" })
      .notNull(),
    commonName: text("commonName").notNull(),
    serialNumber: text("serialNumber").notNull(),
    fingerprintSha256: text("fingerprintSha256").notNull(),
    certificatePem: text("certificatePem").notNull(),
    validFrom: text("validFrom").notNull(),
    validTo: text("validTo").notNull(),
    revokedAt: text("revokedAt"),
    createdBy: integer("createdBy").references(() => users.id, { onDelete: "set null" }),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => ({
    caCertificateIdx: index("issued_client_certificates_ca_idx").on(table.caCertificateId),
    revokedAtIdx: index("issued_client_certificates_revoked_at_idx").on(table.revokedAt),
  }),
);

export const proxyHosts = pgTable("proxy_hosts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  domains: text("domains").notNull(),
  upstreams: text("upstreams").notNull(),
  certificateId: integer("certificateId").references(() => certificates.id, {
    onDelete: "set null",
  }),
  accessListId: integer("accessListId").references(() => accessLists.id, { onDelete: "set null" }),
  ownerUserId: integer("ownerUserId").references(() => users.id, { onDelete: "set null" }),
  sslForced: boolean("sslForced").notNull().default(true),
  hstsEnabled: boolean("hstsEnabled").notNull().default(true),
  hstsSubdomains: boolean("hstsSubdomains").notNull().default(false),
  allowWebsocket: boolean("allowWebsocket").notNull().default(true),
  preserveHostHeader: boolean("preserveHostHeader").notNull().default(true),
  meta: text("meta"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
  skipHttpsHostnameValidation: boolean("skipHttpsHostnameValidation").notNull().default(false),
});

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    tokenHash: text("tokenHash").notNull(),
    createdBy: integer("createdBy")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: text("createdAt").notNull(),
    lastUsedAt: text("lastUsedAt"),
    expiresAt: text("expiresAt"),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("api_tokens_token_hash_unique").on(table.tokenHash),
  }),
);

export const auditEvents = pgTable("audit_events", {
  id: serial("id").primaryKey(),
  userId: integer("userId").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  entityType: text("entityType").notNull(),
  entityId: integer("entityId"),
  summary: text("summary"),
  data: text("data"),
  createdAt: text("createdAt").notNull(),
});

// traffic_events and waf_events live in ClickHouse - see src/lib/clickhouse/client.ts. The
// parsers that fill them, and their read offsets, live in the agent: the Caddy log is a file on
// the agent's host, which a controller elsewhere cannot read at all.

// ── mTLS RBAC ──────────────────────────────────────────────────────────

export const mtlsRoles = pgTable(
  "mtls_roles",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    createdBy: integer("createdBy").references(() => users.id, { onDelete: "set null" }),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => ({
    nameUnique: uniqueIndex("mtls_roles_name_unique").on(table.name),
  }),
);

// Named SecLang snippets the global WAF and each host select by id (upstream #149).
export const wafPresets = pgTable(
  "waf_presets",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    directives: text("directives").notNull(),
    createdBy: integer("createdBy").references(() => users.id, { onDelete: "set null" }),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => ({
    nameUnique: uniqueIndex("waf_presets_name_unique").on(table.name),
  }),
);

// CRS plugins installed from the plugin registry, pinned to the release they were fetched at. The
// rule files are stored rather than fetched per apply, so a config build never waits on GitHub.
export const crsPlugins = pgTable(
  "crs_plugins",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    repository: text("repository").notNull(),
    version: text("version").notNull(),
    description: text("description"),
    ruleIdStart: integer("ruleIdStart").notNull(),
    ruleIdEnd: integer("ruleIdEnd").notNull(),
    configRules: text("configRules").notNull(),
    beforeRules: text("beforeRules").notNull(),
    afterRules: text("afterRules").notNull(),
    // The operator's edit of the -config file; null runs the upstream one. Survives an update.
    configOverride: text("configOverride"),
    // JSON array of the plugins/ files the release had, for display; the rules are stored by kind.
    fileNames: text("fileNames").notNull().default("[]"),
    createdBy: integer("createdBy").references(() => users.id, { onDelete: "set null" }),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => ({
    nameUnique: uniqueIndex("crs_plugins_name_unique").on(table.name),
  }),
);

export const mtlsCertificateRoles = pgTable(
  "mtls_certificate_roles",
  {
    id: serial("id").primaryKey(),
    issuedClientCertificateId: integer("issuedClientCertificateId")
      .references(() => issuedClientCertificates.id, { onDelete: "cascade" })
      .notNull(),
    mtlsRoleId: integer("mtlsRoleId")
      .references(() => mtlsRoles.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (table) => ({
    certRoleUnique: uniqueIndex("mtls_cert_role_unique").on(
      table.issuedClientCertificateId,
      table.mtlsRoleId,
    ),
    roleIdx: index("mtls_certificate_roles_role_idx").on(table.mtlsRoleId),
  }),
);

export const mtlsAccessRules = pgTable(
  "mtls_access_rules",
  {
    id: serial("id").primaryKey(),
    proxyHostId: integer("proxyHostId")
      .references(() => proxyHosts.id, { onDelete: "cascade" })
      .notNull(),
    pathPattern: text("pathPattern").notNull(),
    allowedRoleIds: text("allowedRoleIds").notNull().default("[]"),
    allowedCertIds: text("allowedCertIds").notNull().default("[]"),
    denyAll: boolean("denyAll").notNull().default(false),
    priority: integer("priority").notNull().default(0),
    description: text("description"),
    createdBy: integer("createdBy").references(() => users.id, { onDelete: "set null" }),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => ({
    proxyHostIdx: index("mtls_access_rules_proxy_host_idx").on(table.proxyHostId),
    hostPathUnique: uniqueIndex("mtls_access_rules_host_path_unique").on(
      table.proxyHostId,
      table.pathPattern,
    ),
  }),
);

// ── Forward Auth (IdP) ───────────────────────────────────────────────

export const groups = pgTable(
  "groups",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    createdBy: integer("createdBy").references(() => users.id, { onDelete: "set null" }),
    // "ui" for operator-managed groups, "oidc" for groups created by an IdP group sync. Only
    // "oidc" group membership is reconciled on sign-in.
    source: text("source").notNull().default("ui"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => ({
    nameUnique: uniqueIndex("groups_name_unique").on(table.name),
  }),
);

export const groupMembers = pgTable(
  "group_members",
  {
    id: serial("id").primaryKey(),
    groupId: integer("groupId")
      .references(() => groups.id, { onDelete: "cascade" })
      .notNull(),
    userId: integer("userId")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (table) => ({
    memberUnique: uniqueIndex("group_members_unique").on(table.groupId, table.userId),
    userIdx: index("group_members_user_idx").on(table.userId),
  }),
);

export const forwardAuthAccess = pgTable(
  "forward_auth_access",
  {
    id: serial("id").primaryKey(),
    proxyHostId: integer("proxyHostId")
      .references(() => proxyHosts.id, { onDelete: "cascade" })
      .notNull(),
    userId: integer("userId").references(() => users.id, { onDelete: "cascade" }),
    groupId: integer("groupId").references(() => groups.id, { onDelete: "cascade" }),
    createdAt: text("createdAt").notNull(),
  },
  (table) => ({
    hostIdx: index("faa_host_idx").on(table.proxyHostId),
    userUnique: uniqueIndex("faa_user_unique").on(table.proxyHostId, table.userId),
    groupUnique: uniqueIndex("faa_group_unique").on(table.proxyHostId, table.groupId),
  }),
);

export const forwardAuthSessions = pgTable(
  "forward_auth_sessions",
  {
    id: serial("id").primaryKey(),
    userId: integer("userId")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    proxyHostId: integer("proxyHostId")
      .references(() => proxyHosts.id, { onDelete: "cascade" })
      .notNull(),
    audienceOrigin: text("audienceOrigin").notNull(),
    tokenHash: text("tokenHash").notNull(),
    expiresAt: text("expiresAt").notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("fas_token_hash_unique").on(table.tokenHash),
    userIdx: index("fas_user_idx").on(table.userId),
    proxyHostIdx: index("fas_proxy_host_idx").on(table.proxyHostId),
    expiresIdx: index("fas_expires_idx").on(table.expiresAt),
  }),
);

export const forwardAuthExchanges = pgTable(
  "forward_auth_exchanges",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("sessionId")
      .references(() => forwardAuthSessions.id, { onDelete: "cascade" })
      .notNull(),
    proxyHostId: integer("proxyHostId")
      .references(() => proxyHosts.id, { onDelete: "cascade" })
      .notNull(),
    audienceOrigin: text("audienceOrigin").notNull(),
    codeHash: text("codeHash").notNull(),
    // Legacy compatibility column. Only a fixed placeholder is stored; the
    // replacement session token is generated at atomic redemption time.
    sessionToken: text("sessionToken").notNull(),
    redirectUri: text("redirectUri").notNull(),
    expiresAt: text("expiresAt").notNull(),
    used: boolean("used").notNull().default(false),
    createdAt: text("createdAt").notNull(),
  },
  (table) => ({
    codeHashUnique: uniqueIndex("fae_code_hash_unique").on(table.codeHash),
  }),
);

export const forwardAuthRedirectIntents = pgTable(
  "forward_auth_redirect_intents",
  {
    id: serial("id").primaryKey(),
    ridHash: text("ridHash").notNull(),
    proxyHostId: integer("proxyHostId")
      .references(() => proxyHosts.id, { onDelete: "cascade" })
      .notNull(),
    audienceOrigin: text("audienceOrigin").notNull(),
    redirectUri: text("redirectUri").notNull(),
    expiresAt: text("expiresAt").notNull(),
    consumed: boolean("consumed").notNull().default(false),
    createdAt: text("createdAt").notNull(),
  },
  (table) => ({
    ridHashUnique: uniqueIndex("fari_rid_hash_unique").on(table.ridHash),
    expiresIdx: index("fari_expires_idx").on(table.expiresAt),
  }),
);

// ── L4 Proxy Hosts ───────────────────────────────────────────────────

export const l4ProxyHosts = pgTable("l4_proxy_hosts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  protocol: text("protocol").notNull(),
  listenAddress: text("listenAddress").notNull(),
  upstreams: text("upstreams").notNull(),
  matcherType: text("matcherType").notNull().default("none"),
  matcherValue: text("matcherValue"),
  tlsTermination: boolean("tlsTermination").notNull().default(false),
  proxyProtocolVersion: text("proxyProtocolVersion"),
  proxyProtocolReceive: boolean("proxyProtocolReceive").notNull().default(false),
  ownerUserId: integer("ownerUserId").references(() => users.id, { onDelete: "set null" }),
  meta: text("meta"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

/**
 * Which agents serve a host.
 *
 * No rows for a host means every agent serves it, which is what the whole fleet did before this
 * table existed - so an upgrade changes nothing and an operator opts in per host. Many-to-many
 * rather than a column, because two edge nodes serving one host is an ordinary HA arrangement and
 * a single-valued assignment would forbid what the fleet-wide broadcast already allowed.
 */
export const proxyHostAgents = pgTable(
  "proxy_host_agents",
  {
    id: serial("id").primaryKey(),
    proxyHostId: integer("proxyHostId")
      .references(() => proxyHosts.id, { onDelete: "cascade" })
      .notNull(),
    agentId: integer("agentId")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (table) => ({
    pairUnique: uniqueIndex("proxy_host_agents_unique").on(table.proxyHostId, table.agentId),
    agentIdx: index("proxy_host_agents_agent_idx").on(table.agentId),
  }),
);

/** The same, for layer-4 hosts. Separate table because the two host tables are separate. */
export const l4ProxyHostAgents = pgTable(
  "l4_proxy_host_agents",
  {
    id: serial("id").primaryKey(),
    l4ProxyHostId: integer("l4ProxyHostId")
      .references(() => l4ProxyHosts.id, { onDelete: "cascade" })
      .notNull(),
    agentId: integer("agentId")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (table) => ({
    pairUnique: uniqueIndex("l4_proxy_host_agents_unique").on(table.l4ProxyHostId, table.agentId),
    agentIdx: index("l4_proxy_host_agents_agent_idx").on(table.agentId),
  }),
);

/**
 * IdP group names that resolve to a CPM group.
 *
 * The prefix convention on `oauth_providers` mirrors claimed groups by name, which works right up
 * until the IdP's name is not the one an operator wants to see - "AD-Infra-Proxy-Admins" against a
 * CPM group called "Networking". This table is that mapping written down: a CPM group can claim as
 * many external names as it likes, and the prefix convention keeps working for everything not
 * named here.
 *
 * `providerId` is nullable and means "any provider", for the deployment with one IdP that does not
 * want to restate it. Uniqueness is enforced in the model rather than by an index, because
 * PostgreSQL treats NULLs as distinct and a partial index per case would be two indexes saying one
 * thing.
 */
export const groupIdpMappings = pgTable(
  "group_idp_mappings",
  {
    id: serial("id").primaryKey(),
    groupId: integer("groupId")
      .references(() => groups.id, { onDelete: "cascade" })
      .notNull(),
    providerId: text("providerId").references(() => oauthProviders.id, { onDelete: "cascade" }),
    /** As the operator typed it, for display. */
    externalName: text("externalName").notNull(),
    /** Lower-cased and path-stripped, which is what claims are compared against. */
    externalKey: text("externalKey").notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (table) => ({
    groupIdx: index("group_idp_mappings_group_idx").on(table.groupId),
    keyIdx: index("group_idp_mappings_key_idx").on(table.externalKey),
  }),
);

/**
 * What a group is allowed to manage.
 *
 * Additive, never subtractive: a grant widens what an `operator` can reach and does nothing at all
 * to an `admin`, a `user` or a `viewer`. That is what makes this safe to ship - no existing user's
 * access changes until someone is deliberately moved to the operator role.
 *
 * One nullable column per resource kind rather than a polymorphic (type, id) pair, matching
 * `forward_auth_access`: it buys real foreign keys, so deleting a host takes its grants with it
 * instead of leaving a row pointing at an id something else will later reuse.
 */
export const groupGrants = pgTable(
  "group_grants",
  {
    id: serial("id").primaryKey(),
    groupId: integer("groupId")
      .references(() => groups.id, { onDelete: "cascade" })
      .notNull(),
    proxyHostId: integer("proxyHostId").references(() => proxyHosts.id, { onDelete: "cascade" }),
    l4ProxyHostId: integer("l4ProxyHostId").references(() => l4ProxyHosts.id, {
      onDelete: "cascade",
    }),
    agentId: integer("agentId").references(() => agents.id, { onDelete: "cascade" }),
    /** "view" or "manage". A manage grant implies view. */
    capability: text("capability").notNull().default("manage"),
    createdAt: text("createdAt").notNull(),
  },
  (table) => ({
    groupIdx: index("group_grants_group_idx").on(table.groupId),
    proxyHostUnique: uniqueIndex("group_grants_proxy_host_unique").on(
      table.groupId,
      table.proxyHostId,
    ),
    l4HostUnique: uniqueIndex("group_grants_l4_host_unique").on(table.groupId, table.l4ProxyHostId),
    agentUnique: uniqueIndex("group_grants_agent_unique").on(table.groupId, table.agentId),
  }),
);
