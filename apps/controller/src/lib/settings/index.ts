import type { WafExclusionRule } from "../waf/exclusions";
import type { WafTuning } from "../waf/tuning";
import type { DashboardHostSettings } from "../dashboard-host";
import db, { nowIso } from "../db";
import { oauthProviders, settings, users } from "../db/schema";
import { and, eq, inArray, ne } from "drizzle-orm";
import { domainError } from "../errors/domain-error";
import { LDAP_PROVIDER_TYPE } from "../ldap/defaults";
import { sanitizeErrorPageRules, type ErrorPageRule } from "../models/proxy-hosts";
import type { CaddyCustomModule } from "../caddy/image-build/modules";
import {
  normalizeDefaultResponseSettings,
  type DefaultResponseSettings,
} from "../caddy/default-response";
import {
  DEFAULT_TAILSCALE_SETTINGS,
  normalizeTailscaleSettings,
  type TailscaleSettings,
} from "../caddy/tailscale";
import { encryptDnsProviderSettingCredentials } from "../dns/provider-credentials";
import type { AcmeDnsAccount, DnsChallengeDelegation } from "../dns/challenge-delegation";
import { encryptSecret } from "../secrets";
import {
  type TwoFactorPolicySettings,
  isMfaPolicyMode,
  nextMfaPolicy,
  readMfaPolicy,
} from "../auth/two-factor/mfa-policy";
import { type SsoEnforcement, readSsoEnforcement } from "../auth/sso-enforcement";
import {
  DEFAULT_HTTP_CACHE_SETTINGS,
  encryptHttpCacheSecrets,
  type HttpCacheSettings,
  keepStoredSecrets,
  normalizeHttpCacheSettings,
} from "../proxy-hosts/http-cache";
import { currentStagingScope } from "./staging-context";
import { invalidateProcessMemos } from "./process-memo";
import { forgetRequestMemo, requestMemo } from "../request-memo";
import type { GlobalRateLimitSettings } from "../proxy-hosts/rate-limit";
import {
  normalizeGlobalRateLimitInput,
  sanitizeGlobalRateLimit,
} from "../proxy-hosts/rate-limit-global";
import { type CompressionSettings, normalizeCompressionSettings } from "../proxy-hosts/compression";
import {
  type HostDefaults,
  normalizeHostDefaults,
  sanitizeHostDefaults,
  wafOnByDefault,
} from "../proxy-hosts/host-defaults";
import {
  assertCrowdSecComplete,
  type CrowdSecSettings,
  DEFAULT_CROWDSEC_SETTINGS,
  keepStoredCrowdSecKey,
  normalizeCrowdSecSettings,
  withManagedCrowdSecKey,
} from "../caddy/crowdsec";

export type { DefaultResponseSettings } from "../caddy/default-response";
export type { TailscaleSettings } from "../caddy/tailscale";
export type { CompressionSettings } from "../proxy-hosts/compression";
export type { HostDefaults } from "../proxy-hosts/host-defaults";
export type { CrowdSecSettings } from "../caddy/crowdsec";

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

/** Only prefills a new host's forward-auth form; nothing is applied from here. */
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
  // CIDRs, bare IPs or "private_ranges". Empty disables it.
  ranges: string[];
  // Empty means Caddy's X-Forwarded-For default.
  client_ip_headers?: string[];
  strict?: boolean;
  // Reuse `ranges` for global geoblocking so the two cannot silently disagree.
  default_geoblock?: boolean;
};

export type DnsSettings = {
  enabled: boolean;
  resolvers: string[];
  fallbacks?: string[];
  timeout?: string; // Caddy duration, e.g. "5s"
};

export type DnsProviderSettings = {
  /** Provider name -> credential map. */
  providers: Record<string, Record<string, string>>;
  /** Null means no DNS-01 challenges. */
  default: string | null;
  delegations?: DnsChallengeDelegation[];
  /** Keyed by the domain each was registered for. */
  acmeDnsAccounts?: Record<string, AcmeDnsAccount>;
};

