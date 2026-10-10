/**
 * Settings groups for both `/api/v1/settings/[group]` and GraphQL, in one implementation: reading
 * a group name as a storage key reached any row, secrets included, and skipped each group's saver.
 */

import { applyCaddyConfig } from "../caddy";
import { logUnexpectedApiError } from "../api/auth";
import { redactTailscaleSettingsForApi } from "../caddy/tailscale";
import { type CrowdSecSettings, redactCrowdSecSettings } from "../caddy/crowdsec";
import { type HttpCacheSettings, redactHttpCacheSettings } from "../proxy-hosts/http-cache";
import {
  redactDnsProviderSettingsForApi,
  redactLegacyCloudflareSettingsForApi,
} from "../dns/providers";
import {
  getGeneralSettings,
  saveGeneralSettings,
  getAcmeSettings,
  saveAcmeSettings,
  getCloudflareSettings,
  saveCloudflareSettings,
  getAuthentikSettings,
  saveAuthentikSettings,
  getForwardAuthSettings,
  saveForwardAuthSettings,
  getMetricsSettings,
  saveMetricsSettings,
  getLoggingSettings,
  saveLoggingSettings,
  getDnsSettings,
  saveDnsSettings,
  getDnsProviderSettings,
  saveDnsProviderSettings,
  getUpstreamDnsResolutionSettings,
  saveUpstreamDnsResolutionSettings,
  getGeoBlockSettings,
  saveGeoBlockSettings,
  getRateLimitSettings,
  saveRateLimitSettings,
  getWafSettings,
  saveWafSettings,
  getErrorPagesSettings,
  saveErrorPagesSettings,
  getDefaultResponseSettings,
  saveDefaultResponseSettings,
  getTrustedProxiesSettings,
  getTwoFactorPolicySettings,
  getHttpProtocolsSettings,
  saveTrustedProxiesSettings,
  saveTwoFactorPolicySettings,
  saveHttpProtocolsSettings,
  getCompressionSettings,
  saveCompressionSettings,
  getGlobalCaddyConfigSettings,
  getHttpCacheSettings,
  saveHttpCacheSettings,
  saveGlobalCaddyConfigSettings,
  getTailscaleSettings,
  saveTailscaleSettings,
  getCrowdSecSettings,
  saveCrowdSecSettings,
  getHostDefaults,
  saveHostDefaults,
  defaultTailscaleSettings,
  getSetting,
  setSetting,
  clearSetting,
  type CloudflareSettings,
  type DnsProviderSettings,
  type TailscaleSettings,
} from "./index";
import { SettingsValidationError, validateSettingsGroup } from "./validation";
import { withSettingsUpdateLock } from "./update-lock";
import { withCapturedWrites } from "./staging-context";

type SettingsHandler = {
  get: () => Promise<unknown>;
  save: (data: never) => Promise<void>;
  storageKey: string;
  applyCaddy?: boolean;
  /** After the save and its Caddy apply: what else follows the group. */
  afterSave?: () => Promise<void>;
  /** Present for a group holding credentials; its output is what a client sees instead. */
  redact?: (value: never) => unknown;
};

