/**
 * Every database-backed setting, described once; setup, Settings and migration all render from it.
 *
 * Deliberately not here:
 * - `OAUTH_*`: `runEnvProviderSync` writes them to `oauth_providers`; a second source of truth.
 * - `CERTS_DIRECTORY`, `ACME_CA_ROOT_DIR`, `L4_PORTS_DIR`: host paths that belong to the agent.
 * - `DEMO_MODE`: stored, anyone with Settings access could turn the demo real.
 * - Anything read before the database can be: connection string and pool size, `SESSION_SECRET`
 *   (it encrypts the database's secrets), `NODE_ENV`, `PORT`/`HOST`, bootstrap paths, whatever
 *   Compose reads on the host, and the agent's pre-database config.
 */

import { EMAIL_ADDRESS } from "../email-address";
import { SMTP_SECURITY_MODES } from "../email/security";
import { hasForbiddenControlCharacter } from "../settings-validation";

export type SettingGroup = "application" | "authentication" | "email" | "analytics" | "geoip";

/** A value as stored, before it is parsed. Settings are held as JSON in the `settings` table. */
export type SettingValue = string | number | boolean | null;

export type SettingDefinition<T extends SettingValue = SettingValue> = {
  /** Storage key, namespaced so these never collide with the JSON blobs already in the table. */
  key: string;
  /** The variable this was configured by, still honored as an override until it is removed. */
  env: string;
  group: SettingGroup;
  label: string;
  /** Shown under the field. Say what changes when it changes, not what the type is. */
  description: string;
  default: T;
  /** Encrypted at rest, and never sent to the browser in full. */
  secret?: boolean;
  /** A secret this deployment chooses for itself, so the UI may offer to generate one. */
  generatable?: boolean;
  /**
   * Compose reads this variable too, to provision `clickhouse`, and cannot read the database, so
   * the migration flow lists these separately rather than commenting them out of `.env`.
   */
  composeReads?: boolean;
  /** Switches its whole group on and off; the rest render only once it is on. One per group. */
  gate?: boolean;
  /** The bounds `parse` enforces, so a control built from them cannot disagree with it. */
  min?: number;
  max?: number;
  maxLength?: number;
  /** Read the environment variable's raw string. Throws through `parse` on a bad value. */
  fromEnv: (raw: string) => T;
  /** Validate a value from the API or the setup form. Throws `SettingValidationError`. */
  parse: (value: unknown) => T;
};

/** Why a value was refused. Rendered by `settings.validation.<code>` in the message catalog. */
export type SettingValidationCode =
  | "boolean"
  | "tristate"
  | "text"
  | "tooLong"
  | "controlCharacter"
  | "pattern"
  | "wholeNumber"
  | "range"
  | "unknown";

/**
 * A code, not a sentence: a translation cannot paste the label before a predicate. `message` stays
 * English for logs and startup env parsing; a caller with a locale renders `code`.
 */
export class SettingValidationError extends Error {
  constructor(
    readonly settingKey: string,
    readonly code: SettingValidationCode,
    /** ICU arguments; `label` is English, so a renderer swaps in the translated one first. */
    readonly params: Record<string, string | number>,
    message: string,
  ) {
    super(message);
    this.name = "SettingValidationError";
  }
}

const KEY_PREFIX = "config:";

type Common<T extends SettingValue> = {
  name: string;
  env: string;
  group: SettingGroup;
  label: string;
  description: string;
  default: T;
  composeReads?: boolean;
};

/** The English wording, also the source the `settings.validation.*` messages were written from. */
const VALIDATION_WORDING: Record<SettingValidationCode, string> = {
  boolean: "{label} must be true or false",
  tristate: "{label} must be true, false, or left unset",
  text: "{label} must be text",
  tooLong: "{label} must be {max} characters or fewer",
  controlCharacter: "{label} contains a control character",
  pattern: "{label} {hint}",
  wholeNumber: "{label} must be a whole number",
  range: "{label} must be between {min} and {max}",
  unknown: 'Unknown setting "{label}"',
};

function reject(
  key: string,
  code: SettingValidationCode,
  params: Record<string, string | number>,
): never {
  const message = VALIDATION_WORDING[code].replace(/\{(\w+)\}/g, (whole, name) =>
    name in params ? String(params[name]) : whole,
  );
  throw new SettingValidationError(key, code, params, message);
}

