import type { DashboardHostSettings } from "./dashboard-host";
import db, { nowIso } from "./db";
import { settings } from "./db/schema";
import { eq } from "drizzle-orm";
import { sanitizeErrorPageRules, type ErrorPageRule } from "./models/proxy-hosts";
import type { CaddyCustomModule } from "./caddy-modules";
import {
  normalizeDefaultResponseSettings,
  type DefaultResponseSettings,
} from "./caddy-default-response";
import {
  DEFAULT_TAILSCALE_SETTINGS,
  normalizeTailscaleSettings,
  type TailscaleSettings,
} from "./caddy-tailscale";
import { encryptSecret } from "./secret";
import { currentStagingScope } from "./settings/staging-context";

export type { DefaultResponseSettings } from "./caddy-default-response";
export type { TailscaleSettings } from "./caddy-tailscale";

export type SettingValue<T> = T | null;

export type CloudflareSettings = {
  apiToken: string;
  zoneId?: string;
  accountId?: string;
};

export type GeneralSettings = {
  /** Offered as the starting value when a proxy host is created. */
  defaultDomain: string;
  acmeEmail?: string;
};

export type AvatarSettings = {
  /** Fall back to Gravatar for users who have no icon of their own. */
  gravatarEnabled: boolean;
};

export type PasswordPolicySettings = {
  /** Force a password reset for anyone still on bcrypt; changing it rehashes with argon2id. */
  requireChangeOnLegacyHash: boolean;
};

export type AcmeSettings = {
  /** Custom ACME directory URL (e.g. an internal CA). Empty = Let's Encrypt default. */
  caUrl?: string;
  /** PEM-encoded trusted root for the ACME CA's HTTPS endpoint, if not in the system trust store. */
  caRootPem?: string;
};

export type AuthentikSettings = {
  outpostDomain: string;
  outpostUpstream: string;
  authEndpoint?: string;
};

/**
 * Defaults a new proxy host's forward-auth block is prefilled from, so an operator running one
 * auth server for the whole fleet types its address once rather than per host. Nothing is applied
 * from here: a host carries its own block, and this only seeds the form.
 */
export type ForwardAuthSettings = {
  provider: "authelia" | "custom";
  /** Base URL of the auth server, e.g. http://authelia:9091 */
  authUpstream: string;
  /** Left out for a preset that supplies its own. */
  authEndpoint?: string;
};

export type MetricsSettings = {
  enabled: boolean;
  port?: number; // Port to expose metrics on (default: 9090, separate from admin API)
};

export type LoggingSettings = {
  enabled: boolean;
  format?: "json" | "console"; // Log format (default: json)
};

export type TrustedProxiesSettings = {
  // Proxy ranges to trust for X-Forwarded-For / client IP resolution at the server level
  // (Caddy `trusted_proxies`). Accepts CIDRs, bare IPs, and the "private_ranges" shorthand.
  // Empty = disabled (current behaviour).
  ranges: string[];
  // Headers Caddy reads the real client IP from (Caddy `client_ip_headers`). Empty = Caddy's
  // X-Forwarded-For default; useful for e.g. Cf-Connecting-Ip.
  client_ip_headers?: string[];
  // Only trust client_ip_headers from the configured proxies, rejecting spoofed values from
  // untrusted peers (Caddy `trusted_proxies_strict`).
  strict?: boolean;
  // When true, use `ranges` as the default trusted-proxy list for global geoblocking so the
  // two settings can't silently disagree.
  default_geoblock?: boolean;
};

export type DnsSettings = {
  enabled: boolean;
  resolvers: string[]; // Primary DNS resolvers (e.g., "1.1.1.1", "9.9.9.9")
  fallbacks?: string[]; // Fallback DNS resolvers if primary fails
  timeout?: string; // DNS query timeout (e.g., "5s")
};

export type DnsProviderSettings = {
  /** Configured providers: keyed by provider name, value is credential map */
  providers: Record<string, Record<string, string>>;
  /** Name of the default provider (null = no DNS-01 challenges) */
  default: string | null;
};

export type UpstreamDnsAddressFamily = "ipv6" | "ipv4" | "both";

export type UpstreamDnsResolutionSettings = {
  enabled: boolean;
  family: UpstreamDnsAddressFamily;
};

