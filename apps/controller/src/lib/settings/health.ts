/**
 * Every status derives from a value this deployment holds, so "attention" means something
 * checkable went wrong, not merely unconfigured. No Caddy or network reads: a round trip per tile
 * is too slow.
 */

import type { useTranslations } from "next-intl";
import type { AnalyticsView, GeoipView } from "./optional-features";
import { storageKeysForSection } from "./section-keys";
import type {
  DnsProviderSettings,
  GeoBlockSettings,
  MetricsSettings,
  TrustedProxiesSettings,
  CaddyBuildSettings,
  DefaultResponseSettings,
} from "./index";

export type SectionStatus = "ok" | "attention" | "unset" | "env";

/** Type-only: the page passes its server translator, the tests one built over the catalog. */
type SettingsTranslator = ReturnType<typeof useTranslations<"settings">>;

export type SectionHealth = {
  /** The settings navigation's section id, so a tile links straight to it. */
  id: string;
  name: string;
  status: SectionStatus;
  /** Already translated; rendered as-is. */
  value: string;
  detail?: string;
  /** Holds part of the viewer's staged change set. */
  staged?: boolean;
};

export type HealthInput = {
  dnsProvider: DnsProviderSettings | null;
  acmeConfigured: boolean;
  certificateCount: number;
  trustedProxies: TrustedProxiesSettings | null;
  defaultResponse: DefaultResponseSettings | null;
  geoBlock: GeoBlockSettings | null;
  geoip: GeoipView;
  analytics: AnalyticsView;
  metrics: MetricsSettings | null;
  caddyBuild: CaddyBuildSettings | null;
  oauthProviderCount: number;
  agentsConnected: number;
  agentsPaired: number;
  /**
   * The rest of the blocks, reduced on the server to what a tile says: never a raw settings blob,
   * which can carry credentials (tests/unit/browser-secret-boundaries.test.ts).
   */
  general: { defaultDomain: string; acmeEmail: string };
  updates: {
    enabled: boolean;
    current: string;
    latest: string | null;
    updateAvailable: boolean;
    error: string | null;
  };
  faviconSet: boolean;
  instance: { appName: string; baseUrl: string };
  gravatarEnabled: boolean;
  errorPageRules: number;
  globalCaddyfileLines: number;
  httpCacheStorage: string;
  dashboardHost: { enabled: boolean; domain: string; tls: boolean } | null;
  email: { status: "off" | "incomplete" | "ready"; host: string };
  notifications: { alertDays: number; lastError: string | null; noRecipients: boolean };
  dnsResolvers: { enabled: boolean; count: number };
  upstreamDns: { enabled: boolean; family: "ipv4" | "ipv6" | "both" } | null;
  httpProtocols: { http2: boolean; http3: boolean };
  compressionEnabled: boolean;
  tailscaleEnabled: boolean;
  ldapDirectoryCount: number;
  signIn: { localUsersDisabled: boolean; accountLockEnabled: boolean };
  captchaProvider: string | null;
  twoFactorMode: "off" | "admins" | "all";
  requireChangeOnLegacyHash: boolean;
  authentikOutpost: string;
  forwardAuth: { provider: "authelia" | "custom"; upstream: string } | null;
  crowdsec: { enabled: boolean; mode: "external" | "managed" };
  /** Counts only. Optional for callers that predate it. */
  rateLimit?: { enabled: boolean; zones: number; allowlist: number };
  logging: { enabled: boolean; format: "json" | "console" };
  stagedKeys: ReadonlySet<string>;
  /** Injected so staleness is a pure function of the input. */
  now?: number;
};