export function booleanSetting(spec: Common<boolean>): SettingDefinition<boolean> {
  const key = `${KEY_PREFIX}${spec.name}`;
  const parse = (value: unknown): boolean => {
    if (typeof value === "boolean") return value;
    // The form posts checkboxes as strings, and the environment has nothing else to offer.
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "off", ""].includes(normalized)) return false;
    }
    return reject(key, "boolean", { label: spec.label });
  };
  return { ...spec, key, parse, fromEnv: parse };
}

export function stringSetting(
  spec: Common<string> & { maxLength?: number; pattern?: RegExp; patternHint?: string },
): SettingDefinition<string> {
  const key = `${KEY_PREFIX}${spec.name}`;
  const maxLength = spec.maxLength ?? 2048;
  const parse = (value: unknown): string => {
    if (value === null || value === undefined) return spec.default;
    if (typeof value !== "string") return reject(key, "text", { label: spec.label });
    const trimmed = value.trim();
    if (trimmed.length > maxLength) {
      return reject(key, "tooLong", { label: spec.label, max: maxLength });
    }
    // Would reach a Caddy config or an HTTP header intact.
    if (hasForbiddenControlCharacter(trimmed)) {
      return reject(key, "controlCharacter", { label: spec.label });
    }
    if (trimmed !== "" && spec.pattern && !spec.pattern.test(trimmed)) {
      return reject(key, "pattern", {
        label: spec.label,
        hint: spec.patternHint ?? "is not valid",
      });
    }
    return trimmed;
  };
  // Resolved, so a field gets the limit `parse` holds it to, default included.
  return { ...spec, key, maxLength, parse, fromEnv: parse };
}

/** Leave `generatable` off for a secret that must match something external, like a licence key. */
export function secretSetting(
  spec: Common<string> & { maxLength?: number; generatable?: boolean },
) {
  return {
    ...stringSetting({ ...spec, maxLength: spec.maxLength ?? 16 * 1024 }),
    secret: true,
    generatable: spec.generatable === true,
  };
}

export function numberSetting(
  spec: Common<number> & { min: number; max: number },
): SettingDefinition<number> {
  const key = `${KEY_PREFIX}${spec.name}`;
  const parse = (value: unknown): number => {
    const numeric = typeof value === "string" ? Number(value.trim()) : value;
    if (typeof numeric !== "number" || !Number.isFinite(numeric) || !Number.isInteger(numeric)) {
      return reject(key, "wholeNumber", { label: spec.label });
    }
    if (numeric < spec.min || numeric > spec.max) {
      return reject(key, "range", { label: spec.label, min: spec.min, max: spec.max });
    }
    return numeric;
  };
  return { ...spec, key, parse, fromEnv: parse };
}

/** Tri-state: null means "no opinion", deferring to a Settings toggle as unset `AUTH_*` vars do. */
export function optionalBooleanSetting(
  spec: Omit<Common<boolean | null>, "default"> & { gate?: boolean },
): SettingDefinition<boolean | null> {
  const key = `${KEY_PREFIX}${spec.name}`;
  const parse = (value: unknown): boolean | null => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "") return null;
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "off"].includes(normalized)) return false;
    }
    return reject(key, "tristate", { label: spec.label });
  };
  return { ...spec, key, default: null, parse, fromEnv: parse };
}

const URL_PATTERN = /^https?:\/\/[^\s]+$/;

// ── Application ──────────────────────────────────────────────────────────────

export const appName = stringSetting({
  name: "app_name",
  env: "APP_NAME",
  group: "application",
  label: "Application name",
  description: "Shown in the sidebar, on the login card, and as the suffix on every page title.",
  default: "Caddy Proxy Manager",
  maxLength: 128,
});

export const baseUrl = stringSetting({
  name: "base_url",
  env: "BASE_URL",
  group: "application",
  label: "Public URL",
  description:
    "The address users reach this instance at. OAuth redirect URIs are built from it, so it must " +
    "match what the provider has registered.",
  default: "http://localhost:3000",
  pattern: URL_PATTERN,
  patternHint: "must start with http:// or https://",
  maxLength: 512,
});

export const caddyApiUrl = stringSetting({
  name: "caddy_api_url",
  env: "CADDY_API_URL",
  group: "application",
  label: "Caddy admin API",
  description:
    "Where Caddy's admin API is reachable, for a deployment running Caddy with no agent. " +
    "With an agent, every admin call is proxied through it and this is not used.",
  default: "http://caddy:2019",
  pattern: URL_PATTERN,
  patternHint: "must start with http:// or https://",
  maxLength: 512,
});