export type GeoBlockSettings = {
  enabled: boolean;

  // Block rules
  block_countries: string[]; // ISO 3166-1 alpha-2, e.g. ["CN", "RU"]
  block_continents: string[]; // AF, AN, AS, EU, NA, OC, SA
  block_asns: number[];
  block_cidrs: string[];
  block_ips: string[];

  // Allow rules (win over block rules)
  allow_countries: string[];
  allow_continents: string[];
  allow_asns: number[];
  allow_cidrs: string[];
  allow_ips: string[];

  // Trusted proxies for X-Forwarded-For parsing
  trusted_proxies: string[];
  // When true, block requests whose real client IP cannot be determined (e.g. from a trusted
  // proxy with no usable XFF entry). Default: false (fail-open).
  fail_closed: boolean;

  // Block response customization
  response_status: number; // default 403
  response_body: string; // default "Forbidden"
  response_headers: Record<string, string>;
  redirect_url: string; // if set, 302 redirect instead of status/body
};

export async function getSetting<T>(key: string): Promise<SettingValue<T>> {
  // A staged value stands in for the stored row, so the config builder and every form read the
  // same pending state without knowing staging exists. See ./settings/staging-context.ts.
  const staged = currentStagingScope()?.overlay.get(key);
  const raw = staged ?? (await storedSettingValue(key));

  if (raw === null || raw === undefined) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.warn(`Failed to parse setting ${key}`, error);
    return null;
  }
}

async function storedSettingValue(key: string): Promise<string | null> {
  const setting = await db.query.settings.findFirst({
    where: (table, { eq }) => eq(table.key, key),
  });
  return setting?.value ?? null;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  const payload = JSON.stringify(value);
  const now = nowIso();

  // Inside a capturing scope the write is a staged edit, not a commit. The scope belongs to one
  // action invocation, so an action that writes several keys stages them together.
  const capture = currentStagingScope()?.capture;
  if (capture) {
    capture.set(key, payload);
    return;
  }

  await db
    .insert(settings)
    .values({
      key,
      value: payload,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: payload,
        updatedAt: now,
      },
    });
}

export async function clearSetting(key: string): Promise<void> {
  await db.delete(settings).where(eq(settings.key, key));
}

/**
 * The legacy Cloudflare settings. The token comes back as stored, like Tailscale's auth key: its
 * readers only test for presence, and the dns_provider migration hands it to a reader that decrypts
 * on use. A row written before tokens were encrypted still reads as plaintext until its next save.
 */
export async function getCloudflareSettings(): Promise<CloudflareSettings | null> {
  return await getSetting<CloudflareSettings>("cloudflare");
}

export async function saveCloudflareSettings(settings: CloudflareSettings): Promise<void> {
  // encryptSecret passes an already-encrypted token through, which is what a form re-saving the
  // stored value sends.
  await setSetting("cloudflare", { ...settings, apiToken: encryptSecret(settings.apiToken ?? "") });
}

export async function getGeneralSettings(): Promise<GeneralSettings | null> {
  const stored = await getSetting<GeneralSettings & { primaryDomain?: string }>("general");
  if (!stored) return null;

  // `primaryDomain` is what every release before this one wrote, and what a pre-3.0 database
  // still holds after the migration copies its `settings` rows across verbatim. Read either name
  // and answer with the current one, so an upgrade does not present an empty field and quietly
  // overwrite the operator's domain the first time the form is saved.
  const { primaryDomain, ...rest } = stored;
  return { ...rest, defaultDomain: stored.defaultDomain ?? primaryDomain ?? "" };
}

export async function saveGeneralSettings(settings: GeneralSettings): Promise<void> {
  await setSetting("general", settings);
}

/**
 * How the dashboard is served through Caddy. Null until setup has decided, which the managed-host
 * builder reads as "off".
 */
export async function getDashboardSettings(): Promise<DashboardHostSettings | null> {
  return await getSetting<DashboardHostSettings>("dashboard");
}

export async function saveDashboardSettings(settings: DashboardHostSettings): Promise<void> {
  await setSetting("dashboard", settings);
}