const SETTINGS_HANDLERS: Record<string, SettingsHandler> = {
  general: {
    get: getGeneralSettings,
    save: saveGeneralSettings as (data: never) => Promise<void>,
    storageKey: "general",
    applyCaddy: true,
  },
  acme: {
    get: getAcmeSettings,
    save: saveAcmeSettings as (data: never) => Promise<void>,
    storageKey: "acme",
    applyCaddy: true,
  },
  cloudflare: {
    get: getCloudflareSettings,
    save: saveCloudflareSettings as (data: never) => Promise<void>,
    storageKey: "cloudflare",
    applyCaddy: true,
    redact: (value: CloudflareSettings) => redactLegacyCloudflareSettingsForApi(value),
  },
  authentik: {
    get: getAuthentikSettings,
    save: saveAuthentikSettings as (data: never) => Promise<void>,
    storageKey: "authentik",
    applyCaddy: true,
  },
  "forward-auth": {
    get: getForwardAuthSettings,
    save: saveForwardAuthSettings as (data: never) => Promise<void>,
    storageKey: "forward_auth",
    // Nothing in the config reads it, but the apply is what pushes the value to the agents.
    applyCaddy: true,
  },
  metrics: {
    get: getMetricsSettings,
    save: saveMetricsSettings as (data: never) => Promise<void>,
    storageKey: "metrics",
    applyCaddy: true,
  },
  logging: {
    get: getLoggingSettings,
    save: saveLoggingSettings as (data: never) => Promise<void>,
    storageKey: "logging",
    applyCaddy: true,
  },
  dns: {
    get: getDnsSettings,
    save: saveDnsSettings as (data: never) => Promise<void>,
    storageKey: "dns",
    applyCaddy: true,
  },
  "dns-provider": {
    get: getDnsProviderSettings,
    save: saveDnsProviderSettings as (data: never) => Promise<void>,
    storageKey: "dns_provider",
    applyCaddy: true,
    redact: (value: DnsProviderSettings) => redactDnsProviderSettingsForApi(value),
  },
  "upstream-dns": {
    get: getUpstreamDnsResolutionSettings,
    save: saveUpstreamDnsResolutionSettings as (data: never) => Promise<void>,
    storageKey: "upstream_dns_resolution",
    applyCaddy: true,
  },
  geoblock: {
    get: getGeoBlockSettings,
    save: saveGeoBlockSettings as (data: never) => Promise<void>,
    storageKey: "geoblock",
    applyCaddy: true,
  },
  "rate-limit": {
    get: getRateLimitSettings,
    save: saveRateLimitSettings as (data: never) => Promise<void>,
    storageKey: "rate_limit",
    applyCaddy: true,
  },
  waf: {
    get: getWafSettings,
    save: saveWafSettings as (data: never) => Promise<void>,
    storageKey: "waf",
    applyCaddy: true,
  },
  "error-pages": {
    get: getErrorPagesSettings,
    save: saveErrorPagesSettings as (data: never) => Promise<void>,
    storageKey: "error_pages",
    applyCaddy: true,
  },
  "default-response": {
    get: async () => (await getDefaultResponseSettings()) ?? { mode: "caddy" },
    save: saveDefaultResponseSettings as (data: never) => Promise<void>,
    storageKey: "default_response",
    applyCaddy: true,
  },
  "trusted-proxies": {
    get: getTrustedProxiesSettings,
    save: saveTrustedProxiesSettings as (data: never) => Promise<void>,
    storageKey: "trusted_proxies",
    applyCaddy: true,
  },
  "http-protocols": {
    get: getHttpProtocolsSettings,
    save: saveHttpProtocolsSettings as (data: never) => Promise<void>,
    storageKey: "http_protocols",
    applyCaddy: true,
  },
  compression: {
    get: getCompressionSettings,
    save: saveCompressionSettings as (data: never) => Promise<void>,
    storageKey: "compression",
    applyCaddy: true,
  },
  "global-caddy-config": {
    get: getGlobalCaddyConfigSettings,
    save: saveGlobalCaddyConfigSettings as (data: never) => Promise<void>,
    storageKey: "global_caddy_config",
    applyCaddy: true,
  },
  "http-cache": {
    get: getHttpCacheSettings,
    save: saveHttpCacheSettings as (data: never) => Promise<void>,
    storageKey: "http_cache",
    applyCaddy: true,
    redact: (value: HttpCacheSettings) => redactHttpCacheSettings(value),
  },
  "host-defaults": {
    get: getHostDefaults,
    save: saveHostDefaults as (data: never) => Promise<void>,
    storageKey: "host_defaults",
    // Read only when a host is created; nothing in the config follows it.
    applyCaddy: false,
  },
  "two-factor": {
    get: getTwoFactorPolicySettings,
    save: saveTwoFactorPolicySettings as (data: never) => Promise<void>,
    storageKey: "two_factor_policy",
    applyCaddy: false,
  },
  tailscale: {
    // Not null, so a GET before any save still shows the shape a PUT must send.
    get: async () => (await getTailscaleSettings()) ?? defaultTailscaleSettings(),
    save: saveTailscaleSettings as (data: never) => Promise<void>,
    storageKey: "tailscale",
    applyCaddy: true,
    redact: (value: TailscaleSettings) => redactTailscaleSettingsForApi(value),
  },
  crowdsec: {
    get: getCrowdSecSettings,
    save: saveCrowdSecSettings as (data: never) => Promise<void>,
    storageKey: "crowdsec",
    applyCaddy: true,
    // Managed mode starts or stops the bundled agent's crowdsec container.
    afterSave: async () => {
      const { applyManagedServices } = await import("../agent/managed-services");
      await applyManagedServices();
    },
    // Write-only: an omitted key keeps the stored one while the addresses stay the same.
    redact: (value: CrowdSecSettings) => redactCrowdSecSettings(value),
  },
};