export const caddyMonitorEnabled = booleanSetting({
  name: "caddy_monitor_enabled",
  env: "CADDY_MONITOR_ENABLED",
  group: "application",
  label: "Re-apply after a Caddy restart",
  description:
    "Watch every Caddy for a restart onto a config this controller did not send, and push its " +
    "configuration back. Turn it off only on a controller sharing a Caddy it does not own, or " +
    "the two push their own idea of the config at each other every pass.",
  default: true,
});

export const gravatarEnabled = booleanSetting({
  name: "avatar_gravatar",
  env: "AVATAR_GRAVATAR",
  group: "application",
  label: "Gravatar fallback",
  description:
    "Let user icons fall back to gravatar.com, which the browser fetches directly. Turn off to " +
    "keep every avatar lookup off the network.",
  default: true,
});

export const forwardAuthInternalUrl = stringSetting({
  name: "forward_auth_internal_url",
  env: "FORWARD_AUTH_INTERNAL_URL",
  group: "application",
  label: "Internal forward-auth address",
  description:
    "The address Caddy uses to reach this app for forward_auth. Derived from the container " +
    "network when empty; set it only if that derivation is wrong.",
  default: "",
  pattern: URL_PATTERN,
  patternHint: "must start with http:// or https://",
  maxLength: 512,
});

export const caddyBuildTimeout = numberSetting({
  name: "caddy_build_timeout",
  env: "CADDY_BUILD_TIMEOUT",
  group: "application",
  label: "Caddy build timeout (seconds)",
  description:
    "How long to wait for an xcaddy rebuild before giving up. Caddy compiles from source, so slow " +
    "or ARM hosts can take considerably longer than the default.",
  default: 1800,
  min: 60,
  max: 24 * 60 * 60,
});

export const updateCheckEnabled = booleanSetting({
  name: "update_check_enabled",
  env: "UPDATE_CHECK_ENABLED",
  group: "application",
  label: "Check for updates",
  description:
    "Ask the registry below, a few times a day, whether a newer release has been published. Turn " +
    "it off to make no such request; the CRS plugin registry check and GeoIP downloads have " +
    "switches of their own.",
  default: true,
});

export const updateImageRepository = stringSetting({
  name: "update_image_repository",
  env: "UPDATE_IMAGE_REPOSITORY",
  group: "application",
  label: "Image repository",
  description:
    "Where this deployment's images come from, without the image name - the update check reads " +
    "its tags. Point it at your own namespace if you run a fork, or it will report releases you " +
    "cannot pull.",
  default: "ghcr.io/silentspud/caddy-proxy-manager",
  // Lowercase because the registry API requires it; no scheme because the check forces https.
  pattern: /^[a-z0-9][a-z0-9.-]*(:\d{1,5})?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)+$/,
  patternHint: "must look like ghcr.io/owner/name, with no scheme and no image name",
  maxLength: 256,
});

// ── Authentication ───────────────────────────────────────────────────────────

export const allowSelfRegistration = booleanSetting({
  name: "auth_allow_self_registration",
  env: "AUTH_ALLOW_SELF_REGISTRATION",
  group: "authentication",
  label: "Allow self-registration",
  description: "Let anyone create an account with an email address and password.",
  default: false,
});

export const allowOauthRegistration = booleanSetting({
  name: "auth_allow_oauth_registration",
  env: "AUTH_ALLOW_OAUTH_REGISTRATION",
  group: "authentication",
  label: "Allow OAuth registration",
  description:
    "Let a first-time OAuth identity create an account. Separate from self-registration: with " +
    "this off, existing users can still sign in and link.",
  default: false,
});

export const allowOauthRoleFromClaims = booleanSetting({
  name: "auth_allow_oauth_role_from_claims",
  env: "AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS",
  group: "authentication",
  label: "Trust IdP role claims",
  description:
    "Let the provider's claims set a new user's role and status. With this off they are forced to " +
    "user/active regardless of what the IdP sends. Only enable it for an IdP you control.",
  default: false,
});

