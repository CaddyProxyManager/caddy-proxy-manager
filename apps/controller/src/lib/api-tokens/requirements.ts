/**
 * The capability each API surface needs, checked in one place for REST (`requireApiUser`) and
 * GraphQL (`withRequirements`) rather than per route: the caller's role must hold it, and a
 * scoped token must cover its area too, so a token never does more than its owner may. Anything
 * not named here is refused to everyone - a new route or field stays closed until it is, and
 * `tests/unit/api-tokens/token-requirements.test.ts` says which.
 */
import { type Capability, type CapabilityResource, capabilityArea } from "../roles/capabilities";
import { type TokenAccess, type TokenArea, type TokenScope, scopeAllows } from "./scope";

export type TokenRequirement = {
  capability: Capability;
  area: TokenArea;
  access: TokenAccess;
  /** Only a full-scope token: no area grant covers it. */
  fullOnly?: true;
  /** Any token scope: it describes the API, nothing behind it. */
  anyToken?: true;
  /** The caller's own things, which any account may reach: the handler narrows to them. */
  signedIn?: true;
};

const need = (capability: Capability): TokenRequirement => ({
  capability,
  ...capabilityArea(capability),
});
const read = (resource: CapabilityResource) => need(`${resource}:read`);
const write = (resource: CapabilityResource) => need(`${resource}:write`);
/** Every private key, and writes to groups and grants: more than any one area. */
const full = (resource: CapabilityResource): TokenRequirement => ({
  ...write(resource),
  fullOnly: true,
});
const signedIn = (resource: CapabilityResource, access: TokenAccess): TokenRequirement => ({
  ...need(`${resource}:${access}`),
  signedIn: true,
});

/** Longest prefix first is not needed: no prefix here is a prefix of another's boundary. */
const REST_RESOURCES: ReadonlyArray<readonly [string, CapabilityResource]> = [
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
  ["/api/v1/groups", "groups"],
  ["/api/v1/forward-auth-sessions", "users"],
  ["/api/v1/sessions", "users"],
  ["/api/v1/settings", "settings"],
  ["/api/v1/oauth-providers", "settings"],
  ["/api/v1/dns-providers", "settings"],
  ["/api/v1/caddy", "settings"],
  ["/api/v1/backup", "backups"],
  ["/api/caddy-build", "settings"],
  ["/api/geoip-status", "settings"],
  ["/api/v1/audit-log", "audit"],
  ["/api/v1/tokens", "tokens"],
  ["/api/v1/openapi.json", "settings"],
];

/** The caller's own sessions and tokens, a credential-free catalog, and one's own account. */
function isSignedInOnly(pathname: string, verb: string): boolean {
  if (/^\/api\/v1\/(sessions|tokens)(\/|$)/.test(pathname)) return true;
  if (verb !== "GET" && verb !== "HEAD") return false;
  return pathname === "/api/v1/dns-providers" || /^\/api\/v1\/users\/[^/]+$/.test(pathname);
}

/**
 * GET and HEAD read. A backup, download or restore, needs a full token: it carries every secret
 * and restores users and grants, which no area covers.
 */