export async function getAvatarSettings(): Promise<AvatarSettings | null> {
  // Effective, so an agent inherits its controller's choice unless it stored a local override.
  return await getSetting<AvatarSettings>("avatars");
}

export async function saveAvatarSettings(settings: AvatarSettings): Promise<void> {
  await setSetting("avatars", settings);
}

/**
 * Whether icons may fall back to Gravatar.
 *
 * Resolution is the registry first - a stored value, then AVATAR_GRAVATAR - and only then the
 * older JSON blob the Settings page used to write. The blob stays in the chain for deployments
 * that have not been through the migration, which is what lifts it into the registry key; without
 * that fallback, upgrading would silently reset the toggle.
 */
export async function isGravatarEnabled(): Promise<boolean> {
  const [{ gravatarEnabled }, { resolveSetting }] = await Promise.all([
    import("./settings/registry"),
    import("./settings/resolve"),
  ]);
  const resolved = await resolveSetting(gravatarEnabled);
  if (resolved.source !== "default") return resolved.value;

  const stored = await getAvatarSettings();
  return stored?.gravatarEnabled ?? gravatarEnabled.default;
}

export async function getPasswordPolicySettings(): Promise<PasswordPolicySettings | null> {
  return await getSetting<PasswordPolicySettings>("password_policy");
}

export async function savePasswordPolicySettings(settings: PasswordPolicySettings): Promise<void> {
  await setSetting("password_policy", settings);
}

/**
 * Whether a bcrypt-hashed user must change their password.
 *
 * Same order as isGravatarEnabled: the registry (stored, then the environment variable), then the
 * older JSON blob for deployments that have not migrated yet. This one is tri-state - null means
 * "no opinion", which is why an unset registry value has to fall through rather than read as false.
 */
export async function isLegacyPasswordChangeRequired(): Promise<boolean> {
  const [{ requirePasswordChangeOnLegacyHash }, { resolveSetting }] = await Promise.all([
    import("./settings/registry"),
    import("./settings/resolve"),
  ]);
  const resolved = await resolveSetting(requirePasswordChangeOnLegacyHash);
  if (resolved.value !== null) return resolved.value;

  const stored = await getPasswordPolicySettings();
  return stored?.requireChangeOnLegacyHash ?? false;
}

export async function getAcmeSettings(): Promise<AcmeSettings | null> {
  return await getSetting<AcmeSettings>("acme");
}

export async function saveAcmeSettings(settings: AcmeSettings): Promise<void> {
  await setSetting("acme", settings);
}

export async function getAuthentikSettings(): Promise<AuthentikSettings | null> {
  return await getSetting<AuthentikSettings>("authentik");
}

export async function saveAuthentikSettings(settings: AuthentikSettings): Promise<void> {
  await setSetting("authentik", settings);
}

export async function getForwardAuthSettings(): Promise<ForwardAuthSettings | null> {
  return await getSetting<ForwardAuthSettings>("forward_auth");
}

export async function saveForwardAuthSettings(settings: ForwardAuthSettings): Promise<void> {
  await setSetting("forward_auth", settings);
}

export async function getMetricsSettings(): Promise<MetricsSettings | null> {
  return await getSetting<MetricsSettings>("metrics");
}

export async function saveMetricsSettings(settings: MetricsSettings): Promise<void> {
  await setSetting("metrics", settings);
}

export async function getLoggingSettings(): Promise<LoggingSettings | null> {
  return await getSetting<LoggingSettings>("logging");
}

export async function saveLoggingSettings(settings: LoggingSettings): Promise<void> {
  await setSetting("logging", settings);
}

export async function getTrustedProxiesSettings(): Promise<TrustedProxiesSettings | null> {
  return await getSetting<TrustedProxiesSettings>("trusted_proxies");
}

export async function saveTrustedProxiesSettings(settings: TrustedProxiesSettings): Promise<void> {
  await setSetting("trusted_proxies", settings);
}

/** HTTP/1.1 is always on. Caddy sets protocols per listener, so this is global, not per host. */
export type HttpProtocolsSettings = { http2: boolean; http3: boolean };

export const DEFAULT_HTTP_PROTOCOLS: HttpProtocolsSettings = { http2: true, http3: true };

