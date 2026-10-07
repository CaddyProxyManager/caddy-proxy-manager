/**
 * Which area each API surface belongs to, so a scoped token is checked in one place rather than
 * per route. Anything not listed is refused to a narrowed token: a new route or field stays closed
 * until it is named here, and `tests/unit/api-tokens/token-requirements.test.ts` says which.
 */
import { type TokenAccess, type TokenArea, type TokenScope, scopeAllows } from "./scope";

export type TokenRequirement = {
  area: TokenArea;
  access: TokenAccess;
  /** Only a full-scope token: no area grant covers it. */
  fullOnly?: true;
};

const read = (area: TokenArea): TokenRequirement => ({ area, access: "read" });
const write = (area: TokenArea): TokenRequirement => ({ area, access: "write" });
/** Every private key, and writes to groups and grants: more than any one area. */
const full = (area: TokenArea): TokenRequirement => ({ area, access: "write", fullOnly: true });

/** Longest prefix first is not needed: no prefix here is a prefix of another's area boundary. */
const REST_AREAS: ReadonlyArray<readonly [string, TokenArea]> = [
  ["/api/v1/proxy-hosts", "hosts"],
  ["/api/v1/l4-proxy-hosts", "hosts"],
  ["/api/l4-ports", "hosts"],
  ["/api/v1/access-lists", "accessLists"],
  ["/api/v1/certificates", "certificates"],
  ["/api/v1/ca-certificates", "certificates"],
  ["/api/v1/client-certificates", "certificates"],
  ["/api/v1/mtls-roles", "certificates"],
  ["/api/v1/crs-plugins", "security"],
  ["/api/v1/waf-presets", "security"],
  ["/api/waf-events", "security"],
  ["/api/analytics", "analytics"],
  ["/api/v1/users", "users"],
  ["/api/v1/groups", "users"],
  ["/api/v1/forward-auth-sessions", "users"],
  ["/api/v1/sessions", "users"],
  ["/api/v1/settings", "settings"],
  ["/api/v1/oauth-providers", "settings"],
  ["/api/v1/dns-providers", "settings"],
  ["/api/v1/caddy", "settings"],
  ["/api/v1/backup", "settings"],
  ["/api/caddy-build", "settings"],
  ["/api/geoip-status", "settings"],
  ["/api/v1/audit-log", "audit"],
  ["/api/v1/tokens", "tokens"],
];

/** Describes the API, nothing behind it. */
const ANY_TOKEN_PATHS = new Set(["/api/v1/openapi.json"]);

/**
 * GET and HEAD read. A backup, download or restore, needs a full token: it carries every secret
 * and restores users and grants, which no area covers.
 */
