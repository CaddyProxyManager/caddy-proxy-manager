import { requireCan } from "@/src/lib/users/permissions";
import { localUsersDisabled } from "@/src/lib/auth/policy";
import { redactHttpCacheSettings } from "@/src/lib/proxy-hosts/http-cache";
import { defaultDashboardSettings } from "@/src/lib/dashboard-host";
import { redirect } from "next/navigation";
import SettingsClient from "../SettingsClient";
import { findSettingsItem, LEGACY_SECTION_PAGES, settingsSectionName } from "../sections";
import {
  getGeneralSettings,
  getAcmeSettings,
  getAuthentikSettings,
  getForwardAuthSettings,
  getMetricsSettings,
  getLoggingSettings,
  getDnsSettings,
  getDnsProviderSettings,
  getUpstreamDnsResolutionSettings,
  getGeoBlockSettings,
  getRateLimitSettings,
  getErrorPagesSettings,
  getTrustedProxiesSettings,
  getHttpProtocolsSettings,
  getCompressionSettings,
  getGlobalCaddyConfigSettings,
  getHttpCacheSettings,
  getTwoFactorPolicySettings,
  getSsoEnforcementSettings,
  getDefaultResponseSettings,
  getAvatarSettings,
  getPasswordPolicySettings,
  getCaddyBuildSettings,
  getDashboardSettings,
  getTailscaleSettings,
  defaultTailscaleSettings,
  getCrowdSecSettings,
} from "@/src/lib/settings";
import { redactCrowdSecSettings } from "@/src/lib/caddy/crowdsec";
import { getPrimaryProviderId, listOAuthProviders } from "@/src/lib/models/oauth-providers";
import { listLdapDirectories } from "@/src/lib/models/ldap-directories";
import { listSamlProviders } from "@/src/lib/models/saml-providers";
import { listBreakGlassCandidates } from "@/src/lib/auth/sso-break-glass";
import { listRoles } from "@/src/lib/roles/store";
import { getAllAgentBuildSettings, listAgents } from "@/src/lib/models/agents";
import { getAllAgentStatuses, listAgentOptions } from "@/src/lib/agent/client";
import { autoPairingDisabled } from "@/src/lib/agent/bootstrap";
import { getFavicon } from "@/src/lib/branding";
import { getUpdateStatus } from "@/src/lib/runtime/updates";
import { analyticsView, geoipView } from "@/src/lib/settings/optional-features";
import { emailSettingsView } from "@/src/lib/email/view";
import { DNS_PROVIDERS } from "@/src/lib/dns/providers";
import { redactTailscaleSettingsForApi } from "@/src/lib/caddy/tailscale";
import { config } from "@/src/lib/config";
import { getPublicBaseUrl } from "@/src/lib/http/public-url";
import { anyPasskeysExist } from "@/src/lib/auth/passkeys";
import { stagedView } from "@/src/lib/settings/staged-view";
import { registryFields } from "../registry-fields";
import { forwardAuthSequentialUserIds } from "@/src/lib/settings/registry";
import { captchaSettingsView, getCaptchaSettings } from "@/src/lib/captcha/settings";
import { stagedOverlay } from "@/src/lib/settings/staging";
import { withStagedReads } from "@/src/lib/settings/staging-context";
import { redactDnsProviderSettingsForApi } from "@/src/lib/dns/providers";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { storedErrorMessage } from "@/src/lib/errors/action-error";
import { dashboardHostFormView } from "@/src/lib/dashboard-host/options";
import { listCertificateSummaries } from "@/src/lib/models/certificates";
import { listCaCertificates } from "@/src/lib/models/ca-certificates";
import { listAccessLists } from "@/src/lib/models/access-lists";
import { listMtlsRoles } from "@/src/lib/models/mtls-roles";
import { listIssuedClientCertificates } from "@/src/lib/models/issued-client-certificates";
import { toCertificatePickerOption } from "@/src/lib/certificates/api";
import type { DashboardHostOptionsData } from "@/src/components/proxy-hosts/DashboardHostOptionsFields";
import { listWafPresets, toWafPresetOption } from "@/src/lib/models/waf-presets";
import { listCrsPlugins, toCrsPluginOption } from "@/src/lib/models/crs-plugins";
import { managedServiceView } from "@/src/lib/agent/managed-services";
import { outboundCallViews } from "@/src/lib/offline";

/** The section's own name: a screen reader announces the title on every switch between them. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ section: string }>;
}): Promise<Metadata> {
  const item = findSettingsItem((await params).section);
  if (!item) return { title: (await getTranslations("nav"))("settings") };
  return { title: settingsSectionName(await getTranslations("settings"), item) };
}

/**
 * The public route while the icon is the live one; inline only for a staged icon, which nothing
 * else serves. Inlined always, every settings load would carry up to ~340 KB of base64.
 */
function faviconSrc(
  staged: { data: string; type: string; hash: string } | null,
  live: { hash: string } | null,
): string | null {
  if (!staged) return null;
  if (staged.hash === live?.hash) return `/api/branding/favicon?v=${staged.hash}`;
  return `data:${staged.type};base64,${staged.data}`;
}