export type UpstreamDnsAddressFamily = "ipv6" | "ipv4" | "both";

export type UpstreamDnsResolutionSettings = {
  enabled: boolean;
  family: UpstreamDnsAddressFamily;
};

export type GeoBlockSettings = {
  enabled: boolean;

  block_countries: string[]; // ISO 3166-1 alpha-2
  block_continents: string[]; // AF, AN, AS, EU, NA, OC, SA
  block_asns: number[];
  block_cidrs: string[];
  block_ips: string[];

  // Allow rules win over block rules.
  allow_countries: string[];
  allow_continents: string[];
  allow_asns: number[];
  allow_cidrs: string[];
  allow_ips: string[];

  trusted_proxies: string[];
  // Block when the real client IP cannot be determined. Off (fail-open) by default.
  fail_closed: boolean;

  // Absent on a host inherits: the global geo-block's in merge mode, else 403 "Forbidden".
  response_status?: number;
  response_body?: string;
  response_headers: Record<string, string>;
  redirect_url: string; // if set, 302 redirect instead of status/body
};

export async function getSetting<T>(key: string): Promise<SettingValue<T>> {
  // A staged value stands in for the stored row, so readers see pending state unawares.
  // See ./settings/staging-context.ts.
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

/** Under the staging overlay, which getSetting checks first, so a staged value still wins. */
function storedSettingValue(key: string): Promise<string | null> {
  return requestMemo(`setting:${key}`, async () => {
    const setting = await db.query.settings.findFirst({
      where: (table, { eq }) => eq(table.key, key),
    });
    return setting?.value ?? null;
  });
}

/** After a direct write to the row. */
export function settingWritten(key: string): void {
  forgetRequestMemo(`setting:${key}`);
  invalidateProcessMemos();
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  const payload = JSON.stringify(value);
  const now = nowIso();

  // Inside a capturing scope this stages instead; one scope per action stages its keys together.
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
  settingWritten(key);
}

export async function clearSetting(key: string): Promise<void> {
  // Staged as "null", which the overlay reads as absent; see ./settings/staging-context.ts.
  const capture = currentStagingScope()?.capture;
  if (capture) {
    capture.set(key, "null");
    return;
  }
  await db.delete(settings).where(eq(settings.key, key));
  settingWritten(key);
}

/**
 * The token comes back as stored (maybe encrypted, maybe legacy plaintext): readers only test
 * presence, and the dns_provider migration decrypts on use.
 */
export async function getCloudflareSettings(): Promise<CloudflareSettings | null> {
  return await getSetting<CloudflareSettings>("cloudflare");
}

export async function saveCloudflareSettings(settings: CloudflareSettings): Promise<void> {
  // encryptSecret passes an already-encrypted token through, as a re-saved form sends.
  await setSetting("cloudflare", { ...settings, apiToken: encryptSecret(settings.apiToken ?? "") });
}

export async function getGeneralSettings(): Promise<GeneralSettings | null> {
  const stored = await getSetting<GeneralSettings & { primaryDomain?: string }>("general");
  if (!stored) return null;

  // Pre-3.0 databases still hold `primaryDomain`; without this the first save would blank it.
  const { primaryDomain, ...rest } = stored;
  return { ...rest, defaultDomain: stored.defaultDomain ?? primaryDomain ?? "" };
}

export async function saveGeneralSettings(settings: GeneralSettings): Promise<void> {
  await setSetting("general", settings);
}

/** Null until setup has decided, which the managed-host builder reads as off. */
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

/** The registry first, then the legacy blob for unmigrated deployments, or upgrading resets it. */
export async function isGravatarEnabled(): Promise<boolean> {
  const [{ gravatarEnabled }, { resolveSetting }, { outboundAllowed }] = await Promise.all([
    import("./registry"),
    import("./resolve"),
    import("../offline"),
  ]);
  if (!(await outboundAllowed("gravatar"))) return false;
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

/** Same order as isGravatarEnabled, but tri-state: a null registry value falls through. */
export async function isLegacyPasswordChangeRequired(): Promise<boolean> {
  const [{ requirePasswordChangeOnLegacyHash }, { resolveSetting }] = await Promise.all([
    import("./registry"),
    import("./resolve"),
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

export async function getCompressionSettings(): Promise<CompressionSettings> {
  return normalizeCompressionSettings(await getSetting<CompressionSettings>("compression"));
}

export async function saveCompressionSettings(settings: unknown): Promise<void> {
  await setSetting("compression", normalizeCompressionSettings(settings));
}

/** Never null: an unset row reads as the values new hosts got before this was a setting. */
export async function getHostDefaults(): Promise<HostDefaults> {
  const [stored, waf] = await Promise.all([getSetting<unknown>("host_defaults"), getWafSettings()]);
  const defaults = sanitizeHostDefaults(stored);
  return { ...defaults, proxyHost: { ...defaults.proxyHost, wafEnabled: wafOnByDefault(waf) } };
}

export async function saveHostDefaults(settings: unknown): Promise<void> {
  await setSetting("host_defaults", normalizeHostDefaults(settings));
}

/** The key stays encrypted, as Tailscale's does; config generation decrypts it. */
export async function getCrowdSecSettings(): Promise<CrowdSecSettings> {
  const stored = await getSetting<unknown>("crowdsec");
  if (stored === null) return { ...DEFAULT_CROWDSEC_SETTINGS };
  try {
    return normalizeCrowdSecSettings(stored);
  } catch (error) {
    // Throwing would fail every config apply, taking every other host down with it.
    console.warn("Ignoring invalid CrowdSec settings", error);
    return { ...DEFAULT_CROWDSEC_SETTINGS };
  }
}

/** The form and REST alike: a blank key keeps the stored one (`keepStoredCrowdSecKey`). */
export async function saveCrowdSecSettings(value: unknown): Promise<void> {
  const submitted = normalizeCrowdSecSettings(value);
  const raw = await getSetting<unknown>("crowdsec");
  let stored: CrowdSecSettings | null = null;
  try {
    stored = raw === null ? null : normalizeCrowdSecSettings(raw);
  } catch {
    // An unreadable row has nothing worth keeping.
  }
  const merged = withManagedCrowdSecKey(keepStoredCrowdSecKey(submitted, stored), stored);
  assertCrowdSecComplete(merged, stored);
  // encryptSecret passes an already-encrypted value through, which is what a kept key is.
  await setSetting("crowdsec", {
    ...merged,
    apiKey: merged.apiKey ? encryptSecret(merged.apiKey) : "",
    managedApiKey: merged.managedApiKey ? encryptSecret(merged.managedApiKey) : "",
  });
}

/** Merged into every agent's config by `caddy/global-config.ts`. */
export type GlobalCaddyConfigSettings = { caddyfile: string };

export async function getGlobalCaddyConfigSettings(): Promise<GlobalCaddyConfigSettings> {
  const stored = await getSetting<GlobalCaddyConfigSettings>("global_caddy_config");
  return { caddyfile: typeof stored?.caddyfile === "string" ? stored.caddyfile : "" };
}

/** Checked against a real Caddy first, from here so the form and the REST API can't differ. */
export async function saveGlobalCaddyConfigSettings(settings: unknown): Promise<void> {
  const raw = settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
  const caddyfile = typeof raw.caddyfile === "string" ? raw.caddyfile.replace(/\r\n?/g, "\n") : "";
  const { assertGlobalCaddyConfigLoads } = await import("../caddy/global-config");
  await assertGlobalCaddyConfigLoads(caddyfile);
  await setSetting("global_caddy_config", { caddyfile });
}

/** Secrets stay encrypted here; config generation decrypts them (see `getTailscaleSettings`). */
export async function getHttpCacheSettings(): Promise<HttpCacheSettings> {
  const stored = await getSetting<unknown>("http_cache");
  if (stored === null) return structuredClone(DEFAULT_HTTP_CACHE_SETTINGS);
  try {
    return normalizeHttpCacheSettings(stored);
  } catch (error) {
    // Throwing would fail every config apply, taking every other host down with it.
    console.warn("Ignoring invalid HTTP cache settings", error);
    return structuredClone(DEFAULT_HTTP_CACHE_SETTINGS);
  }
}

/** A blank secret keeps the stored one, as the form never sends it back. */
export async function saveHttpCacheSettings(settings: unknown): Promise<void> {
  const submitted = normalizeHttpCacheSettings(settings, { secretsPending: true });
  const stored = await getSetting<unknown>("http_cache");
  let previous: HttpCacheSettings | null = null;
  try {
    previous = stored === null ? null : normalizeHttpCacheSettings(stored);
  } catch {
    // An unreadable row has nothing worth keeping.
  }
  // Again with the secrets in place: a CDN switched on must not be saved without its key.
  const merged = normalizeHttpCacheSettings(keepStoredSecrets(submitted, previous));
  await setSetting("http_cache", encryptHttpCacheSecrets(merged));
}

export type { TwoFactorPolicySettings } from "../auth/two-factor/mfa-policy";

export async function getTwoFactorPolicySettings(): Promise<TwoFactorPolicySettings> {
  return readMfaPolicy(await getSetting<unknown>("two_factor_policy"));
}

/** `{ mode, graceDays }`, or the older `{ requireForAdmins }`, which is "admins" or "off". */
export async function saveTwoFactorPolicySettings(settings: unknown): Promise<void> {
  const raw = settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
  const previous = await getTwoFactorPolicySettings();
  const mode = isMfaPolicyMode(raw.mode)
    ? raw.mode
    : "requireForAdmins" in raw
      ? raw.requireForAdmins === true
        ? previous.mode === "all"
          ? "all"
          : "admins"
        : "off"
      : previous.mode;
  const graceDays = "graceDays" in raw ? Number(raw.graceDays) : previous.graceDays;
  await setSetting("two_factor_policy", nextMfaPolicy(previous, { mode, graceDays }));
}

export type { SsoEnforcement } from "../auth/sso-enforcement";

export async function getSsoEnforcementSettings(): Promise<SsoEnforcement> {
  return readSsoEnforcement(await getSetting<unknown>("sso_enforcement"));
}

/**
 * Refused while it would lock everyone out: enforcing needs a provider to send people to, and a
 * break-glass account must be one that exists. Fields left out keep their stored values.
 */
export async function saveSsoEnforcementSettings(settings: unknown): Promise<SsoEnforcement> {
  const raw = settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
  const next = readSsoEnforcement({ ...(await getSsoEnforcementSettings()), ...raw });
  if (next.breakGlassUserIds.length > 0) {
    const found = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, next.breakGlassUserIds));
    const existing = new Set(found.map((row) => row.id));
    // A stored account deleted since is dropped quietly; one just picked must exist.
    if ("breakGlassUserIds" in raw && found.length !== next.breakGlassUserIds.length) {
      throw domainError("breakGlassAccountUnknown", {}, { status: 400 });
    }
    next.breakGlassUserIds = next.breakGlassUserIds.filter((id) => existing.has(id));
  }
  if (next.enforced) {
    const [provider] = await db
      .select({ id: oauthProviders.id })
      .from(oauthProviders)
      .where(and(eq(oauthProviders.enabled, true), ne(oauthProviders.type, LDAP_PROVIDER_TYPE)))
      .limit(1);
    if (!provider) throw domainError("ssoEnforcementNeedsProvider", {}, { status: 400 });
  }
  await setSetting("sso_enforcement", next);
  return next;
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

  // The legacy single-provider shape.
  if ("provider" in raw && "credentials" in raw && !("providers" in raw)) {
    const name = raw.provider as string;
    const creds = raw.credentials as Record<string, string>;
    return { providers: { [name]: creds }, default: name };
  }

  return raw as unknown as DnsProviderSettings;
}

/** Encrypts here, not in the callers: the REST API saved credentials in plaintext when it was theirs. */
export async function saveDnsProviderSettings(settings: DnsProviderSettings): Promise<void> {
  await setSetting("dns_provider", encryptDnsProviderSettingCredentials(settings));
}

export async function getUpstreamDnsResolutionSettings(): Promise<UpstreamDnsResolutionSettings | null> {
  return await getSetting<UpstreamDnsResolutionSettings>("upstream_dns_resolution");
}

export async function saveUpstreamDnsResolutionSettings(
  settings: UpstreamDnsResolutionSettings,
): Promise<void> {
  await setSetting("upstream_dns_resolution", settings);
}

/** Global rate-limit zones and the never-limited allowlist; see proxy-hosts/rate-limit-global. */
export async function getRateLimitSettings(): Promise<GlobalRateLimitSettings | null> {
  return sanitizeGlobalRateLimit(await getSetting<unknown>("rate_limit"));
}

export async function saveRateLimitSettings(settings: GlobalRateLimitSettings): Promise<void> {
  await setSetting("rate_limit", normalizeGlobalRateLimitInput(settings));
}

export async function getGeoBlockSettings(): Promise<GeoBlockSettings | null> {
  return await getSetting<GeoBlockSettings>("geoblock");
}

export async function saveGeoBlockSettings(settings: GeoBlockSettings): Promise<void> {
  await setSetting("geoblock", settings);
}

export type WafSettings = WafTuning & {
  enabled: boolean;
  // Coraza's SecRuleEngine values; buildWafHandler rejects anything else.
  mode: "Off" | "On" | "DetectionOnly";
  load_owasp_crs: boolean;
  custom_directives: string;
  // Refuse the risky custom directives (file reads, engine changes, setenv) instead of warning.
  strict_directives?: boolean;
  // Superseded by the waf_exclusions table, which startup moves these into; still honoured.
  excluded_rule_ids?: number[];
  // Never stored: the exclusions a built handler applies, attached by the config build.
  exclusions?: WafExclusionRule[];
  // waf_presets ids, emitted in this order ahead of the CRS rules.
  preset_ids?: number[];
  // crs_plugins ids; emitted only alongside the CRS.
  plugin_ids?: number[];
  // Bytes. Unset means Coraza's default (12.5 MiB with the CRS, else 128 MiB); capped at 1 GiB.
  request_body_limit?: number;
  request_body_in_memory_limit?: number;
  // ProcessPartial inspects the leading bytes and forwards the rest rather than rejecting.
  request_body_limit_action?: "Reject" | "ProcessPartial";
};

export async function getWafSettings(): Promise<WafSettings | null> {
  return await getSetting<WafSettings>("waf");
}

export async function saveWafSettings(s: WafSettings): Promise<void> {
  // Lazy: waf-dry-run reaches the models, which import this module.
  const { assertWafLoads, wafCandidatesForGlobal } = await import("../waf/dry-run");
  await assertWafLoads(await wafCandidatesForGlobal(withoutRuntimeWafFields(s)));
  await setSetting("waf", withoutRuntimeWafFields(s));
}

/** For a rewrite that leaves the emitted config unchanged, so has nothing for Coraza to check. */
export async function saveWafSettingsUnchecked(s: WafSettings): Promise<void> {
  await setSetting("waf", withoutRuntimeWafFields(s));
}

function withoutRuntimeWafFields(s: WafSettings): WafSettings {
  const { exclusions: _exclusions, ...stored } = s;
  return stored;
}

// Fallbacks for every proxy host; per-host error pages win.
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
 * The auth key stays encrypted: the Settings page reads this too, and decrypting here would put
 * the key one careless prop from the browser. Config generation decrypts it explicitly.
 */
export async function getTailscaleSettings(): Promise<TailscaleSettings | null> {
  const value = await getSetting<unknown>("tailscale");
  if (value === null) return null;

  try {
    // Throwing here would fail every config apply, taking every other host down with it.
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

export function defaultTailscaleSettings(): TailscaleSettings {
  return { ...DEFAULT_TAILSCALE_SETTINGS, tags: [] };
}

// ─── Caddy build ─────────────────────────────────────────────────────────────

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

// Unmatched requests. Missing (or mode "caddy") keeps Caddy's native behaviour.
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