export function restRequirement(pathname: string, method: string): TokenRequirement | "any" | null {
  if (ANY_TOKEN_PATHS.has(pathname)) return "any";
  const match = REST_AREAS.find(
    ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (!match) return null;
  const area = match[1];
  if (pathname === "/api/v1/backup" || pathname.startsWith("/api/v1/backup/")) return full(area);
  const verb = method.toUpperCase();
  return verb === "GET" || verb === "HEAD" ? read(area) : write(area);
}

/** `Type.field`. Agent mutations and the subscription authenticate as agents and are not here. */
export const GRAPHQL_REQUIREMENTS: Readonly<Record<string, TokenRequirement>> = {
  "Query.proxyHosts": read("hosts"),
  "Query.proxyHost": read("hosts"),
  "Query.proxyHostUpstreamHealth": read("hosts"),
  "Query.proxyHostTraffic": read("hosts"),
  "Query.l4ProxyHosts": read("hosts"),
  "Query.l4ProxyHost": read("hosts"),
  "Query.hostRevisions": read("hosts"),
  "Query.hostRevision": read("hosts"),
  "Query.compareHostRevisions": read("hosts"),
  "Query.deletedHosts": read("hosts"),
  "Query.certificates": read("certificates"),
  "Query.certificate": read("certificates"),
  "Query.caCertificates": read("certificates"),
  "Query.clientCertificates": read("certificates"),
  "Query.mtlsRoles": read("certificates"),
  "Query.accessLists": read("accessLists"),
  "Query.accessList": read("accessLists"),
  "Query.accessListStats": read("accessLists"),
  "Query.users": read("users"),
  "Query.user": read("users"),
  "Query.groups": read("users"),
  "Query.signInOverview": read("users"),
  "Query.group": read("users"),
  "Query.apiTokens": read("tokens"),
  "Query.agents": read("agents"),
  "Query.oauthProviders": read("settings"),
  "Query.dnsProviders": read("settings"),
  "Query.settings": read("settings"),
  "Query.caddyModules": read("settings"),
  "Query.auditLog": read("audit"),
  "Query.analyticsReport": read("analytics"),
  "Query.analyticsTopList": read("analytics"),
  "Query.trafficSignals": read("analytics"),
  "Query.analyticsViews": read("analytics"),
  "Query.attention": read("overview"),
  "Query.setupChecklist": read("overview"),
  "Query.wafExclusions": read("security"),
  "Query.wafEvent": read("security"),
  "Query.securityReport": read("security"),
  "Query.blockedSources": read("security"),
  "Query.backupDestinations": read("settings"),
  "Query.backupSchedules": read("settings"),
  "Query.backupRuns": read("settings"),
  "Query.alertChannels": read("settings"),
  "Query.alertRules": read("settings"),
  "Query.alertHistory": read("settings"),
  "Query.alertDigests": read("settings"),
  "Query.alertDigestRuns": read("settings"),
  "Query.previewAlertDigest": read("settings"),
  "Query.auditSinks": read("audit"),

  "Mutation.createProxyHost": write("hosts"),
  "Mutation.updateProxyHost": write("hosts"),
  "Mutation.deleteProxyHost": write("hosts"),
  // Stores nothing, but it is how a change is made: a read-only token has no use for it.
  "Mutation.previewProxyHost": write("hosts"),
  "Mutation.bulkProxyHosts": write("hosts"),
  "Mutation.createL4ProxyHost": write("hosts"),
  "Mutation.updateL4ProxyHost": write("hosts"),
  "Mutation.deleteL4ProxyHost": write("hosts"),
  "Mutation.previewL4ProxyHost": write("hosts"),
  "Mutation.bulkL4ProxyHosts": write("hosts"),
  "Mutation.rollbackHost": write("hosts"),
  "Mutation.restoreHost": write("hosts"),
  "Mutation.createAccessList": write("accessLists"),
  "Mutation.updateAccessList": write("accessLists"),
  "Mutation.deleteAccessList": write("accessLists"),
  "Mutation.setAccessListRules": write("accessLists"),
  "Mutation.createGroup": write("users"),
  "Mutation.updateGroup": write("users"),
  "Mutation.deleteGroup": write("users"),
  "Mutation.addGroupMember": write("users"),
  "Mutation.removeGroupMember": write("users"),
  "Mutation.updateUser": write("users"),
  "Mutation.deleteUser": write("users"),
  "Mutation.createApiToken": write("tokens"),
  "Mutation.deleteApiToken": write("tokens"),
  "Mutation.saveSettings": write("settings"),
  "Mutation.applyCaddyConfig": write("settings"),
  // Every private key out, and groups and grants in.
  "Mutation.exportConfig": full("settings"),
  "Mutation.previewConfigImport": full("settings"),
  "Mutation.applyConfigImport": full("settings"),
  // Writes an audit event.
  "Mutation.verifyAuditChain": write("audit"),
  "Mutation.createAnalyticsView": write("analytics"),
  "Mutation.updateAnalyticsView": write("analytics"),
  "Mutation.deleteAnalyticsView": write("analytics"),
  "Mutation.setSetupStepDone": write("overview"),
  "Mutation.setSetupChecklistHidden": write("overview"),
  "Mutation.createWafExclusion": write("security"),
  "Mutation.updateWafExclusion": write("security"),
  "Mutation.deleteWafExclusion": write("security"),
  "Mutation.reviewWafEvent": write("security"),
  "Mutation.createBlockedSource": write("security"),
  "Mutation.deleteBlockedSource": write("security"),
  // A backup carries every secret: whoever picks where it goes, or runs it, could take them all.
  "Mutation.createBackupDestination": full("settings"),
  "Mutation.updateBackupDestination": full("settings"),
  "Mutation.deleteBackupDestination": full("settings"),
  "Mutation.testBackupDestination": full("settings"),
  "Mutation.createBackupSchedule": full("settings"),
  "Mutation.updateBackupSchedule": full("settings"),
  "Mutation.deleteBackupSchedule": full("settings"),
  "Mutation.runBackupNow": full("settings"),
  "Mutation.createAlertChannel": write("settings"),
  "Mutation.updateAlertChannel": write("settings"),
  "Mutation.deleteAlertChannel": write("settings"),
  "Mutation.testAlertChannel": write("settings"),
  "Mutation.createAlertRule": write("settings"),
  "Mutation.updateAlertRule": write("settings"),
  "Mutation.deleteAlertRule": write("settings"),
  "Mutation.silenceAlertRule": write("settings"),
  "Mutation.testAlertRule": write("settings"),
  "Mutation.createAlertDigest": write("settings"),
  "Mutation.updateAlertDigest": write("settings"),
  "Mutation.deleteAlertDigest": write("settings"),
  "Mutation.sendAlertDigestNow": write("settings"),
  // A sink receives the whole audit log, and security events with it: as much as reading both.
  "Mutation.createAuditSink": full("audit"),
  "Mutation.updateAuditSink": full("audit"),
  "Mutation.deleteAuditSink": full("audit"),
  "Mutation.testAuditSink": full("audit"),
};

/** A session (no scope) or a full-scope token passes; a narrowed one needs the area. */
export function tokenAllows(
  scope: TokenScope | undefined,
  requirement: TokenRequirement | "any" | null,
): boolean {
  if (!scope || scope.kind === "full" || requirement === "any") return true;
  if (requirement?.fullOnly) return false;
  return requirement !== null && scopeAllows(scope, requirement.area, requirement.access);
}