export const disableLocalUsers = booleanSetting({
  name: "auth_disable_local_users",
  env: "AUTH_DISABLE_LOCAL_USERS",
  group: "authentication",
  label: "OIDC-only mode",
  description:
    "Remove local accounts entirely: no credential sign-in, no password management, no bootstrap " +
    "admin. Enable only once OAuth sign-in is confirmed working.",
  default: false,
});

export const trustHost = booleanSetting({
  name: "auth_trust_host",
  env: "AUTH_TRUST_HOST",
  group: "authentication",
  label: "Trust the Host header",
  description:
    "Build URLs from the request's Host header. Only behind a proxy that rewrites it, and only " +
    "when the public URL above cannot cover the setup.",
  default: false,
});

export const requirePasswordChangeOnLegacyHash = optionalBooleanSetting({
  name: "auth_require_password_change_on_legacy_hash",
  env: "AUTH_REQUIRE_PASSWORD_CHANGE_ON_LEGACY_HASH",
  group: "authentication",
  label: "Force a reset for legacy password hashes",
  description:
    "Require anyone still on a pre-argon2id bcrypt hash to change their password. Leave unset to " +
    "let the Security toggle decide.",
});

export const authRateLimitEnabled = booleanSetting({
  name: "auth_rate_limit_enabled",
  env: "AUTH_RATE_LIMIT_ENABLED",
  group: "authentication",
  label: "Rate-limit auth requests",
  description: "Throttle requests to the auth endpoints. Separate from the login throttle below.",
  default: true,
});

export const authRateLimitWindow = numberSetting({
  name: "auth_rate_limit_window",
  env: "AUTH_RATE_LIMIT_WINDOW",
  group: "authentication",
  label: "Auth rate-limit window (seconds)",
  description: "The period over which auth requests are counted.",
  default: 60,
  min: 1,
  max: 86_400,
});

export const authRateLimitMax = numberSetting({
  name: "auth_rate_limit_max",
  env: "AUTH_RATE_LIMIT_MAX",
  group: "authentication",
  label: "Auth requests per window",
  description: "How many auth requests one client may make before being throttled.",
  default: 5,
  min: 1,
  max: 10_000,
});

export const loginMaxAttempts = numberSetting({
  name: "login_max_attempts",
  env: "LOGIN_MAX_ATTEMPTS",
  group: "authentication",
  label: "Failed logins before lockout",
  description: "How many failed sign-ins one client may make before it is blocked.",
  default: 5,
  min: 1,
  max: 1000,
});

export const loginWindowMs = numberSetting({
  name: "login_window_ms",
  env: "LOGIN_WINDOW_MS",
  group: "authentication",
  label: "Login window (milliseconds)",
  description: "The period over which failed sign-ins are counted.",
  default: 300_000,
  min: 1000,
  max: 24 * 60 * 60 * 1000,
});

export const loginBlockMs = numberSetting({
  name: "login_block_ms",
  env: "LOGIN_BLOCK_MS",
  group: "authentication",
  label: "Lockout duration (milliseconds)",
  description: "How long a blocked client stays blocked.",
  default: 900_000,
  min: 1000,
  max: 24 * 60 * 60 * 1000,
});

// ── Email ────────────────────────────────────────────────────────────────────

/** Unset keeps meaning "on once a server is named", so SMTP_HOST alone is enough. */
export const smtpEnabled = optionalBooleanSetting({
  name: "smtp_enabled",
  env: "SMTP_ENABLED",
  group: "email",
  gate: true,
  label: "Send email",
  description:
    "Password reset links, invitations and certificate alerts go out through the SMTP server " +
    "below. If left unset, email is on whenever a server is named.",
});

export const smtpHost = stringSetting({
  name: "smtp_host",
  env: "SMTP_HOST",
  group: "email",
  label: "SMTP server",
  description: "The host name or address of the mail server to relay through.",
  default: "",
  pattern: /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$|^\[[0-9a-fA-F:.]+\]$/,
  patternHint: "must be a host name or an IP address",
  maxLength: 253,
});

export const smtpPort = numberSetting({
  name: "smtp_port",
  env: "SMTP_PORT",
  group: "email",
  label: "SMTP port",
  description: "Usually 587 for STARTTLS, 465 for implicit TLS and 25 for an unencrypted relay.",
  default: 587,
  min: 1,
  max: 65_535,
});