export function normalizeHttpProtocols(value: unknown): HttpProtocolsSettings {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return { http2: raw.http2 !== false, http3: raw.http3 !== false };
}

export async function getHttpProtocolsSettings(): Promise<HttpProtocolsSettings> {
  return normalizeHttpProtocols(await getSetting<HttpProtocolsSettings>("http_protocols"));
}

export async function saveHttpProtocolsSettings(settings: unknown): Promise<void> {
  await setSetting("http_protocols", normalizeHttpProtocols(settings));
}

/** Merged into every agent's config by `caddy-global-config.ts`. */
export type GlobalCaddyConfigSettings = { caddyfile: string };

export async function getGlobalCaddyConfigSettings(): Promise<GlobalCaddyConfigSettings> {
  const stored = await getSetting<GlobalCaddyConfigSettings>("global_caddy_config");
  return { caddyfile: typeof stored?.caddyfile === "string" ? stored.caddyfile : "" };
}

/** Checked against a real Caddy first, from here so the form and the REST API can't differ. */
export async function saveGlobalCaddyConfigSettings(settings: unknown): Promise<void> {
  const raw = settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
  const caddyfile = typeof raw.caddyfile === "string" ? raw.caddyfile.replace(/\r\n?/g, "\n") : "";
  const { assertGlobalCaddyConfigLoads } = await import("./caddy-global-config");
  await assertGlobalCaddyConfigLoads(caddyfile);
  await setSetting("global_caddy_config", { caddyfile });
}

export type TwoFactorPolicySettings = { requireForAdmins: boolean };

export async function getTwoFactorPolicySettings(): Promise<TwoFactorPolicySettings> {
  const stored = await getSetting<TwoFactorPolicySettings>("two_factor_policy");
  return { requireForAdmins: stored?.requireForAdmins === true };
}

export async function saveTwoFactorPolicySettings(settings: unknown): Promise<void> {
  const raw = settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
  await setSetting("two_factor_policy", { requireForAdmins: raw.requireForAdmins === true });
}

export async function getDnsSettings(): Promise<DnsSettings | null> {
  return await getSetting<DnsSettings>("dns");
}

export async function saveDnsSettings(settings: DnsSettings): Promise<void> {
  await setSetting("dns", settings);
}

export async function getDnsProviderSettings(): Promise<DnsProviderSettings | null> {
  const raw = await getSetting<Record<string, unknown>>("dns_provider");
  if (!raw) return null;

  // Normalize the old single-provider { provider, credentials } shape into the multi-provider
  // { providers, default } shape.
  if ("provider" in raw && "credentials" in raw && !("providers" in raw)) {
    const name = raw.provider as string;
    const creds = raw.credentials as Record<string, string>;
    return { providers: { [name]: creds }, default: name };
  }

  return raw as unknown as DnsProviderSettings;
}

export async function saveDnsProviderSettings(settings: DnsProviderSettings): Promise<void> {
  await setSetting("dns_provider", settings);
}

export async function getUpstreamDnsResolutionSettings(): Promise<UpstreamDnsResolutionSettings | null> {
  return await getSetting<UpstreamDnsResolutionSettings>("upstream_dns_resolution");
}

export async function saveUpstreamDnsResolutionSettings(
  settings: UpstreamDnsResolutionSettings,
): Promise<void> {
  await setSetting("upstream_dns_resolution", settings);
}

export async function getGeoBlockSettings(): Promise<GeoBlockSettings | null> {
  return await getSetting<GeoBlockSettings>("geoblock");
}

export async function saveGeoBlockSettings(settings: GeoBlockSettings): Promise<void> {
  await setSetting("geoblock", settings);
}

export type WafSettings = {
  enabled: boolean;
  // Coraza's SecRuleEngine values. DetectionOnly is settable through the REST API (the UI only
  // offers Off/On); buildWafHandler rejects anything else.
  mode: "Off" | "On" | "DetectionOnly";
  load_owasp_crs: boolean;
  custom_directives: string;
  excluded_rule_ids?: number[];
  // waf_presets ids, emitted in this order ahead of the CRS rules.
  preset_ids?: number[];
  // crs_plugins ids; emitted only alongside the CRS.
  plugin_ids?: number[];
  // Request body limits, in bytes. Unset means Coraza's own default applies
  // (12.5 MiB from @coraza.conf-recommended when load_owasp_crs is on, else
  // 128 MiB). Coraza caps both at 1 GiB - see CORAZA_MAX_BODY_LIMIT.
  request_body_limit?: number;
  request_body_in_memory_limit?: number;
  // ProcessPartial inspects the leading bytes and forwards the rest instead of
  // rejecting oversized uploads outright.
  request_body_limit_action?: "Reject" | "ProcessPartial";
};