/** Some counts go in as strings, so ICU does not group them ("1,000"). */
export function sectionHealth(input: HealthInput, t: SettingsTranslator): SectionHealth[] {
  const staged = (id: string) => storageKeysForSection(id).some((key) => input.stagedKeys.has(key));

  const sections: SectionHealth[] = [];

  const providers = Object.keys(input.dnsProvider?.providers ?? {});
  const activeProvider = input.dnsProvider?.default ?? null;
  sections.push({
    id: "dns-providers",
    name: t("blocks.dnsProviders.name"),
    status: activeProvider ? "ok" : "unset",
    value: activeProvider
      ? providers.length > 1
        ? t("health.dnsProviders.valueMore", {
            provider: activeProvider,
            count: String(providers.length - 1),
          })
        : activeProvider
      : t("health.dnsProviders.valueNone"),
    detail: activeProvider ? undefined : t("health.dnsProviders.detailNone"),
    staged: staged("dns-providers"),
  });

  const certificateCount = input.certificateCount;
  sections.push({
    id: "acme",
    name: t("blocks.acme.name"),
    status: "ok",
    value: input.acmeConfigured
      ? t("health.acme.valueCustom", { count: certificateCount })
      : t("health.acme.valueLetsEncrypt", { count: certificateCount }),
    staged: staged("acme"),
  });

  const ranges = input.trustedProxies?.ranges ?? [];
  // Behind another proxy with no trusted range, geo-block sees only that proxy's IP.
  const geoBlockNeedsProxies = Boolean(input.geoBlock?.enabled) && ranges.length === 0;
  sections.push({
    id: "trusted-proxies",
    name: t("blocks.trustedProxies.name"),
    status: geoBlockNeedsProxies ? "attention" : ranges.length > 0 ? "ok" : "unset",
    value:
      ranges.length > 0
        ? t("health.trustedProxies.valueRanges", { count: ranges.length })
        : t("health.trustedProxies.valueNone"),
    detail: geoBlockNeedsProxies ? t("health.trustedProxies.detailGeoBlock") : undefined,
    staged: staged("trusted-proxies"),
  });

  const hasDefaultResponse = Boolean(input.defaultResponse);
  sections.push({
    id: "default-response",
    name: t("blocks.defaultResponse.name"),
    status: hasDefaultResponse ? "ok" : "unset",
    value: hasDefaultResponse
      ? t("health.defaultResponse.valueConfigured")
      : t("health.defaultResponse.valueUnset"),
    detail: hasDefaultResponse ? undefined : t("health.defaultResponse.detailUnset"),
    staged: staged("default-response"),
  });

  sections.push({
    id: "oauth",
    name: t("blocks.oauth.name"),
    status: input.oauthProviderCount > 0 ? "ok" : "unset",
    value:
      input.oauthProviderCount > 0
        ? t("health.oauth.valueProviders", { count: input.oauthProviderCount })
        : t("health.oauth.valueLocalOnly"),
    staged: staged("oauth"),
  });

  // Enabled with nothing on disk silently misses every lookup.
  const geoipEmpty = input.geoip.enabled && input.geoip.installedEditions.length === 0;
  const ageDays = input.geoip.databaseAgeDays;
  const installed = input.geoip.installedEditions.length;

  // Behind needs no threshold; age alone cannot tell it from MaxMind not having published.
  const behind = input.geoip.enabled ? input.geoip.editionsBehind : [];
  // Two missed checks make "behind" unknowable, so that is flagged on its own.
  const now = input.now ?? Date.now();
  const checkAgeMs = input.geoip.lastCheckedAt
    ? now - Date.parse(input.geoip.lastCheckedAt)
    : Number.POSITIVE_INFINITY;
  const stalledAfterMs = 2 * input.geoip.updateIntervalHours * 60 * 60 * 1000;
  const checkStalled = input.geoip.enabled && !(checkAgeMs < stalledAfterMs);
  const geoipAttention = geoipEmpty || behind.length > 0 || checkStalled;
  const downloadError = input.geoip.downloadError;

  sections.push({
    id: "geoip",
    name: t("health.geoip.name"),
    status: geoipAttention ? "attention" : input.geoip.enabled ? "ok" : "unset",
    value: !input.geoip.enabled
      ? t("health.off")
      : geoipEmpty
        ? t("health.geoip.valueEmpty")
        : behind.length > 0
          ? t("health.geoip.valueBehind", { behind: String(behind.length), installed })
          : ageDays === 0
            ? t("health.geoip.valueToday", { count: installed })
            : t("health.geoip.valueAge", { count: installed, days: ageDays ?? 0 }),
    detail: geoipEmpty
      ? downloadError
        ? t("health.geoip.detailEmptyDownloadFailed", { error: downloadError })
        : t("health.geoip.detailEmpty")
      : behind.length > 0
        ? downloadError
          ? t("health.geoip.detailBehindDownloadFailed", {
              editions: behind.join(", "),
              error: downloadError,
            })
          : t("health.geoip.detailBehind", { editions: behind.join(", ") })
        : checkStalled
          ? input.geoip.checkError
            ? t("health.geoip.detailCheckFailed", { error: input.geoip.checkError })
            : t("health.geoip.detailCheckStalled")
          : undefined,
    staged: staged("geoip"),
  });

  const blockedCountries = input.geoBlock?.block_countries?.length ?? 0;
  // No database fails open, quietly; a stale one matches reassigned ranges to the wrong country.
  const blockingWithoutData = Boolean(input.geoBlock?.enabled) && geoipEmpty;
  const blockingOnStaleData = Boolean(input.geoBlock?.enabled) && behind.length > 0;
  sections.push({
    id: "geoblock",
    name: t("health.geoblock.name"),
    status:
      blockingWithoutData || blockingOnStaleData
        ? "attention"
        : input.geoBlock?.enabled
          ? "ok"
          : "unset",
    value: input.geoBlock?.enabled
      ? t("health.geoblock.valueDenying", { count: blockedCountries })
      : t("health.off"),
    detail: blockingWithoutData
      ? t("health.geoblock.detailNoData")
      : blockingOnStaleData
        ? t("health.geoblock.detailStaleData")
        : undefined,
    staged: staged("geoblock"),
  });

  const agentsMissing = input.agentsPaired > 0 && input.agentsConnected === 0;
  sections.push({
    id: "agent",
    name: t("blocks.agent.name"),
    status: input.agentsPaired === 0 ? "unset" : agentsMissing ? "attention" : "ok",
    value:
      input.agentsPaired === 0
        ? t("health.agent.valueNone")
        : t("health.agent.valueConnected", {
            connected: String(input.agentsConnected),
            paired: String(input.agentsPaired),
          }),
    detail: agentsMissing
      ? t("health.agent.detailMissing")
      : input.agentsPaired === 0
        ? t("health.agent.detailNone")
        : undefined,
    staged: staged("agent"),
  });

  // An absent id means on, so only explicit `false` subtracts from the stock build.
  const disabled = Object.values(input.caddyBuild?.modules ?? {}).filter(
    (enabled) => enabled === false,
  ).length;
  const custom = input.caddyBuild?.customModules?.length ?? 0;
  sections.push({
    id: "caddy-build",
    name: t("blocks.caddyBuild.name"),
    status: "ok",
    value:
      custom > 0 || disabled > 0
        ? t("health.caddyBuild.valueCustom", {
            custom: String(custom),
            disabled: String(disabled),
          })
        : t("health.caddyBuild.valueStock"),
    staged: staged("caddy-build"),
  });

  sections.push({
    id: "metrics",
    name: t("health.metrics.name"),
    status: input.metrics?.enabled ? "ok" : "unset",
    value: input.metrics?.enabled
      ? t("health.metrics.valuePort", { port: String(input.metrics.port ?? 9090) })
      : t("health.off"),
    staged: staged("metrics"),
  });

  // Not a fault, but it explains why this page cannot change the toggle.
  const analyticsFromEnv = input.analytics.source === "environment";
  sections.push({
    id: "analytics",
    name: t("blocks.analytics.name"),
    status: analyticsFromEnv ? "env" : input.analytics.enabled ? "ok" : "unset",
    value: input.analytics.enabled
      ? t("health.analytics.valueRetention", { days: String(input.analytics.retentionDays) })
      : t("health.off"),
    detail: analyticsFromEnv ? t("health.analytics.detailEnv") : undefined,
    staged: staged("analytics"),
  });

  // ── The remaining blocks: one tile each, so the overview covers every block ──

  const onOff = (on: boolean) => (on ? t("health.on") : t("health.off"));
  const push = (
    id: string,
    nameKey: string,
    status: SectionStatus,
    value: string,
    detail?: string,
  ) =>
    sections.push({
      id,
      name: (t as unknown as (key: string) => string)(`blocks.${nameKey}.name`),
      status,
      value,
      detail,
      staged: staged(id),
    });

  push(
    "general",
    "general",
    input.general.defaultDomain ? "ok" : "unset",
    input.general.defaultDomain || t("health.general.valueNone"),
    input.general.acmeEmail
      ? t("health.general.detailAcmeEmail", { email: input.general.acmeEmail })
      : undefined,
  );

  const { updates } = input;
  push(
    "updates",
    "updates",
    !updates.enabled ? "unset" : updates.error ? "attention" : "ok",
    !updates.enabled
      ? t("health.off")
      : updates.updateAvailable && updates.latest
        ? t("health.updates.valueAvailable", { latest: updates.latest, current: updates.current })
        : updates.latest
          ? t("health.updates.valueCurrent", { current: updates.current })
          : t("health.updates.valueUnchecked"),
    updates.enabled && updates.error
      ? t("health.updates.detailError", { error: updates.error })
      : undefined,
  );

  push(
    "branding",
    "branding",
    input.faviconSet ? "ok" : "unset",
    input.faviconSet ? t("health.branding.valueCustom") : t("health.branding.valueDefault"),
  );

  push("instance", "instance", "ok", input.instance.appName, input.instance.baseUrl || undefined);

  push(
    "avatars",
    "avatars",
    input.gravatarEnabled ? "ok" : "unset",
    input.gravatarEnabled ? t("health.avatars.valueGravatar") : t("health.off"),
  );

  push(
    "error-pages",
    "errorPages",
    input.errorPageRules > 0 ? "ok" : "unset",
    input.errorPageRules > 0
      ? t("health.errorPages.valueRules", { count: input.errorPageRules })
      : t("health.errorPages.valueNone"),
  );

  push(
    "global-caddy-config",
    "globalCaddyConfig",
    input.globalCaddyfileLines > 0 ? "ok" : "unset",
    input.globalCaddyfileLines > 0
      ? t("health.globalCaddyConfig.valueLines", { count: input.globalCaddyfileLines })
      : t("health.globalCaddyConfig.valueNone"),
  );

  push(
    "http-cache",
    "httpCache",
    "ok",
    t("health.httpCache.valueStorage", { storage: input.httpCacheStorage }),
  );

  const dashboard = input.dashboardHost;
  push(
    "dashboard",
    "dashboard",
    dashboard?.enabled ? "ok" : "unset",
    dashboard?.enabled && dashboard.domain
      ? `${dashboard.tls ? "https" : "http"}://${dashboard.domain}`
      : t("health.off"),
  );

  push(
    "email",
    "email",
    input.email.status === "ready"
      ? "ok"
      : input.email.status === "incomplete"
        ? "attention"
        : "unset",
    input.email.status === "ready"
      ? t("health.email.valueReady", { host: input.email.host })
      : input.email.status === "incomplete"
        ? t("health.email.valueIncomplete")
        : t("health.off"),
    input.email.status === "incomplete" ? t("health.email.detailIncomplete") : undefined,
  );

  const { notifications } = input;
  const notificationsFailing = Boolean(notifications.lastError) || notifications.noRecipients;
  push(
    "certificate-alerts",
    "certificateAlerts",
    notificationsFailing ? "attention" : notifications.alertDays > 0 ? "ok" : "unset",
    notifications.alertDays > 0
      ? t("health.certificateAlerts.valueDays", { days: notifications.alertDays })
      : t("health.certificateAlerts.valueAlertsOff"),
    notifications.lastError
      ? t("health.certificateAlerts.detailFailed", { error: notifications.lastError })
      : notifications.noRecipients
        ? t("health.certificateAlerts.detailNoRecipients")
        : undefined,
  );

  push(
    "dns-resolvers",
    "dnsResolvers",
    input.dnsResolvers.enabled && input.dnsResolvers.count > 0 ? "ok" : "unset",
    input.dnsResolvers.enabled && input.dnsResolvers.count > 0
      ? t("health.dnsResolvers.valueResolvers", { count: input.dnsResolvers.count })
      : t("health.dnsResolvers.valueDefault"),
  );

  push(
    "upstream-dns",
    "upstreamDns",
    input.upstreamDns?.enabled ? "ok" : "unset",
    input.upstreamDns?.enabled
      ? t("health.upstreamDns.valueFamily", { family: input.upstreamDns.family })
      : t("health.off"),
  );

  const { http2, http3 } = input.httpProtocols;
  push(
    "http-protocols",
    "httpProtocols",
    "ok",
    http2 && http3
      ? t("health.httpProtocols.valueBoth")
      : http2
        ? t("health.httpProtocols.valueHttp2")
        : http3
          ? t("health.httpProtocols.valueHttp3")
          : t("health.httpProtocols.valueHttp1"),
  );

  push(
    "compression",
    "compression",
    input.compressionEnabled ? "ok" : "unset",
    onOff(input.compressionEnabled),
  );

  push(
    "tailscale",
    "tailscale",
    input.tailscaleEnabled ? "ok" : "unset",
    onOff(input.tailscaleEnabled),
  );

  push(
    "ldap",
    "ldap",
    input.ldapDirectoryCount > 0 ? "ok" : "unset",
    input.ldapDirectoryCount > 0
      ? t("health.ldap.valueDirectories", { count: input.ldapDirectoryCount })
      : t("health.ldap.valueNone"),
  );

  push(
    "sign-in",
    "signIn",
    "ok",
    input.signIn.localUsersDisabled
      ? t("health.signIn.valueSsoOnly")
      : t("health.signIn.valueLocal"),
    input.signIn.accountLockEnabled ? undefined : t("health.signIn.detailNoLock"),
  );

  push(
    "captcha",
    "captcha",
    input.captchaProvider ? "ok" : "unset",
    input.captchaProvider ?? t("health.off"),
  );

  push(
    "two-factor",
    "twoFactor",
    input.twoFactorMode !== "off" ? "ok" : "unset",
    input.twoFactorMode === "all"
      ? t("health.twoFactor.valueAll")
      : input.twoFactorMode === "admins"
        ? t("health.twoFactor.valueRequired")
        : t("health.twoFactor.valueOptional"),
  );

  push(
    "password-policy",
    "passwordPolicy",
    "ok",
    input.requireChangeOnLegacyHash
      ? t("health.passwordPolicy.valueRequireChange")
      : t("health.passwordPolicy.valueAccept"),
  );

  push(
    "authentik",
    "authentik",
    input.authentikOutpost ? "ok" : "unset",
    input.authentikOutpost || t("health.notSet"),
  );

  push(
    "forward-auth",
    "forwardAuth",
    input.forwardAuth ? "ok" : "unset",
    input.forwardAuth
      ? t("health.forwardAuth.valueProvider", {
          provider: input.forwardAuth.provider,
          upstream: input.forwardAuth.upstream,
        })
      : t("health.notSet"),
  );

  push(
    "crowdsec",
    "crowdsec",
    input.crowdsec.enabled ? "ok" : "unset",
    input.crowdsec.enabled
      ? t("health.crowdsec.valueMode", { mode: input.crowdsec.mode })
      : t("health.off"),
  );

  const globalZones = input.rateLimit?.enabled ? input.rateLimit.zones : 0;
  push(
    "rate-limit",
    "rateLimit",
    globalZones > 0 ? "ok" : "unset",
    globalZones > 0
      ? t("health.rateLimit.valueZones", { count: globalZones })
      : t("health.rateLimit.valueNone"),
  );

  // Off is worth knowing about: upstream-error notifications and CrowdSec both read this log.
  push(
    "logging",
    "logging",
    input.logging.enabled ? "ok" : "unset",
    input.logging.enabled
      ? t("health.logging.valueFormat", { format: input.logging.format })
      : t("health.off"),
  );

  return sections;
}

/** Drives the band above the grid. */
export function needsAttention(sections: SectionHealth[]): SectionHealth[] {
  return sections.filter((section) => section.status === "attention");
}