export function restRequirement(pathname: string, method: string): TokenRequirement | null {
  const match = REST_RESOURCES.find(
    ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (!match) return null;
  const resource = match[1];
  const verb = method.toUpperCase();
  if (resource === "backups") return full(resource);
  if (pathname === "/api/v1/openapi.json") return { ...read(resource), anyToken: true };
  const access: TokenAccess = verb === "GET" || verb === "HEAD" ? "read" : "write";
  if (isSignedInOnly(pathname, verb)) return signedIn(resource, access);
  return access === "read" ? read(resource) : write(resource);
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
  "Query.clientCertificateRoles": read("certificates"),
  "Query.mtlsRoles": read("certificates"),
  // Under /api/v1/proxy-hosts over REST: a rule is part of its host.
  "Query.mtlsAccessRules": read("hosts"),
  "Query.accessLists": read("accessLists"),
  "Query.accessList": read("accessLists"),
  "Query.accessListStats": read("accessLists"),
  "Query.users": read("users"),
  "Query.user": read("users"),
  // One's own, as /api/v1/sessions; the resolver asks for users:read before another's.
  "Query.sessions": signedIn("users", "read"),
  "Query.forwardAuthSessions": read("users"),
  "Query.forwardAuthAccess": read("hosts"),
  "Query.groups": read("groups"),
  "Query.signInOverview": read("users"),
  "Query.group": read("groups"),
  "Query.roles": read("roles"),
  "Query.role": read("roles"),
  "Query.capabilities": read("roles"),
  "Query.apiTokens": signedIn("tokens", "read"),
  "Query.agents": read("agents"),
  "Query.oauthProviders": read("settings"),
  "Query.dnsProviders": read("settings"),
  "Query.settings": read("settings"),
  "Query.caddyModules": read("settings"),
  "Query.auditLog": read("audit"),
  "Query.scimConnections": read("users"),
  // A reviewer needs no capability: the resolver answers only what the caller reviews.
  "Query.accessReviews": signedIn("users", "read"),
  "Query.accessReview": signedIn("users", "read"),
  // Narrowed to what the caller may see; a token that submitted a change can read its outcome.
  "Query.changeRequests": { ...signedIn("settings", "read"), anyToken: true },
  "Query.changeRequest": { ...signedIn("settings", "read"), anyToken: true },
  "Query.approvalPolicy": read("settings"),
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
  "Query.wafPresets": read("security"),
  "Query.crsPlugins": read("security"),
  "Query.crsPluginRegistry": read("security"),
  "Query.backupDestinations": read("backups"),
  "Query.backupSchedules": read("backups"),
  "Query.backupRuns": read("backups"),
  "Query.alertChannels": read("alerts"),
  "Query.alertRules": read("alerts"),
  "Query.alertHistory": read("alerts"),
  "Query.alertDigests": read("alerts"),
  "Query.alertDigestRuns": read("alerts"),
  "Query.previewAlertDigest": read("alerts"),
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
  "Mutation.createCertificate": write("certificates"),
  "Mutation.updateCertificate": write("certificates"),
  "Mutation.deleteCertificate": write("certificates"),
  "Mutation.rereadCertificate": write("certificates"),
  "Mutation.createCaCertificate": write("certificates"),
  "Mutation.deleteCaCertificate": write("certificates"),
  "Mutation.issueClientCertificate": write("certificates"),
  "Mutation.revokeClientCertificate": write("certificates"),
  "Mutation.createMtlsRole": write("certificates"),
  "Mutation.updateMtlsRole": write("certificates"),
  "Mutation.deleteMtlsRole": write("certificates"),
  "Mutation.addMtlsRoleCertificate": write("certificates"),
  "Mutation.removeMtlsRoleCertificate": write("certificates"),
  "Mutation.createMtlsAccessRule": write("hosts"),
  "Mutation.updateMtlsAccessRule": write("hosts"),
  "Mutation.deleteMtlsAccessRule": write("hosts"),
  "Mutation.createGroup": write("groups"),
  "Mutation.updateGroup": write("groups"),
  "Mutation.deleteGroup": write("groups"),
  "Mutation.addGroupMember": write("groups"),
  "Mutation.removeGroupMember": write("groups"),
  "Mutation.setGroupRole": write("groups"),
  "Mutation.createRole": write("roles"),
  "Mutation.updateRole": write("roles"),
  "Mutation.deleteRole": write("roles"),
  "Mutation.createUser": write("users"),
  "Mutation.updateUser": write("users"),
  "Mutation.deleteUser": write("users"),
  "Mutation.revokeSession": signedIn("users", "write"),
  "Mutation.revokeForwardAuthSession": write("users"),
  "Mutation.setForwardAuthAccess": write("hosts"),
  "Mutation.createApiToken": signedIn("tokens", "write"),
  "Mutation.deleteApiToken": signedIn("tokens", "write"),
  "Mutation.saveSettings": write("settings"),
  "Mutation.saveDnsProviderCredentials": write("settings"),
  "Mutation.removeDnsProvider": write("settings"),
  "Mutation.setDefaultDnsProvider": write("settings"),
  "Mutation.applyCaddyConfig": write("settings"),
  "Mutation.mintAgentPairingCode": write("agents"),
  "Mutation.unpairAgent": write("agents"),
  "Mutation.renameAgent": write("agents"),
  "Mutation.rebuildAgentCaddy": write("agents"),
  // Every private key out, and groups and grants in.
  "Mutation.exportConfig": full("backups"),
  "Mutation.previewConfigImport": full("backups"),
  "Mutation.applyConfigImport": full("backups"),
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
  "Mutation.createWafPreset": write("security"),
  "Mutation.updateWafPreset": write("security"),
  "Mutation.deleteWafPreset": write("security"),
  "Mutation.createCrsPlugin": write("security"),
  "Mutation.updateCrsPlugin": write("security"),
  "Mutation.deleteCrsPlugin": write("security"),
  "Mutation.updateCrsPluginFromRegistry": write("security"),
  "Mutation.checkCrsPluginRegistry": write("security"),
  "Mutation.setCrsPluginRegistrySettings": write("security"),
  // As PUT /api/v1/caddy/modules and the OAuth provider routes: both live under settings.
  "Mutation.setCaddyModules": write("settings"),
  "Mutation.createOAuthProvider": write("settings"),
  "Mutation.updateOAuthProvider": write("settings"),
  "Mutation.deleteOAuthProvider": write("settings"),
  // A backup carries every secret: whoever picks where it goes, or runs it, could take them all.
  "Mutation.createBackupDestination": full("backups"),
  "Mutation.updateBackupDestination": full("backups"),
  "Mutation.deleteBackupDestination": full("backups"),
  "Mutation.testBackupDestination": full("backups"),
  "Mutation.createBackupSchedule": full("backups"),
  "Mutation.updateBackupSchedule": full("backups"),
  "Mutation.deleteBackupSchedule": full("backups"),
  "Mutation.runBackupNow": full("backups"),
  "Mutation.createAlertChannel": write("alerts"),
  "Mutation.updateAlertChannel": write("alerts"),
  "Mutation.deleteAlertChannel": write("alerts"),
  "Mutation.testAlertChannel": write("alerts"),
  "Mutation.createAlertRule": write("alerts"),
  "Mutation.updateAlertRule": write("alerts"),
  "Mutation.deleteAlertRule": write("alerts"),
  "Mutation.silenceAlertRule": write("alerts"),
  "Mutation.testAlertRule": write("alerts"),
  "Mutation.createAlertDigest": write("alerts"),
  "Mutation.updateAlertDigest": write("alerts"),
  "Mutation.deleteAlertDigest": write("alerts"),
  "Mutation.sendAlertDigestNow": write("alerts"),
  // A sink receives the whole audit log, and security events with it: as much as reading both.
  "Mutation.createAuditSink": full("audit"),
  "Mutation.updateAuditSink": full("audit"),
  "Mutation.deleteAuditSink": full("audit"),
  "Mutation.testAuditSink": full("audit"),
  // A SCIM token makes accounts and fills groups: no area grant should mint one.
  "Mutation.createScimConnection": full("users"),
  "Mutation.updateScimConnection": full("users"),
  "Mutation.rotateScimConnectionToken": full("users"),
  "Mutation.deleteScimConnection": full("users"),
  "Mutation.createAccessReview": write("users"),
  "Mutation.updateAccessReview": write("users"),
  "Mutation.reassignAccessReviewItems": write("users"),
  "Mutation.deleteAccessReview": write("users"),
  "Mutation.decideAccessReviewItem": signedIn("users", "write"),
  // Revokes memberships, grants, tokens and connections as well as roles: more than one area.
  "Mutation.closeAccessReview": full("users"),
  "Mutation.confirmAccessReview": full("users"),
  // An approver is named by the policy, not a capability; deciding applies a change in any area.
  "Mutation.approveChangeRequest": { ...signedIn("settings", "write"), fullOnly: true },
  "Mutation.rejectChangeRequest": { ...signedIn("settings", "write"), fullOnly: true },
  "Mutation.bypassChangeRequest": { ...signedIn("settings", "write"), fullOnly: true },
  "Mutation.withdrawChangeRequest": signedIn("settings", "write"),
  "Mutation.setApprovalPolicy": write("settings"),
};

/** A session (no scope) or a full-scope token passes; a narrowed one needs the area. */
export function tokenAllows(
  scope: TokenScope | undefined,
  requirement: TokenRequirement | null,
): boolean {
  if (!scope || scope.kind === "full" || requirement?.anyToken) return true;
  if (requirement?.fullOnly) return false;
  return requirement !== null && scopeAllows(scope, requirement.area, requirement.access);
}

/**
 * Whether the role may: nothing unnamed, and the rest held outright. A scoped role holds hosts and
 * agents only per object, which the API does not filter by, so its grants reach the dashboard alone.
 */
export function roleAllows(
  can: (capability: Capability) => boolean,
  requirement: TokenRequirement | null,
): boolean {
  if (requirement === null) return false;
  return requirement.signedIn === true || can(requirement.capability);
}