export const smtpSecurity = stringSetting({
  name: "smtp_security",
  env: "SMTP_SECURITY",
  group: "email",
  label: "SMTP encryption",
  description:
    "starttls upgrades the connection and refuses a server that cannot; tls encrypts from the " +
    "first byte; none sends in the clear, for a relay on a trusted network only.",
  default: "starttls",
  pattern: new RegExp(`^(${SMTP_SECURITY_MODES.join("|")})$`),
  patternHint: "must be starttls, tls or none",
  maxLength: 16,
});

export const smtpUsername = stringSetting({
  name: "smtp_username",
  env: "SMTP_USERNAME",
  group: "email",
  label: "SMTP username",
  description: "Leave empty for a relay that accepts mail without signing in.",
  default: "",
  maxLength: 256,
});

export const smtpPassword = secretSetting({
  name: "smtp_password",
  env: "SMTP_PASSWORD",
  group: "email",
  label: "SMTP password",
  description: "Sent only after the connection is encrypted, unless encryption is set to none.",
  default: "",
  maxLength: 1024,
});

export const smtpFrom = stringSetting({
  name: "smtp_from",
  env: "SMTP_FROM",
  group: "email",
  label: "Sender address",
  description:
    "The From address on every message, shown under the application name. Many servers refuse " +
    "one the account is not allowed to send as.",
  default: "",
  pattern: EMAIL_ADDRESS,
  patternHint: "must be an email address",
  maxLength: 320,
});

export const emailAlertRecipients = stringSetting({
  name: "email_alert_recipients",
  env: "EMAIL_ALERT_RECIPIENTS",
  group: "email",
  label: "Alert recipients",
  description:
    "Comma-separated addresses that certificate alerts go to. If left empty they go to every " +
    "active administrator.",
  default: "",
  // Linear: each address is one run of non-separators, split on a comma the address cannot hold.
  pattern: /^[^\s,@]+@[^\s,@]+(\s*,\s*[^\s,@]+@[^\s,@]+)*$/,
  patternHint: "must be email addresses separated by commas",
  maxLength: 2048,
});

export const certificateExpiryAlertDays = numberSetting({
  name: "certificate_expiry_alert_days",
  env: "CERTIFICATE_EXPIRY_ALERT_DAYS",
  group: "email",
  label: "Certificate alert threshold (days)",
  description:
    "Email the alert recipients once a certificate has fewer days than this left. Caddy renews " +
    "on its own well before then, so an alert means renewal is failing. 0 turns alerts off.",
  default: 14,
  min: 0,
  max: 90,
});

// ── Analytics ────────────────────────────────────────────────────────────────

/**
 * Unset must keep meaning "on if a ClickHouse password is set", or an upgrade silently turns
 * analytics off. The inference is `analyticsEnabled()` in ../clickhouse/client.ts.
 */
export const analyticsEnabled = optionalBooleanSetting({
  name: "analytics_enabled",
  env: "ANALYTICS_ENABLED",
  group: "analytics",
  gate: true,
  label: "Enable analytics",
  description:
    "Collect traffic and WAF events. With an agent running the stack, turning this on also starts " +
    "the ClickHouse container - no Compose profile needed. If left unset, analytics is on only " +
    "when a password is configured below.",
});

export const clickhouseUrl = stringSetting({
  name: "clickhouse_url",
  env: "CLICKHOUSE_URL",
  group: "analytics",
  label: "ClickHouse URL",
  description: "Where the analytics database is reachable.",
  default: "http://clickhouse:8123",
  pattern: URL_PATTERN,
  patternHint: "must start with http:// or https://",
  maxLength: 512,
});

export const clickhouseUser = stringSetting({
  name: "clickhouse_user",
  env: "CLICKHOUSE_USER",
  composeReads: true,
  group: "analytics",
  label: "ClickHouse user",
  description: "The account traffic and WAF events are written as.",
  default: "cpm",
  maxLength: 128,
});

export const clickhousePassword = secretSetting({
  name: "clickhouse_password",
  env: "CLICKHOUSE_PASSWORD",
  // The container is handed the same value the app connects with, so any strong string will do.
  generatable: true,
  composeReads: true,
  group: "analytics",
  label: "ClickHouse password",
  description:
    "Required for analytics: the ClickHouse container refuses to start without one, and with it " +
    "empty there is nothing to authenticate as.",
  default: "",
});

