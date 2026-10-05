/**
 * Rows stay English (`/api/v1/audit-log` is a machine contract), so each summary shape is parsed
 * back here and rendered from `auditLog.summaries.*`; unrecognised ones show as stored. Keys are
 * composed at runtime, so tests/unit/audit-summary-messages.test.ts round-trips every pattern.
 */

import type { useTranslations } from "next-intl";

type Translator = ReturnType<typeof useTranslations>;

/** The one place key narrowing is given up: the keys are composed at runtime. */
type DynamicTranslate = (key: string, values?: Record<string, string>) => string;

export type AuditSummaryPattern = {
  entityType: string;
  action: string;
  message: string;
  /** Anchored; each named group is one of the message's parameters. */
  pattern: RegExp;
};

/** Created / Updated / Deleted `<noun> <name>`, the shape every named model logs. */
function lifecycle(entityType: string, noun: string, messagePrefix: string): AuditSummaryPattern[] {
  return [
    ["create", "Created"],
    ["update", "Updated"],
    ["delete", "Deleted"],
  ].map(([action, verb]) => ({
    entityType,
    action,
    message: `${messagePrefix}${verb}`,
    pattern: new RegExp(`^${verb} ${noun} (?<name>.+)$`, "s"),
  }));
}

export const AUDIT_SUMMARY_PATTERNS: readonly AuditSummaryPattern[] = [
  ...lifecycle("proxy_host", "proxy host", "proxyHost"),
  ...lifecycle("l4_proxy_host", "L4 proxy host", "l4ProxyHost"),
  ...lifecycle("certificate", "certificate", "certificate"),
  ...lifecycle("ca_certificate", "CA certificate", "caCertificate"),
  ...lifecycle("mtls_role", "mTLS role", "mtlsRole"),
  ...lifecycle("access_list", "access list", "accessList"),
  ...lifecycle("group", "group", "group"),
  ...lifecycle("waf_preset", "WAF preset", "wafPreset"),
  // settings/ldap-actions.ts
  ...lifecycle("ldap_directory", "directory", "ldapDirectory"),
  // models/analytics-views.ts
  ...lifecycle("analytics_view", "analytics view", "analyticsView"),
  {
    entityType: "analytics_view",
    action: "update",
    message: "analyticsViewRenamed",
    pattern: /^Renamed analytics view (?<from>.+) to (?<to>.+)$/s,
  },

  // setup-checklist/index.ts
  {
    entityType: "setup_checklist",
    action: "update",
    message: "setupStepDone",
    pattern: /^Marked setup step (?<step>\S+) done$/,
  },
  {
    entityType: "setup_checklist",
    action: "update",
    message: "setupStepUndone",
    pattern: /^Marked setup step (?<step>\S+) not done$/,
  },
  {
    entityType: "setup_checklist",
    action: "update",
    message: "setupChecklistHidden",
    pattern: /^Hid the setup checklist$/,
  },
  {
    entityType: "setup_checklist",
    action: "update",
    message: "setupChecklistShown",
    pattern: /^Showed the setup checklist$/,
  },

  // models/proxy-hosts.ts, the row menu's maintenance switch
  {
    entityType: "proxy_host",
    action: "update",
    message: "proxyHostMaintenanceOn",
    pattern: /^Turned on maintenance mode for proxy host (?<name>.+)$/s,
  },
  {
    entityType: "proxy_host",
    action: "update",
    message: "proxyHostMaintenanceOff",
    pattern: /^Turned off maintenance mode for proxy host (?<name>.+)$/s,
  },

  // models/crs-plugins.ts
  {
    entityType: "crs_plugin",
    action: "create",
    message: "crsPluginInstalled",
    pattern: /^Installed CRS plugin (?<name>\S+) (?<version>.+)$/s,
  },
  {
    entityType: "crs_plugin",
    action: "update",
    message: "crsPluginUpdated",
    pattern: /^Updated CRS plugin (?<name>\S+) to (?<version>.+)$/s,
  },
  {
    entityType: "crs_plugin",
    action: "update",
    message: "crsPluginConfigured",
    pattern: /^Configured CRS plugin (?<name>.+)$/s,
  },
  {
    entityType: "crs_plugin",
    action: "update",
    message: "crsPluginDisabled",
    pattern: /^Disabled CRS plugin (?<name>\S+): Caddy refused to load it$/s,
  },
  {
    entityType: "crs_plugin",
    action: "update",
    message: "crsPluginReenabled",
    pattern: /^Re-enabled CRS plugin (?<name>.+)$/s,
  },
  {
    entityType: "crs_plugin",
    action: "delete",
    message: "crsPluginUninstalled",
    pattern: /^Uninstalled CRS plugin (?<name>.+)$/s,
  },

  // users/actions.ts
  {
    entityType: "user",
    action: "create",
    message: "userCreated",
    pattern: /^Created user (?<id>.+?) \((?<email>.+)\) with role (?<role>.+)$/s,
  },
  {
    entityType: "user",
    action: "update",
    message: "userRoleChanged",
    pattern: /^Changed user (?<id>.+?) role to (?<role>.+)$/s,
  },
  {
    entityType: "user",
    action: "update",
    message: "userStatusChanged",
    pattern: /^Changed user (?<id>.+?) status to (?<status>.+)$/s,
  },
  {
    entityType: "user",
    action: "update",
    message: "userProfileUpdated",
    pattern: /^Updated user (?<id>.+) profile$/s,
  },
  {
    entityType: "user",
    action: "update",
    message: "userSignInUsernameChanged",
    pattern: /^Changed user (?<id>.+?) sign-in username to (?<username>.+)$/s,
  },
  {
    entityType: "user",
    action: "delete",
    message: "userDeleted",
    pattern: /^Deleted user (?<id>.+)$/s,
  },

  // groups/actions.ts and models/groups.ts
  {
    entityType: "group",
    action: "update",
    message: "groupMappingsUpdated",
    pattern: /^Updated the IdP group mappings for group (?<id>.+)$/s,
  },
  {
    entityType: "group",
    action: "update",
    message: "groupGrantsUpdated",
    pattern: /^Updated the management grants for group (?<id>.+)$/s,
  },
  {
    entityType: "group_member",
    action: "create",
    message: "groupMemberAdded",
    pattern: /^Added user (?<id>.+?) to group (?<group>.+)$/s,
  },
  {
    entityType: "group_member",
    action: "delete",
    message: "groupMemberRemoved",
    pattern: /^Removed user (?<id>.+?) from group (?<group>.+)$/s,
  },

  // models/mtls-roles.ts, mtls-access-rules.ts, issued-client-certificates.ts
  {
    entityType: "mtls_certificate_role",
    action: "assign",
    message: "mtlsCertificateAssigned",
    pattern: /^Assigned cert (?<cert>.+?) to role (?<role>.+)$/s,
  },
  {
    entityType: "mtls_certificate_role",
    action: "unassign",
    message: "mtlsCertificateUnassigned",
    pattern: /^Removed cert from role (?<role>.+)$/s,
  },
  {
    entityType: "mtls_access_rule",
    action: "create",
    message: "mtlsAccessRuleCreated",
    pattern: /^Created mTLS access rule for path (?<path>.+?) on proxy host (?<hostId>.+)$/s,
  },
  {
    entityType: "mtls_access_rule",
    action: "update",
    message: "mtlsAccessRuleUpdated",
    pattern: /^Updated mTLS access rule for path (?<path>.+)$/s,
  },
  {
    entityType: "mtls_access_rule",
    action: "delete",
    message: "mtlsAccessRuleDeleted",
    pattern: /^Deleted mTLS access rule for path (?<path>.+)$/s,
  },
  {
    entityType: "issued_client_certificate",
    action: "create",
    message: "clientCertificateIssued",
    pattern: /^Issued client certificate (?<name>.+)$/s,
  },
  {
    entityType: "issued_client_certificate",
    action: "revoke",
    message: "clientCertificateRevoked",
    pattern: /^Revoked client certificate (?<name>.+)$/s,
  },

  // models/access-lists.ts and models/forward-auth.ts
  {
    entityType: "access_list_entry",
    action: "create",
    message: "accessListEntryAdded",
    pattern: /^Added user (?<username>.+?) to access list (?<list>.+)$/s,
  },
  {
    entityType: "access_list_entry",
    action: "delete",
    message: "accessListEntryRemoved",
    pattern: /^Removed entry from access list (?<list>.+)$/s,
  },
  {
    entityType: "forward_auth_access",
    action: "update",
    message: "forwardAuthAccessUpdated",
    pattern: /^Updated forward auth access for proxy host (?<id>.+)$/s,
  },

  // api/forward-auth/login and session-login
  {
    entityType: "user",
    action: "forward_auth_login_failed",
    message: "forwardAuthLoginFailedUsername",
    pattern: /^Forward auth login failed for username: (?<username>.+)$/s,
  },
  {
    entityType: "user",
    action: "forward_auth_login_failed",
    message: "forwardAuthLoginFailed",
    pattern: /^Forward auth login failed for user (?<email>.+)$/s,
  },
  {
    entityType: "user",
    action: "forward_auth_login_failed",
    message: "forwardAuthSecondFactorFailed",
    pattern: /^Forward auth second factor failed for user (?<email>.+)$/s,
  },
  {
    entityType: "proxy_host",
    action: "forward_auth_access_denied",
    message: "forwardAuthAccessDenied",
    pattern: /^Forward auth access denied for user (?<email>.+?) to host (?<host>.+)$/s,
  },
  {
    entityType: "user",
    action: "forward_auth_login",
    message: "forwardAuthLogin",
    pattern: /^Forward auth login for user (?<email>.+?) to (?<host>.+)$/s,
  },
  {
    entityType: "user",
    action: "forward_auth_login",
    message: "forwardAuthSessionLogin",
    pattern: /^Forward auth login \(session\) for user (?<email>.+?) to (?<host>.+)$/s,
  },

  // services/oidc-logout.ts and oidc-group-sync.ts
  {
    entityType: "user",
    action: "oidc_backchannel_logout",
    message: "oidcBackchannelLogout",
    pattern: /^Sessions for user (?<id>.+?) ended by a back-channel logout from (?<provider>.+)$/s,
  },
  {
    entityType: "user",
    action: "oidc_role_sync_skipped",
    message: "oidcRoleSyncSkipped",
    pattern:
      /^Kept admin role for user (?<id>.+?): (?<provider>.+) groups mapped to "(?<role>.+)" but no other active admin exists$/s,
  },
  {
    entityType: "user",
    action: "oidc_role_sync",
    message: "oidcRoleSync",
    pattern:
      /^Role for user (?<id>.+?) set to "(?<role>.+?)" from (?<provider>.+) groups \(was "(?<previous>.+)"\)$/s,
  },
  // Both halves first, or the added-only pattern swallows "; removed from ..." as groups.
  {
    entityType: "user",
    action: "oidc_group_sync",
    message: "oidcGroupSyncAddedRemoved",
    pattern:
      /^Group membership for user (?<id>.+?) synced from (?<provider>.+?): added to (?<added>.+?); removed from (?<removed>.+)$/s,
  },
  {
    entityType: "user",
    action: "oidc_group_sync",
    message: "oidcGroupSyncAdded",
    pattern:
      /^Group membership for user (?<id>.+?) synced from (?<provider>.+?): added to (?<added>.+)$/s,
  },
  {
    entityType: "user",
    action: "oidc_group_sync",
    message: "oidcGroupSyncRemoved",
    pattern:
      /^Group membership for user (?<id>.+?) synced from (?<provider>.+?): removed from (?<removed>.+)$/s,
  },

  // lib/setup.ts and lib/auth/server.ts
  {
    entityType: "user",
    action: "setup_first_admin",
    message: "setupFirstAdmin",
    pattern: /^User (?<id>.+) became the first administrator by signing in during setup$/s,
  },
  {
    entityType: "session",
    action: "login_success",
    message: "loginSuccess",
    pattern: /^User signed in$/,
  },

  // settings/actions.ts
  {
    entityType: "oauth_provider",
    action: "oauth_provider_created",
    message: "oauthProviderCreatedFromSettings",
    pattern: /^OAuth provider "(?<name>.+)" created$/s,
  },
  {
    entityType: "oauth_provider",
    action: "oauth_provider_updated",
    message: "oauthProviderMadePrimary",
    pattern: /^Made OAuth provider "(?<id>.+)" primary$/s,
  },
  {
    entityType: "oauth_provider",
    action: "oauth_provider_updated",
    message: "oauthProviderPrimaryCleared",
    pattern: /^Cleared the primary OAuth provider$/,
  },
  {
    entityType: "oauth_provider",
    action: "oauth_provider_updated",
    message: "oauthProviderUpdated",
    pattern: /^Updated OAuth provider "(?<name>.+)"$/s,
  },
  {
    entityType: "oauth_provider",
    action: "oauth_provider_deleted",
    message: "oauthProviderDeleted",
    pattern: /^Deleted OAuth provider "(?<name>.+)"$/s,
  },

  // api/v1/oauth-providers
  {
    entityType: "oauth_provider",
    action: "create",
    message: "oauthProviderCreated",
    pattern: /^Created OAuth provider "(?<name>.+)"$/s,
  },
  {
    entityType: "oauth_provider",
    action: "update",
    message: "oauthProviderUpdated",
    pattern: /^Updated OAuth provider "(?<name>.+)"$/s,
  },
  {
    entityType: "oauth_provider",
    action: "delete",
    message: "oauthProviderDeleted",
    pattern: /^Deleted OAuth provider "(?<name>.+)"$/s,
  },

  // api/user/*
  {
    entityType: "user",
    action: "password_changed",
    message: "passwordChanged",
    pattern: /^User changed their password$/,
  },
  {
    entityType: "certificate",
    action: "certificate_renew_requested",
    message: "certificateRenewRequested",
    pattern: /^Asked Caddy to renew the certificate for (?<name>.+)$/s,
  },
  // models/certificate-files.ts: an agent read a renewed certificate from its files
  {
    entityType: "certificate",
    action: "certificate_file_renewed",
    message: "certificateFileRenewed",
    pattern: /^Read a new version of certificate (?<name>.+)$/s,
  },
  {
    entityType: "certificate",
    action: "certificate_file_names_changed",
    message: "certificateFileNamesChanged",
    pattern: /^Read a new version of certificate (?<name>.+) with different names$/s,
  },
  {
    entityType: "certificate",
    action: "certificate_key_exported",
    message: "certificateKeyExported",
    pattern: /^Downloaded the private key of the certificate for (?<name>.+)$/s,
  },
  {
    entityType: "backup",
    action: "backup_created",
    message: "backupCreated",
    pattern: /^Downloaded a configuration backup$/,
  },
  {
    entityType: "backup",
    action: "backup_restored",
    message: "backupRestored",
    pattern: /^Restored the configuration from a backup$/,
  },
  {
    entityType: "session",
    action: "view_as_started",
    message: "viewAsStarted",
    pattern: /^Started viewing the dashboard as (?<role>\S+)$/,
  },
  {
    entityType: "session",
    action: "view_as_stopped",
    message: "viewAsStopped",
    pattern: /^Stopped viewing the dashboard as (?<role>\S+)$/,
  },
  {
    entityType: "user",
    action: "two_factor_enabled",
    message: "twoFactorEnabled",
    pattern: /^User turned on two-factor sign-in$/,
  },
  {
    entityType: "user",
    action: "two_factor_disabled",
    message: "twoFactorDisabled",
    pattern: /^User turned off two-factor sign-in$/,
  },
  {
    entityType: "user",
    action: "two_factor_backup_codes",
    message: "twoFactorBackupCodes",
    pattern: /^User replaced their backup codes$/,
  },
  {
    entityType: "user",
    action: "two_factor_reset",
    message: "twoFactorReset",
    pattern: /^Two-factor sign-in reset for user (?<email>.+?) by an administrator$/s,
  },
  {
    entityType: "user",
    action: "two_factor_reset",
    message: "twoFactorResetConsole",
    pattern: /^Two-factor sign-in reset for user (?<email>.+?) from the server console$/s,
  },
  // lib/auth/account-failures.ts, and `cpm-server --enable-user`
  {
    entityType: "user",
    action: "user_disabled_failed_sign_ins",
    message: "userDisabledFailedSignIns",
    pattern: /^Disabled user (?<email>.+?) after (?<count>.+?) failed sign-ins$/s,
  },
  {
    entityType: "user",
    action: "user_enabled_console",
    message: "userEnabledConsole",
    pattern: /^Enabled user (?<email>.+?) from the server console$/s,
  },
  // app/api/auth/[...all]/route.ts, users/actions.ts, the console reset
  {
    entityType: "user",
    action: "passkey_added",
    message: "passkeyAdded",
    pattern: /^User added a passkey$/,
  },
  {
    entityType: "user",
    action: "passkey_removed",
    message: "passkeyRemoved",
    pattern: /^User removed a passkey$/,
  },
  {
    entityType: "user",
    action: "passkey_removed",
    message: "passkeysRemoved",
    pattern: /^Passkeys removed for user (?<email>.+?) by an administrator$/s,
  },
  {
    entityType: "user",
    action: "passkey_removed",
    message: "passkeysRemovedConsole",
    pattern: /^Passkeys removed for user (?<email>.+?) from the server console$/s,
  },
  {
    entityType: "user",
    action: "password_set",
    message: "passwordSet",
    pattern: /^User set a password$/,
  },

  // services/emailed-links.ts
  {
    entityType: "user",
    action: "password_set",
    message: "passwordSetFromInvite",
    pattern: /^User set a password from an invitation$/,
  },
  {
    entityType: "user",
    action: "password_reset",
    message: "passwordReset",
    pattern: /^User reset their password from an emailed link$/,
  },
  {
    entityType: "user",
    action: "password_reset_requested",
    message: "passwordResetRequested",
    pattern: /^User asked for a password reset link$/,
  },
  {
    entityType: "user",
    action: "password_link_sent",
    message: "passwordLinkSent",
    pattern: /^Emailed a password link to user (?<email>.+)$/s,
  },
  {
    entityType: "user",
    action: "password_removed",
    message: "passwordRemoved",
    pattern: /^User removed their password; signs in with (?<providers>.+)$/s,
  },
  {
    entityType: "user",
    action: "oauth_unlinked",
    message: "oauthUnlinked",
    pattern: /^User unlinked OAuth account: (?<provider>.+)$/s,
  },
  {
    entityType: "user",
    action: "avatar_updated",
    message: "avatarUpdated",
    pattern: /^User updated profile picture$/,
  },
  {
    entityType: "user",
    action: "avatar_deleted",
    message: "avatarDeleted",
    pattern: /^User removed profile picture$/,
  },
];

export function matchAuditSummary(event: {
  action: string;
  entityType: string;
  summary: string | null;
}): { message: string; values: Record<string, string> } | null {
  const { summary } = event;
  if (summary === null) return null;
  for (const candidate of AUDIT_SUMMARY_PATTERNS) {
    if (candidate.entityType !== event.entityType || candidate.action !== event.action) continue;
    const match = candidate.pattern.exec(summary);
    if (match) return { message: candidate.message, values: { ...match.groups } };
  }
  return null;
}

/** The stored summary when it is not recognised. */
export function auditSummaryText(
  t: Translator,
  event: { action: string; entityType: string; summary: string | null },
): string | null {
  const match = matchAuditSummary(event);
  if (!match) return event.summary;
  return (t as unknown as DynamicTranslate)(`auditLog.summaries.${match.message}`, match.values);
}
