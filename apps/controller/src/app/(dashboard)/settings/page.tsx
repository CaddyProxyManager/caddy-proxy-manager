import { requireAdmin } from "@/src/lib/auth";
import {
  getAcmeSettings,
  getCaddyBuildSettings,
  getDefaultResponseSettings,
  getDnsProviderSettings,
  getGeoBlockSettings,
  getMetricsSettings,
  getTrustedProxiesSettings,
} from "@/src/lib/settings";
import { analyticsView, geoipView } from "@/src/lib/settings/optional-features";
import { listOAuthProviders } from "@/src/lib/models/oauth-providers";
import { listAgents } from "@/src/lib/models/agents";
import { listAgentOptions } from "@/src/lib/agent/client";
import { listCertificates } from "@/src/lib/models/certificates";
import { needsAttention, sectionHealth } from "@/src/lib/settings/health";
import { stagedKeys, stagedView } from "@/src/lib/settings/staged-view";
import SettingsHome from "./SettingsHome";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

/** A URL's user:password@, which an upstream may carry and a tile must not show. */
function withoutCredentials(value: string): string {
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return value;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    // Not a URL: a bare host:port, which has no credentials to strip.
    return value;
  }
}

/**
 * Every block the first batch does not cover, each reduced to the few values its tile shows, so
 * no credential-bearing blob leaves this function, let alone reaches the client.
 */
async function remainingBlocks() {
  const [
    registry,
    { getSetting },
    stored,
    { readSmtpConfig },
    { getNotificationStatus },
    { getUpdateStatus },
    { getFavicon },
    { listLdapDirectories },
    { getActiveCaptcha },
  ] = await Promise.all([
    import("@/src/lib/settings/registry"),
    import("@/src/lib/settings/resolve"),
    import("@/src/lib/settings"),
    import("@/src/lib/email/config"),
    import("@/src/lib/notifications"),
    import("@/src/lib/updates"),
    import("@/src/lib/branding"),
    import("@/src/lib/models/ldap-directories"),
    import("@/src/lib/captcha/settings"),
  ]);
  const [
    general,
    updates,
    favicon,
    appName,
    baseUrl,
    gravatarEnabled,
    errorPages,
    globalCaddy,
    httpCache,
    dashboard,
    smtp,
    alertDays,
    notifications,
    dns,
    upstreamDns,
    httpProtocols,
    compression,
    tailscale,
    ldap,
    localUsersDisabled,
    accountLockEnabled,
    captcha,
    twoFactor,
    passwordPolicy,
    authentik,
    forwardAuth,
    crowdsec,
    logging,
  ] = await Promise.all([
    stored.getGeneralSettings(),
    getUpdateStatus().catch(() => null),
    getFavicon().catch(() => null),
    getSetting(registry.appName),
    getSetting(registry.baseUrl),
    stored.isGravatarEnabled(),
    stored.getErrorPagesSettings(),
    stored.getGlobalCaddyConfigSettings(),
    stored.getHttpCacheSettings(),
    stored.getDashboardSettings(),
    readSmtpConfig(),
    getSetting(registry.certificateExpiryAlertDays),
    getNotificationStatus(),
    stored.getDnsSettings(),
    stored.getUpstreamDnsResolutionSettings(),
    stored.getHttpProtocolsSettings(),
    stored.getCompressionSettings(),
    stored.getTailscaleSettings(),
    listLdapDirectories().catch(() => []),
    getSetting(registry.disableLocalUsers),
    getSetting(registry.accountLockEnabled),
    getActiveCaptcha().catch(() => null),
    stored.getTwoFactorPolicySettings(),
    stored.getPasswordPolicySettings(),
    stored.getAuthentikSettings(),
    stored.getForwardAuthSettings(),
    stored.getCrowdSecSettings(),
    stored.getLoggingSettings(),
  ]);
  const caddyfile = globalCaddy.caddyfile.trim();
  return {
    general: { defaultDomain: general?.defaultDomain ?? "", acmeEmail: general?.acmeEmail ?? "" },
    updates: {
      enabled: updates?.enabled ?? false,
      current: updates?.current ?? "",
      latest: updates?.latest ?? null,
      updateAvailable: updates?.updateAvailable ?? false,
      error: updates?.error ?? null,
    },
    faviconSet: favicon !== null,
    instance: { appName, baseUrl },
    gravatarEnabled,
    errorPageRules: errorPages?.rules.length ?? 0,
    globalCaddyfileLines: caddyfile ? caddyfile.split("\n").length : 0,
    httpCacheStorage: httpCache.storage,
    dashboardHost: dashboard
      ? { enabled: dashboard.enabled, domain: dashboard.domain, tls: dashboard.tls }
      : null,
    email: { status: smtp.status, host: smtp.config.host },
    notifications: {
      alertDays,
      lastError: notifications.lastError,
      noRecipients: notifications.lastErrorCode === "noRecipients",
    },
    dnsResolvers: { enabled: dns?.enabled ?? false, count: dns?.resolvers.length ?? 0 },
    upstreamDns: upstreamDns ? { enabled: upstreamDns.enabled, family: upstreamDns.family } : null,
    httpProtocols,
    compressionEnabled: compression.enabled,
    tailscaleEnabled: tailscale?.enabled ?? false,
    ldapDirectoryCount: ldap.length,
    signIn: { localUsersDisabled, accountLockEnabled },
    captchaProvider: captcha?.provider ?? null,
    twoFactorRequiredForAdmins: twoFactor.requireForAdmins,
    requireChangeOnLegacyHash: passwordPolicy?.requireChangeOnLegacyHash ?? false,
    authentikOutpost: authentik?.outpostDomain ?? "",
    forwardAuth: forwardAuth?.authUpstream
      ? { provider: forwardAuth.provider, upstream: withoutCredentials(forwardAuth.authUpstream) }
      : null,
    crowdsec: { enabled: crowdsec.enabled, mode: crowdsec.mode },
    logging: { enabled: logging?.enabled ?? false, format: logging?.format ?? "json" },
  };
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("settings") };
}