export const clickhouseDb = stringSetting({
  name: "clickhouse_db",
  env: "CLICKHOUSE_DB",
  composeReads: true,
  group: "analytics",
  label: "ClickHouse database",
  description: "The database traffic and WAF events are written to.",
  default: "analytics",
  // Interpolated into DDL, which has no placeholder for an identifier.
  pattern: /^[a-zA-Z_][a-zA-Z0-9_]*$/,
  patternHint: "must start with a letter or underscore and contain only letters, digits and _",
  maxLength: 128,
});

export const clickhouseRetentionDays = numberSetting({
  name: "clickhouse_retention_days",
  env: "CLICKHOUSE_RETENTION_DAYS",
  group: "analytics",
  label: "Analytics retention (days)",
  description:
    "How long traffic and WAF events are kept. Lowering it uses less disk, and migrates the " +
    "existing tables' TTL on the next start.",
  default: 30,
  min: 1,
  max: 3650,
});

// ── GeoIP ────────────────────────────────────────────────────────────────────

/** Unset keeps meaning "on if the databases are on disk"; see `geoipEnabled()` (agent/geoip.ts). */
export const geoipEnabled = optionalBooleanSetting({
  name: "geoip_enabled",
  env: "GEOIP_ENABLED",
  group: "geoip",
  gate: true,
  label: "Enable GeoIP",
  description:
    "Country lookups for analytics and geo blocking. If a MaxMind account ID and licence key are " +
    "set, turning this on also makes the controller download the databases. If left unset, GeoIP " +
    "is on only when the databases are already present.",
});

// "geoipupdate" names kept: they are storage keys, and what an upgrading `.env` still sets.
export const geoipAccountId = stringSetting({
  name: "geoipupdate_account_id",
  env: "GEOIPUPDATE_ACCOUNT_ID",
  group: "geoip",
  label: "MaxMind account ID",
  description: "Needed to download GeoLite2 databases, which geo blocking depends on.",
  default: "",
  maxLength: 128,
});

export const geoipLicenseKey = secretSetting({
  name: "geoipupdate_license_key",
  env: "GEOIPUPDATE_LICENSE_KEY",
  group: "geoip",
  label: "MaxMind licence key",
  description: "Issued alongside the account ID at maxmind.com.",
  default: "",
});

export const geoipUpdateIntervalHours = numberSetting({
  name: "geoip_update_interval_hours",
  env: "GEOIP_UPDATE_INTERVAL_HOURS",
  group: "geoip",
  label: "Update check interval (hours)",
  description:
    "How often the controller asks MaxMind for newer databases. MaxMind rebuilds GeoLite ASN " +
    "daily, and Country and City on Tuesdays and Fridays. A check downloads only what changed.",
  default: 24,
  min: 1,
  max: 168,
});

/** Every definition, in the order the setup and settings pages render them. */
export const SETTING_DEFINITIONS = [
  appName,
  baseUrl,
  caddyApiUrl,
  caddyMonitorEnabled,
  gravatarEnabled,
  forwardAuthInternalUrl,
  caddyBuildTimeout,
  updateCheckEnabled,
  updateImageRepository,
  allowSelfRegistration,
  allowOauthRegistration,
  allowOauthRoleFromClaims,
  disableLocalUsers,
  trustHost,
  requirePasswordChangeOnLegacyHash,
  authRateLimitEnabled,
  authRateLimitWindow,
  authRateLimitMax,
  loginMaxAttempts,
  loginWindowMs,
  loginBlockMs,
  smtpEnabled,
  smtpHost,
  smtpPort,
  smtpSecurity,
  smtpUsername,
  smtpPassword,
  smtpFrom,
  emailAlertRecipients,
  certificateExpiryAlertDays,
  analyticsEnabled,
  clickhouseUrl,
  clickhouseUser,
  clickhousePassword,
  clickhouseDb,
  clickhouseRetentionDays,
  geoipEnabled,
  geoipAccountId,
  geoipLicenseKey,
  geoipUpdateIntervalHours,
] as const satisfies readonly SettingDefinition[];

export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingDefinition> = new Map(
  SETTING_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export const SETTINGS_BY_ENV: ReadonlyMap<string, SettingDefinition> = new Map(
  SETTING_DEFINITIONS.map((definition) => [definition.env, definition]),
);

export const SETTING_GROUPS: readonly SettingGroup[] = [
  "application",
  "authentication",
  "email",
  "analytics",
  "geoip",
];