/** Each needs a case in `validateSettingsGroup` too. */
export const SETTINGS_GROUPS = Object.keys(SETTINGS_HANDLERS);

/** Own keys only: a group named `constructor` must not find Object's. */
export function isSettingsGroup(group: string): boolean {
  return Object.hasOwn(SETTINGS_HANDLERS, group);
}

/** Stored, but Caddy refused. The message is safe to show. */
export class SettingsApplyError extends Error {
  constructor(
    message: string,
    readonly status: 500 | 502,
  ) {
    super(message);
    this.name = "SettingsApplyError";
  }
}

/** `sensitive` marks a redacted credential group, which must not be cached on the way out. */
export async function readSettingsGroup(
  group: string,
): Promise<{ value: unknown; sensitive: boolean } | null> {
  if (!isSettingsGroup(group)) return null;
  const handler = SETTINGS_HANDLERS[group];
  const value = await handler.get();
  if (handler.redact && value) {
    return { value: handler.redact(value as never), sensitive: true };
  }
  return { value: value ?? {}, sensitive: false };
}

/** Rolls the stored value back if Caddy refuses it. Callers answer an unknown group first. */
export async function saveSettingsGroup(group: string, input: unknown): Promise<void> {
  if (!isSettingsGroup(group)) {
    throw new SettingsValidationError("settingsGroupUnknown");
  }
  const handler = SETTINGS_HANDLERS[group];
  const validated = validateSettingsGroup(group, input, {
    previousWaf: group === "waf" ? await getWafSettings() : null,
  });

  await withSettingsUpdateLock(async () => {
    // The stored value, encrypted credentials included, not the redacted GET shape.
    const previousValue = await getSetting<unknown>(handler.storageKey);
    await handler.save(validated as never);

    if (!handler.applyCaddy) return;
    try {
      await applyCaddyConfig();
    } catch (applyError) {
      logUnexpectedApiError("Caddy settings apply failed", applyError);
      try {
        if (previousValue === null || previousValue === undefined) {
          await clearSetting(handler.storageKey);
        } else {
          await setSetting(handler.storageKey, previousValue);
        }
      } catch (rollbackError) {
        logUnexpectedApiError("Settings rollback failed", rollbackError);
        throw new SettingsApplyError(
          "Failed to apply Caddy configuration and roll back settings",
          500,
        );
      }

      // The load is atomic, but a failure can land after it while syncing instances.
      try {
        await applyCaddyConfig();
      } catch (restoreApplyError) {
        logUnexpectedApiError("Previous Caddy settings reapply failed", restoreApplyError);
      }

      throw new SettingsApplyError(
        "Failed to apply Caddy configuration; settings were rolled back",
        502,
      );
    }
    await handler.afterSave?.();
  });
}

/**
 * What saving `input` to `group` would write, by storage key, without writing it: the group's own
 * saver, validation and encryption, run under a capturing scope. A change request shows this.
 */
export async function captureSettingsGroupWrites(
  group: string,
  input: unknown,
): Promise<Map<string, string>> {
  if (!isSettingsGroup(group)) throw new SettingsValidationError("settingsGroupUnknown");
  const handler = SETTINGS_HANDLERS[group];
  const validated = validateSettingsGroup(group, input, {
    previousWaf: group === "waf" ? await getWafSettings() : null,
  });
  const { writes } = await withCapturedWrites(new Map(), () => handler.save(validated as never));
  return writes;
}

/** The storage key a group saves to. */
export function settingsGroupKey(group: string): string | null {
  return isSettingsGroup(group) ? SETTINGS_HANDLERS[group].storageKey : null;
}
