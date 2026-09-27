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
} from "../settings";

export type SectionStatus = "ok" | "attention" | "unset" | "env";

/** Type-only: the page passes its server translator, the tests one built over the catalog. */
type SettingsTranslator = ReturnType<typeof useTranslations<"settings">>;

export type SectionHealth = {
  /** The settings navigation's section id, so a tile links straight to it. */
  id: string;
  name: string;
  group: "traffic" | "access" | "runtime";
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
    group: "traffic",
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
    group: "traffic",
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
    group: "traffic",
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
    group: "traffic",
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
    group: "access",
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
    group: "access",
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
    group: "access",
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
    group: "runtime",
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
    group: "runtime",
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
    group: "runtime",
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
    group: "runtime",
    status: analyticsFromEnv ? "env" : input.analytics.enabled ? "ok" : "unset",
    value: input.analytics.enabled
      ? t("health.analytics.valueRetention", { days: String(input.analytics.retentionDays) })
      : t("health.off"),
    detail: analyticsFromEnv ? t("health.analytics.detailEnv") : undefined,
    staged: staged("analytics"),
  });

  return sections;
}

/** Drives the band above the grid. */
export function needsAttention(sections: SectionHealth[]): SectionHealth[] {
  return sections.filter((section) => section.status === "attention");
}