/** The client switches sections itself; this only picks where a fresh load or deep link opens. */
export default async function SettingsSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const session = await requireCan("settings:read");
  const { section } = await params;

  // Formerly separate pages, still linked and bookmarked, so they land on the block itself.
  const legacy = LEGACY_SECTION_PAGES.get(section);
  if (legacy) redirect(`/settings/${legacy.page}#${legacy.anchor}`);

  const userId = Number(session.user.id);

  // Outside the staged scope: what the public route serves, to tell a staged icon from it.
  const liveFavicon = await getFavicon().catch(() => null);

  // Reads resolve against the staged set, or a reload makes a staged edit look discarded.
  const overlay = await stagedOverlay(userId);
  // For the stored update-check and GeoIP failures.
  const tRoot = await getTranslations();
  // Resolved here, inside the staged scope, so a pending edit to one of them reads as pending.
  const registry = await withStagedReads(overlay, () => registryFields(tRoot));

  // Not settings, so deliberately outside the staged scope; being AsyncLocalStorage, a sibling
  // promise cannot see it. getAllAgentStatuses never throws.
  const [
    [
      general,
      acme,
      dnsProvider,
      authentik,
      forwardAuth,
      metrics,
      logging,
      dns,
      upstreamDnsResolution,
      globalGeoBlock,
      globalErrorPages,
      trustedProxies,
      httpProtocols,
      compression,
      globalCaddyConfig,
      httpCache,
      twoFactorPolicy,
      defaultResponse,
      oauthProviders,
      primaryProviderId,
      avatarSettings,
      passwordPolicySettings,
      captchaSettings,
      crowdsecSettings,
      caddyBuild,
      tailscale,
      dashboard,
      analytics,
      geoip,
      favicon,
      updates,
      globalRateLimit,
    ],
    pairedAgents,
    agentStatuses,
    agentBuildSelections,
    staged,
    agentOptions,
    autoPairingOff,
    publicBaseUrl,
    email,
    ldapDirectories,
  ] = await Promise.all([
    withStagedReads(overlay, () =>
      Promise.all([
        getGeneralSettings(),
        getAcmeSettings(),
        getDnsProviderSettings(),
        getAuthentikSettings(),
        getForwardAuthSettings(),
        getMetricsSettings(),
        getLoggingSettings(),
        getDnsSettings(),
        getUpstreamDnsResolutionSettings(),
        getGeoBlockSettings(),
        getErrorPagesSettings(),
        getTrustedProxiesSettings(),
        getHttpProtocolsSettings(),
        getCompressionSettings(),
        getGlobalCaddyConfigSettings(),
        getHttpCacheSettings(),
        getTwoFactorPolicySettings(),
        getDefaultResponseSettings(),
        listOAuthProviders(),
        getPrimaryProviderId(),
        getAvatarSettings(),
        getPasswordPolicySettings(),
        getCaptchaSettings(),
        getCrowdSecSettings(),
        getCaddyBuildSettings(),
        getTailscaleSettings(),
        getDashboardSettings(),
        analyticsView(),
        geoipView(tRoot),
        getFavicon(),
        getUpdateStatus(),
        getRateLimitSettings(),
      ]),
    ),
    listAgents(),
    getAllAgentStatuses(),
    getAllAgentBuildSettings(),
    stagedView(userId),
    listAgentOptions().catch(() => []),
    autoPairingDisabled().catch(() => false),
    // Outside the staged scope: the callback URLs shown must be the ones sign-in uses right now.
    getPublicBaseUrl(),
    // Never staged either: its actions write straight through.
    emailSettingsView(),
    // Nor these: a directory is a row, saved by its own actions.
    listLdapDirectories(),
  ]);
  // Provider rows are saved by their own actions; only the enforcement block is staged.
  const [ssoEnforcement, breakGlassCandidates, samlProviders] = await Promise.all([
    withStagedReads(overlay, () => getSsoEnforcementSettings()),
    listBreakGlassCandidates(),
    listSamlProviders(),
  ]);
  const dashboardSettings = dashboard ?? defaultDashboardSettings();
  const crowdsecManaged =
    section === "crowdsec" ? await managedServiceView("crowdsec", tRoot) : null;
  // Every section: the client switches between them without a load. Staged, so a staged offline
  // switch shows what applying it would turn off.
  const outboundCalls = await withStagedReads(overlay, () => outboundCallViews());

  // Only on the dashboard section, so other sections don't pay for the host form's pickers.
  let dashboardOptions: DashboardHostOptionsData | null = null;
  if (section === "dashboard") {
    const [
      certificates,
      caCertificates,
      accessLists,
      mtlsRoles,
      issuedClientCerts,
      wafPresets,
      crsPlugins,
    ] = await Promise.all([
      listCertificateSummaries(),
      listCaCertificates(),
      listAccessLists(),
      listMtlsRoles().catch(() => []),
      listIssuedClientCertificates().catch(() => []),
      listWafPresets(),
      listCrsPlugins(),
    ]);
    dashboardOptions = {
      view: dashboardHostFormView(dashboardSettings.options),
      certificates: certificates.map(toCertificatePickerOption),
      caCertificates,
      accessLists,
      mtlsRoles,
      issuedClientCerts,
      wafPresets: wafPresets.map(toWafPresetOption),
      wafPlugins: crsPlugins.map(toCrsPluginOption),
      authentikDefaults: authentik,
      forwardAuthDefaults: forwardAuth,
      agents: agentOptions,
      tailscaleDefaults: {
        enabled: tailscale?.enabled ?? false,
        hasAuthKey: (tailscale?.authKey ?? "").trim().length > 0,
        defaultNode: tailscale?.defaultNode ?? "",
      },
    };
  }

  const connectedAgentIds = new Set(agentOptions.filter((a) => a.connected).map((a) => a.id));

  return (
    <SettingsClient
      initialSection={section}
      staged={staged}
      general={general}
      acme={acme}
      dnsProvider={dnsProvider ? redactDnsProviderSettingsForApi(dnsProvider) : null}
      dnsProviderDefinitions={DNS_PROVIDERS}
      authentik={authentik}
      forwardAuth={forwardAuth}
      metrics={metrics}
      logging={logging}
      dns={dns}
      upstreamDnsResolution={upstreamDnsResolution}
      trustedProxies={trustedProxies}
      httpProtocols={httpProtocols}
      compression={compression}
      globalCaddyConfig={globalCaddyConfig}
      httpCache={redactHttpCacheSettings(httpCache)}
      twoFactorPolicy={twoFactorPolicy}
      ssoEnforcement={ssoEnforcement}
      breakGlassCandidates={breakGlassCandidates}
      samlProviders={samlProviders}
      defaultResponse={defaultResponse}
      globalGeoBlock={globalGeoBlock}
      globalRateLimit={globalRateLimit}
      globalErrorPages={globalErrorPages}
      oauthProviders={oauthProviders}
      ldapDirectories={ldapDirectories}
      madeRoles={(await listRoles()).flatMap((role) =>
        role.name ? [{ key: role.key, name: role.name }] : [],
      )}
      primaryProviderId={primaryProviderId}
      localUsersDisabled={await localUsersDisabled()}
      avatars={{
        // The stored toggle only applies when AVATAR_GRAVATAR leaves the choice open.
        gravatarEnabled: config.avatars.gravatarFromEnv ?? avatarSettings?.gravatarEnabled ?? true,
        fromEnv: config.avatars.gravatarFromEnv !== null,
      }}
      passwordPolicy={{
        // The stored toggle only applies when the env var leaves the choice open.
        requireChangeOnLegacyHash:
          config.auth.requirePasswordChangeOnLegacyHashFromEnv ??
          passwordPolicySettings?.requireChangeOnLegacyHash ??
          false,
        fromEnv: config.auth.requirePasswordChangeOnLegacyHashFromEnv !== null,
      }}
      // The secret never leaves the server, as with Tailscale's auth key below.
      captcha={captchaSettingsView(captchaSettings)}
      crowdsec={redactCrowdSecSettings(crowdsecSettings)}
      crowdsecManaged={crowdsecManaged}
      caddyBuild={caddyBuild}
      agentBuildTargets={pairedAgents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        connected: connectedAgentIds.has(agent.id),
      }))}
      // A Map does not survive the server/client boundary.
      agentBuildSelections={Object.fromEntries(agentBuildSelections)}
      // Only whether a key is stored, so the form can say "leave blank to keep".
      tailscale={redactTailscaleSettingsForApi(tailscale ?? defaultTailscaleSettings())}
      // Never null: unset reads as off, with a domain to fill in.
      dashboard={dashboardSettings}
      dashboardOptions={dashboardOptions}
      // The image has its own route; inlining it would be hundreds of KB of base64.
      faviconSrc={faviconSrc(favicon, liveFavicon)}
      updates={{
        ...updates,
        error: updates.error ? storedErrorMessage(tRoot, updates.error, updates.errorCode) : null,
      }}
      outboundCalls={outboundCalls}
      registry={registry}
      sequentialUserIdsField={registry["forward-auth"]?.find(
        (field) => field.key === forwardAuthSequentialUserIds.key,
      )}
      analytics={analytics}
      geoip={geoip}
      email={email}
      // Container management needs an agent to run compose; the settings still save without one.
      canManageServices={agentStatuses.some((result) => result.ok)}
      baseUrl={publicBaseUrl}
      passkeysRegistered={section === "instance" && (await anyPasskeysExist())}
      agents={{
        paired: pairedAgents,
        // A failure worded here (e.g. an agent not reported yet) carries a code.
        statuses: agentStatuses.map((result) =>
          result.ok || !result.code
            ? result
            : {
                ...result,
                error: storedErrorMessage(tRoot, result.error, { code: result.code, params: {} }),
              },
        ),
        autoPairingDisabled: autoPairingOff,
      }}
    />
  );
}