export async function getWafSettings(): Promise<WafSettings | null> {
  return await getSetting<WafSettings>("waf");
}

export async function saveWafSettings(s: WafSettings): Promise<void> {
  // Lazy: waf-dry-run reaches the models, which import this module.
  const { assertWafLoads, wafCandidatesForGlobal } = await import("./waf-dry-run");
  await assertWafLoads(await wafCandidatesForGlobal(s));
  await setSetting("waf", s);
}

// Global error pages, applied as fallback error routes across every proxy host. Per-host error
// pages take precedence over these.
export type ErrorPagesSettings = {
  rules: ErrorPageRule[];
};

export async function getErrorPagesSettings(): Promise<ErrorPagesSettings | null> {
  return await getSetting<ErrorPagesSettings>("error_pages");
}

export async function saveErrorPagesSettings(s: ErrorPagesSettings): Promise<void> {
  await setSetting("error_pages", { rules: sanitizeErrorPageRules(s?.rules) });
}

// ─── Tailscale ───────────────────────────────────────────────────────────────

/**
 * Tailscale node defaults. The auth key comes back exactly as stored - encrypted - because this is
 * also what the Settings page reads; decrypting here would put the key one careless prop away from
 * the browser. Config generation decrypts it explicitly.
 */
export async function getTailscaleSettings(): Promise<TailscaleSettings | null> {
  const value = await getSetting<unknown>("tailscale");
  if (value === null) return null;

  try {
    // The stored blob is normalized on the way in, so a failure here means it was hand-edited or
    // written by an older shape. Treating that as "not configured" is safer than throwing on every
    // config apply, which would take every other host down with it.
    return normalizeTailscaleSettings(value);
  } catch (error) {
    console.warn("Ignoring invalid Tailscale settings", error);
    return null;
  }
}

export async function saveTailscaleSettings(value: TailscaleSettings): Promise<void> {
  const normalized = normalizeTailscaleSettings(value);
  await setSetting("tailscale", {
    ...normalized,
    authKey: normalized.authKey ? encryptSecret(normalized.authKey) : "",
    apiAccessToken: normalized.apiAccessToken ? encryptSecret(normalized.apiAccessToken) : "",
  });
}

/** The effective settings when nothing has been saved yet, so callers need no null branch. */
export function defaultTailscaleSettings(): TailscaleSettings {
  return { ...DEFAULT_TAILSCALE_SETTINGS, tags: [] };
}

// ─── Caddy build ─────────────────────────────────────────────────────────────

/** Which Caddy plugins this deployment's image is built with. */
export type CaddyBuildSettings = {
  /** Built-in module id -> enabled. Absent ids fall back to enabled. */
  modules: Record<string, boolean>;
  customModules: CaddyCustomModule[];
};

export async function getCaddyBuildSettings(): Promise<CaddyBuildSettings | null> {
  return await getSetting<CaddyBuildSettings>("caddy_build");
}

export async function saveCaddyBuildSettings(s: CaddyBuildSettings): Promise<void> {
  await setSetting("caddy_build", s);
}

// Response for requests that do not match any configured proxy host. A missing
// setting (or mode "caddy") preserves Caddy's native routing/HTTPS behavior.
export async function getDefaultResponseSettings(): Promise<DefaultResponseSettings | null> {
  const value = await getSetting<unknown>("default_response");
  if (value === null) return null;

  try {
    return normalizeDefaultResponseSettings(value);
  } catch (error) {
    console.warn("Ignoring invalid default response settings", error);
    return null;
  }
}

export async function saveDefaultResponseSettings(value: DefaultResponseSettings): Promise<void> {
  await setSetting("default_response", normalizeDefaultResponseSettings(value));
}