/** Reads less than a section page: each value feeds one tile line, not a whole form. */
export default async function SettingsPage() {
  const session = await requireAdmin();
  const userId = Number(session.user.id);
  // The root translator, for the stored GeoIP failures the health tiles repeat.
  const tRoot = await getTranslations();

  const [
    [
      dnsProvider,
      acme,
      trustedProxies,
      defaultResponse,
      geoBlock,
      geoip,
      analytics,
      metrics,
      caddyBuild,
      oauthProviders,
      certificates,
      keys,
      staged,
      paired,
      connected,
    ],
    rest,
  ] = await Promise.all([
    Promise.all([
      getDnsProviderSettings(),
      getAcmeSettings(),
      getTrustedProxiesSettings(),
      getDefaultResponseSettings(),
      getGeoBlockSettings(),
      geoipView(tRoot),
      analyticsView(),
      getMetricsSettings(),
      getCaddyBuildSettings(),
      listOAuthProviders(),
      listCertificates(),
      stagedKeys(userId),
      stagedView(userId),
      // An unreachable agent is a tile that says so, never a 500.
      listAgents().catch(() => []),
      listAgentOptions()
        .then((options) => options.filter((option) => option.connected).length)
        .catch(() => 0),
    ]),
    remainingBlocks(),
  ]);

  const t = await getTranslations("settings");
  const sections = sectionHealth(
    {
      dnsProvider,
      acmeConfigured: Boolean(acme?.caUrl),
      certificateCount: certificates.length,
      trustedProxies,
      defaultResponse,
      geoBlock,
      geoip,
      analytics,
      metrics,
      caddyBuild,
      oauthProviderCount: oauthProviders.length,
      agentsConnected: connected,
      agentsPaired: paired.length,
      ...rest,
      stagedKeys: keys,
    },
    t,
  );

  return <SettingsHome sections={sections} attention={needsAttention(sections)} staged={staged} />;
}
