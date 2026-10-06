"use client";

import { useState, useActionState, useEffect, useRef, useTransition, type ReactNode } from "react";
import {
  CalendarDays,
  Clock,
  Container,
  EthernetPort,
  FolderOpen,
  Globe,
  KeyRound,
  Link as LinkIcon,
  Network,
  Route,
  Tag,
  User,
} from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Code } from "@astryxdesign/core/Code";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Divider } from "@astryxdesign/core/Divider";
import { Link } from "@astryxdesign/core/Link";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { FormCard, InfoAlert, StatusAlert, WarnAlert } from "@/src/components/ui/FormLayout";
import { CodeEditor } from "@/components/ui/CodeEditor";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { EmailInput } from "@/src/components/ui/EmailInput";
import {
  AUTOFILL_NEW_PASSWORD,
  AUTOFILL_OFF,
  NATIVE_REQUIRED,
} from "@/components/ui/native-input-attrs";
import type {
  GeneralSettings,
  AcmeSettings,
  AuthentikSettings,
  ForwardAuthSettings,
  MetricsSettings,
  LoggingSettings,
  DnsSettings,
  UpstreamDnsResolutionSettings,
  GeoBlockSettings,
  ErrorPagesSettings,
  TrustedProxiesSettings,
  HttpProtocolsSettings,
  CompressionSettings,
  GlobalCaddyConfigSettings,
  TwoFactorPolicySettings,
  DefaultResponseSettings,
} from "@/lib/settings";
import type { DnsProviderApiStatus, DnsProviderDefinition } from "@/src/lib/dns/providers";
import { dnsProviderDescription, dnsProviderFieldText } from "@/src/lib/dns/provider-messages";
import type { CaddyBuildSettings } from "@/lib/settings";
import type { AnalyticsView, GeoipView } from "@/src/lib/settings/optional-features";
import type { TailscaleSettingsView } from "@/src/lib/caddy/tailscale";
import type { DashboardHostSettings } from "@/src/lib/dashboard-host";
import { pairingHostFor } from "@/src/lib/dashboard-host/address";
import type { DashboardHostOptionsData } from "@/src/components/proxy-hosts/DashboardHostOptionsFields";
import type { UpdateStatus } from "@/src/lib/runtime/updates";
import { CaddyBuildFields } from "@/components/caddy-modules/CaddyBuildFields";
import { dnsModuleId } from "@/src/lib/caddy/image-build/modules";
import {
  ModuleGated,
  useDisabledReason,
  useModuleGate,
} from "@/components/caddy-modules/ModuleGate";
import { GeoBlockFields } from "@/components/proxy-hosts/protection/GeoBlockFields";
import { ErrorPagesFields } from "@/components/proxy-hosts/routing/ErrorPagesFields";
import OAuthProvidersSection from "./OAuthProvidersSection";
import LdapDirectoriesSection from "./LdapDirectoriesSection";
import type { LdapDirectoryView } from "@/src/lib/models/ldap-directories";
import SettingsFrame from "./SettingsFrame";
import type { StagedView } from "@/src/lib/settings/staged-view";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import { GeneratedPasswordField } from "@/src/components/ui/GeneratedPasswordField";
import type { OAuthProviderView } from "@/src/lib/auth/oidc/provider-view";
import type { AgentStatus } from "@cpm/shared";
import type { AgentResult } from "@/src/lib/agent/client";
import type { PairedAgent } from "@/src/lib/models/agents";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { TIMESTAMP_STYLES, UtcTooltip } from "@/components/ui/Timestamp";
import {
  updateDnsProviderSettingsAction,
  updateGeneralSettingsAction,
  updateAcmeSettingsAction,
  updateAuthentikSettingsAction,
  updateForwardAuthSettingsAction,
  updateMetricsSettingsAction,
  updateAnalyticsSettingsAction,
  updateGeoipSettingsAction,
  updateEmailSettingsAction,
  updateCertificateAlertSettingsAction,
  updateAvatarSettingsAction,
  updateFaviconAction,
  updateAccentColorAction,
  updateRegistrySettingsAction,
  updateUpdateSettingsAction,
  checkForUpdatesAction,
  updateGeoipDatabasesAction,
  updatePasswordPolicySettingsAction,
  updateLoggingSettingsAction,
  updateDnsSettingsAction,
  updateUpstreamDnsResolutionSettingsAction,
  updateGeoBlockSettingsAction,
  updateRateLimitSettingsAction,
  updateErrorPagesSettingsAction,
  updateTrustedProxiesSettingsAction,
  updateHttpProtocolsSettingsAction,
  updateCompressionSettingsAction,
  updateGlobalCaddyConfigAction,
  updateHttpCacheSettingsAction,
  updateTwoFactorPolicySettingsAction,
  updateCaddyBuildSettingsAction,
  updateDefaultResponseSettingsAction,
  updateDashboardSettingsAction,
  checkDashboardDnsAction,
  updateTailscaleSettingsAction,
  updateCrowdSecSettingsAction,
  updateCaptchaSettingsAction,
  pairingCodeAction,
  unpairAgentAction,
  repairAgentAction,
  enableAutoPairingAction,
} from "./actions";

import type { RepairAgentResult } from "./actions";
import { findSettingsItem, SETTINGS_ITEMS, settingsBlockName } from "./sections";
import { FocusField, OnThisPage, PageSaveBar, SettingsBlockShell } from "./PageBlocks";
import { EnvLabelledField } from "@/src/components/ui/EnvLabelledField";
import { RegistrySettingsBlock, type RegistryField } from "./RegistrySettingsBlock";
import { AccentColorPicker } from "./AccentColorPicker";
import { SequentialUserIdsBanner } from "./SequentialUserIdsBanner";
import { DashboardHostSection } from "./DashboardHostSection";
import { CaptchaSection } from "./CaptchaSection";
import { TwoFactorPolicySection } from "./TwoFactorPolicySection";
import { CrowdSecSection } from "./CrowdSecSection";
import { RateLimitSection } from "./RateLimitSection";
import type { GlobalRateLimitSettings } from "@/src/lib/proxy-hosts/rate-limit";
import { DnsDelegationSection } from "./DnsDelegationSection";
import { HttpCacheSection } from "./HttpCacheSection";
import { EmailServerSection, NotificationsSection } from "./EmailSection";
import type { EmailSettingsView } from "@/src/lib/email/view";
import type { HttpCacheSettingsView } from "@/src/lib/proxy-hosts/http-cache-options";
import type { CaptchaSettingsView } from "@/src/lib/captcha/settings";
import type { CrowdSecSettingsView } from "@/src/lib/caddy/crowdsec";
import type { ManagedServiceView } from "@/src/lib/agent/managed-services";

// ─── Props ───────────────────────────────────────────────────────────────────

type Props = {
  /** Section the route asked for. Switching after that is client state, not navigation. */
  initialSection: string;
  staged: StagedView;
  general: GeneralSettings | null;
  acme: AcmeSettings | null;
  dnsProvider: DnsProviderApiStatus | null;
  dnsProviderDefinitions: DnsProviderDefinition[];
  authentik: AuthentikSettings | null;
  forwardAuth: ForwardAuthSettings | null;
  metrics: MetricsSettings | null;
  logging: LoggingSettings | null;
  dns: DnsSettings | null;
  upstreamDnsResolution: UpstreamDnsResolutionSettings | null;
  trustedProxies: TrustedProxiesSettings | null;
  httpProtocols: HttpProtocolsSettings;
  compression: CompressionSettings;
  globalCaddyConfig: GlobalCaddyConfigSettings;
  httpCache: HttpCacheSettingsView;
  twoFactorPolicy: TwoFactorPolicySettings;
  defaultResponse: DefaultResponseSettings | null;
  globalGeoBlock?: GeoBlockSettings | null;
  globalRateLimit?: GlobalRateLimitSettings | null;
  globalErrorPages?: ErrorPagesSettings | null;
  oauthProviders: OAuthProviderView[];
  ldapDirectories: LdapDirectoryView[];
  /** The provider offered first on the sign-in screen, or null for alphabetical order. */
  primaryProviderId: string | null;
  localUsersDisabled: boolean;
  avatars: { gravatarEnabled: boolean; fromEnv: boolean };
  passwordPolicy: { requireChangeOnLegacyHash: boolean; fromEnv: boolean };
  /** The sign-in CAPTCHA, with the secret replaced by whether one is stored. */
  captcha: CaptchaSettingsView;
  /** The bouncer key replaced by whether one is stored. */
  crowdsec: CrowdSecSettingsView;
  /** The managed container as its agent reports it; null elsewhere, or with no such agent. */
  crowdsecManaged: ManagedServiceView | null;
  caddyBuild: CaddyBuildSettings | null;
  agentBuildTargets?: { id: number; name: string; connected: boolean }[];
  agentBuildSelections?: Record<number, CaddyBuildSettings | null>;
  /** How the dashboard is served through Caddy. Always a value: unset reads as off. */
  dashboard: DashboardHostSettings;
  /** The pickers and values for the dashboard host's proxy options. Null off that section. */
  dashboardOptions?: DashboardHostOptionsData | null;
  /** Tailscale node defaults, with the auth key replaced by whether one is stored. */
  tailscale: TailscaleSettingsView;
  /** The custom favicon as staged, as a data URL; null when there is none. */
  faviconSrc: string | null;
  updates: UpdateStatus;
  /** Registry settings this screen reports but cannot change, by the block that lists them. */
  registry: Record<string, readonly RegistryField[]>;
  /** Picked out on the server: the registry module is not browser-safe. */
  sequentialUserIdsField?: RegistryField;
  analytics: AnalyticsView;
  geoip: GeoipView;
  email: EmailSettingsView;
  /** Whether any agent is answering, and can therefore start or stop the optional containers. */
  canManageServices: boolean;
  baseUrl: string;
  /** Whether anyone has a passkey, which a new Public URL hostname would orphan. */
  passkeysRegistered?: boolean;
  agents: {
    /** Agents paired over the network. Empty on a single-host deployment, which uses the socket. */
    paired: PairedAgent[];
    /** What each agent reports, per agent, so one unreachable host is visible as itself. */
    statuses: AgentResult<AgentStatus>[];
    /** Unpairing the bundled agent switched its auto-pairing off. */
    autoPairingDisabled: boolean;
  };
};

/** A passkey's rpID is the bare hostname, not the origin. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function SettingsClient({
  initialSection,
  staged,
  general,
  acme,
  dnsProvider,
  dnsProviderDefinitions,
  authentik,
  forwardAuth,
  metrics,
  logging,
  dns,
  upstreamDnsResolution,
  trustedProxies,
  httpProtocols,
  compression,
  globalCaddyConfig,
  httpCache,
  twoFactorPolicy,
  defaultResponse,
  globalGeoBlock,
  globalRateLimit = null,
  globalErrorPages,
  oauthProviders,
  ldapDirectories,
  primaryProviderId,
  localUsersDisabled,
  avatars,
  passwordPolicy,
  captcha,
  crowdsec,
  crowdsecManaged,
  caddyBuild,
  agentBuildTargets,
  agentBuildSelections,
  dashboard,
  dashboardOptions,
  tailscale,
  faviconSrc,
  updates,
  registry,
  sequentialUserIdsField,
  analytics,
  geoip,
  email,
  canManageServices,
  baseUrl,
  passkeysRegistered = false,
  agents,
}: Props) {
  // Falls back rather than 404s, so a stale bookmark to a renamed section still lands somewhere.
  const active = findSettingsItem(initialSection) ? initialSection : "general";
  const t = useTranslations("settings");

  const [generalState, generalFormAction] = useActionState(updateGeneralSettingsAction, null);
  const [acmeState, acmeFormAction] = useActionState(updateAcmeSettingsAction, null);
  const [dashboardState, dashboardFormAction] = useActionState(updateDashboardSettingsAction, null);
  const [caddyBuildState, caddyBuildFormAction] = useActionState(
    updateCaddyBuildSettingsAction,
    null,
  );
  const [dnsProviderState, dnsProviderFormAction] = useActionState(
    updateDnsProviderSettingsAction,
    null,
  );
  const [selectedProvider, setSelectedProvider] = useState("none");
  const configuredProviders = dnsProvider?.providers ? Object.keys(dnsProvider.providers) : [];
  const [authentikState, authentikFormAction] = useActionState(updateAuthentikSettingsAction, null);
  const [forwardAuthState, forwardAuthFormAction] = useActionState(
    updateForwardAuthSettingsAction,
    null,
  );
  const [metricsState, metricsFormAction] = useActionState(updateMetricsSettingsAction, null);
  const [analyticsState, analyticsFormAction] = useActionState(updateAnalyticsSettingsAction, null);
  const [geoipState, geoipFormAction] = useActionState(updateGeoipSettingsAction, null);
  const [emailState, emailFormAction] = useActionState(updateEmailSettingsAction, null);
  const [certificateAlertsState, certificateAlertsFormAction] = useActionState(
    updateCertificateAlertSettingsAction,
    null,
  );
  const [avatarsState, avatarsFormAction] = useActionState(updateAvatarSettingsAction, null);
  const [faviconState, faviconFormAction] = useActionState(updateFaviconAction, null);
  const [accentState, accentFormAction] = useActionState(updateAccentColorAction, null);
  const [updatesState, updatesFormAction] = useActionState(updateUpdateSettingsAction, null);
  // One action for both, told apart by the block the form posts with its values.
  const [instanceState, instanceFormAction] = useActionState(updateRegistrySettingsAction, null);
  const [signInState, signInFormAction] = useActionState(updateRegistrySettingsAction, null);
  const [agentRegistryState, agentRegistryFormAction] = useActionState(
    updateRegistrySettingsAction,
    null,
  );
  const [forwardAuthRegistryState, forwardAuthRegistryFormAction] = useActionState(
    updateRegistrySettingsAction,
    null,
  );
  const [notificationsRegistryState, notificationsRegistryFormAction] = useActionState(
    updateRegistrySettingsAction,
    null,
  );
  const [passwordPolicyState, passwordPolicyFormAction] = useActionState(
    updatePasswordPolicySettingsAction,
    null,
  );
  const [captchaState, captchaFormAction] = useActionState(updateCaptchaSettingsAction, null);
  const [crowdsecState, crowdsecFormAction] = useActionState(updateCrowdSecSettingsAction, null);
  const [loggingState, loggingFormAction] = useActionState(updateLoggingSettingsAction, null);
  const [dnsState, dnsFormAction] = useActionState(updateDnsSettingsAction, null);
  const [upstreamDnsResolutionState, upstreamDnsResolutionFormAction] = useActionState(
    updateUpstreamDnsResolutionSettingsAction,
    null,
  );
  const [geoBlockState, geoBlockFormAction] = useActionState(updateGeoBlockSettingsAction, null);
  const [rateLimitState, rateLimitFormAction] = useActionState(updateRateLimitSettingsAction, null);
  const [errorPagesState, errorPagesFormAction] = useActionState(
    updateErrorPagesSettingsAction,
    null,
  );
  const [trustedProxiesState, trustedProxiesFormAction] = useActionState(
    updateTrustedProxiesSettingsAction,
    null,
  );
  const [globalCaddyConfigState, globalCaddyConfigFormAction] = useActionState(
    updateGlobalCaddyConfigAction,
    null,
  );
  const [httpCacheState, httpCacheFormAction] = useActionState(updateHttpCacheSettingsAction, null);
  const [httpProtocolsState, httpProtocolsFormAction] = useActionState(
    updateHttpProtocolsSettingsAction,
    null,
  );
  const [compressionState, compressionFormAction] = useActionState(
    updateCompressionSettingsAction,
    null,
  );
  const [twoFactorPolicyState, twoFactorPolicyFormAction] = useActionState(
    updateTwoFactorPolicySettingsAction,
    null,
  );
  const [defaultResponseState, defaultResponseFormAction] = useActionState(
    updateDefaultResponseSettingsAction,
    null,
  );
  const [tailscaleState, tailscaleFormAction] = useActionState(updateTailscaleSettingsAction, null);

  // A map rather than a switch, so a block cannot be in the registry and nowhere on screen.
  const blocks: Record<string, ReactNode> = {
    general: (
      <GeneralSection
        general={general}
        generalState={generalState}
        generalFormAction={generalFormAction}
      />
    ),
    acme: <AcmeSection acme={acme} acmeState={acmeState} acmeFormAction={acmeFormAction} />,
    updates: (
      <UpdatesSection
        updates={updates}
        updatesState={updatesState}
        updatesFormAction={updatesFormAction}
      />
    ),
    branding: (
      <BrandingSection
        accentField={registry.branding?.[0]}
        accentState={accentState}
        accentFormAction={accentFormAction}
        faviconSrc={faviconSrc}
        faviconState={faviconState}
        faviconFormAction={faviconFormAction}
      />
    ),
    avatars: (
      <AvatarsSection
        avatars={avatars}
        avatarsState={avatarsState}
        avatarsFormAction={avatarsFormAction}
      />
    ),
    "default-response": (
      <DefaultResponseSection
        defaultResponse={defaultResponse}
        defaultResponseState={defaultResponseState}
        defaultResponseFormAction={defaultResponseFormAction}
      />
    ),
    "error-pages": (
      <ErrorPagesSection
        globalErrorPages={globalErrorPages}
        errorPagesState={errorPagesState}
        errorPagesFormAction={errorPagesFormAction}
      />
    ),
    "global-caddy-config": (
      <GlobalCaddyConfigSection
        globalCaddyConfig={globalCaddyConfig}
        state={globalCaddyConfigState}
        formAction={globalCaddyConfigFormAction}
      />
    ),
    "http-cache": (
      <HttpCacheSection
        httpCache={httpCache}
        state={httpCacheState}
        formAction={httpCacheFormAction}
      />
    ),
    "caddy-build": (
      <CaddyBuildSection
        caddyBuild={caddyBuild}
        caddyBuildState={caddyBuildState}
        caddyBuildFormAction={caddyBuildFormAction}
        agents={agentBuildTargets}
        agentBuildSelections={agentBuildSelections}
      />
    ),
    dashboard: (
      <DashboardHostSection
        dashboard={dashboard}
        options={dashboardOptions ?? null}
        dashboardState={dashboardState}
        dashboardFormAction={dashboardFormAction}
        checkDns={checkDashboardDnsAction}
      />
    ),
    agent: (
      <>
        <AgentSection agents={agents} pairingHost={pairingHostFor(dashboard)} />
        <RegistrySettingsBlock
          block="agent"
          fields={registry.agent ?? []}
          state={agentRegistryState}
          formAction={agentRegistryFormAction}
        />
      </>
    ),
    instance: (
      <VStack gap={4}>
        {passkeysRegistered && (
          <WarnAlert title={t("passkeyHostnameWarningTitle")}>
            {t("passkeyHostnameWarningDescription", { host: hostnameOf(baseUrl) })}
          </WarnAlert>
        )}
        <RegistrySettingsBlock
          block="instance"
          fields={registry.instance ?? []}
          state={instanceState}
          formAction={instanceFormAction}
        />
      </VStack>
    ),
    "sign-in": (
      <RegistrySettingsBlock
        block="sign-in"
        fields={registry["sign-in"] ?? []}
        state={signInState}
        formAction={signInFormAction}
      />
    ),
    "dns-providers": (
      <DnsProvidersSection
        dnsProvider={dnsProvider}
        dnsProviderDefinitions={dnsProviderDefinitions}
        dnsProviderState={dnsProviderState}
        dnsProviderFormAction={dnsProviderFormAction}
        selectedProvider={selectedProvider}
        setSelectedProvider={setSelectedProvider}
        configuredProviders={configuredProviders}
      />
    ),
    "dns-resolvers": (
      <DnsResolversSection dns={dns} dnsState={dnsState} dnsFormAction={dnsFormAction} />
    ),
    "upstream-dns": (
      <UpstreamDnsSection
        upstreamDnsResolution={upstreamDnsResolution}
        upstreamDnsResolutionState={upstreamDnsResolutionState}
        upstreamDnsResolutionFormAction={upstreamDnsResolutionFormAction}
      />
    ),
    "trusted-proxies": (
      <TrustedProxiesSection
        trustedProxies={trustedProxies}
        trustedProxiesState={trustedProxiesState}
        trustedProxiesFormAction={trustedProxiesFormAction}
      />
    ),
    "http-protocols": (
      <HttpProtocolsSection
        httpProtocols={httpProtocols}
        state={httpProtocolsState}
        formAction={httpProtocolsFormAction}
      />
    ),
    compression: (
      <CompressionSection
        compression={compression}
        state={compressionState}
        formAction={compressionFormAction}
      />
    ),
    tailscale: (
      <TailscaleSection
        tailscale={tailscale}
        tailscaleState={tailscaleState}
        tailscaleFormAction={tailscaleFormAction}
      />
    ),
    oauth: (
      <OAuthSection
        oauthProviders={oauthProviders}
        primaryProviderId={primaryProviderId}
        localUsersDisabled={localUsersDisabled}
        baseUrl={baseUrl}
      />
    ),
    ldap: (
      <FormCard>
        <LdapDirectoriesSection initialDirectories={ldapDirectories} />
      </FormCard>
    ),
    captcha: (
      <CaptchaSection
        captcha={captcha}
        localUsersDisabled={localUsersDisabled}
        captchaState={captchaState}
        captchaFormAction={captchaFormAction}
      />
    ),
    crowdsec: (
      <CrowdSecSection
        crowdsec={crowdsec}
        managed={crowdsecManaged}
        state={crowdsecState}
        formAction={crowdsecFormAction}
      />
    ),
    "two-factor": (
      <TwoFactorPolicySection
        policy={twoFactorPolicy}
        state={twoFactorPolicyState}
        formAction={twoFactorPolicyFormAction}
      />
    ),
    "password-policy": (
      <PasswordPolicySection
        passwordPolicy={passwordPolicy}
        passwordPolicyState={passwordPolicyState}
        passwordPolicyFormAction={passwordPolicyFormAction}
      />
    ),
    authentik: (
      <AuthentikSection
        authentik={authentik}
        authentikState={authentikState}
        authentikFormAction={authentikFormAction}
      />
    ),
    "forward-auth": (
      <>
        <SequentialUserIdsBanner field={sequentialUserIdsField} />
        <ForwardAuthSection
          forwardAuth={forwardAuth}
          forwardAuthState={forwardAuthState}
          forwardAuthFormAction={forwardAuthFormAction}
        />
        <RegistrySettingsBlock
          block="forward-auth"
          fields={registry["forward-auth"] ?? []}
          state={forwardAuthRegistryState}
          formAction={forwardAuthRegistryFormAction}
        />
      </>
    ),
    geoip: <GeoipSection geoip={geoip} geoipState={geoipState} geoipFormAction={geoipFormAction} />,
    email: <EmailServerSection email={email} state={emailState} formAction={emailFormAction} />,
    "certificate-alerts": (
      <VStack gap={4}>
        <NotificationsSection
          email={email}
          state={certificateAlertsState}
          formAction={certificateAlertsFormAction}
        />
        <Heading level={3}>{t("email.notificationsTitle")}</Heading>
        <Text size="sm" color="secondary">
          {t("email.notificationsPerUser")}
        </Text>
        <RegistrySettingsBlock
          block="notifications"
          fields={registry.notifications ?? []}
          unavailable={Object.fromEntries(
            Object.entries(email.notifications.unavailable).map(([key, reason]) => [
              key,
              t(`email.unavailable.${reason}`),
            ]),
          )}
          state={notificationsRegistryState}
          formAction={notificationsRegistryFormAction}
        />
      </VStack>
    ),
    geoblock: (
      <GeoBlockSection
        globalGeoBlock={globalGeoBlock}
        geoBlockState={geoBlockState}
        geoBlockFormAction={geoBlockFormAction}
      />
    ),
    "rate-limit": (
      <RateLimitSection
        rateLimit={globalRateLimit}
        state={rateLimitState}
        formAction={rateLimitFormAction}
      />
    ),
    analytics: (
      <AnalyticsSection
        analytics={analytics}
        canManageServices={canManageServices}
        analyticsState={analyticsState}
        analyticsFormAction={analyticsFormAction}
      />
    ),
    metrics: (
      <MetricsSection
        metrics={metrics}
        metricsState={metricsState}
        metricsFormAction={metricsFormAction}
      />
    ),
    logging: (
      <LoggingSection
        logging={logging}
        loggingState={loggingState}
        loggingFormAction={loggingFormAction}
      />
    ),
  };

  const page = findSettingsItem(active) ?? SETTINGS_ITEMS[0];
  // Saved but not applied, so marked the same as a field typed into just now.
  const stagedFields = staged.changes.flatMap((change) => change.fields);
  return (
    <SettingsFrame sectionId={active} staged={staged} aside>
      <FocusField />
      <HStack gap={5} align="start">
        <VStack gap={5} maxWidth={768} className="min-w-0 grow">
          <PageSaveBar stagedFields={stagedFields}>
            <VStack gap={5}>
              {page.blocks.map((block) => (
                <SettingsBlockShell
                  key={block.id}
                  block={block}
                  showHeading={page.blocks.length > 1}
                >
                  {blocks[block.id]}
                </SettingsBlockShell>
              ))}
            </VStack>
          </PageSaveBar>
        </VStack>
        <OnThisPage
          anchors={page.blocks.map((block) => ({
            id: block.id,
            label: settingsBlockName(t, block.id),
          }))}
        />
      </HStack>
    </SettingsFrame>
  );
}

// ─── Section: General ────────────────────────────────────────────────────────

function GeneralSection({
  general,
  generalState,
  generalFormAction,
}: {
  general: GeneralSettings | null;
  generalState: { success: boolean; message?: string } | null;
  generalFormAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const [defaultDomain, setDefaultDomain] = useState(
    general?.defaultDomain ?? "caddyproxymanager.com",
  );
  const [acmeEmail, setAcmeEmail] = useState(general?.acmeEmail ?? "");

  return (
    <FormCard title={t("defaults")}>
      <form action={generalFormAction}>
        <VStack gap={3}>
          {generalState?.message && (
            <StatusAlert message={generalState.message} success={generalState.success} />
          )}
          <TextInput
            startIcon={Globe}
            {...NATIVE_REQUIRED}
            label={t("defaultDomain")}
            description={t("defaultDomainHelp")}
            htmlName="defaultDomain"
            value={defaultDomain}
            onChange={setDefaultDomain}
            isRequired
          />
          <EmailInput
            domain="public"
            label={t("acmeContactEmail")}
            description={t("acmeEmailHelp")}
            htmlName="acmeEmail"
            value={acmeEmail}
            onChange={setAcmeEmail}
          />
        </VStack>
      </form>
    </FormCard>
  );
}

// ─── Section: Default Response ──────────────────────────────────────────────

const DEFAULT_RESPONSE_MODES = [
  { value: "caddy", labelKey: "defaultResponseModeCaddy" },
  { value: "respond", labelKey: "defaultResponseModeRespond" },
  { value: "redirect", labelKey: "defaultResponseModeRedirect" },
  { value: "abort", labelKey: "defaultResponseModeAbort" },
] as const;

const REDIRECT_STATUS_OPTIONS = [
  { value: "301", labelKey: "redirectStatus301" },
  { value: "302", labelKey: "redirectStatus302" },
  { value: "303", labelKey: "redirectStatus303" },
  { value: "307", labelKey: "redirectStatus307" },
  { value: "308", labelKey: "redirectStatus308" },
] as const;

function DefaultResponseSection({
  defaultResponse,
  defaultResponseState,
  defaultResponseFormAction,
}: {
  defaultResponse: DefaultResponseSettings | null;
  defaultResponseState: { success: boolean; message?: string } | null;
  defaultResponseFormAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const [mode, setMode] = useState<DefaultResponseSettings["mode"]>(
    defaultResponse?.mode ?? "caddy",
  );
  const [status, setStatus] = useState<number | null>(
    defaultResponse?.mode === "respond" ? (defaultResponse.status ?? 404) : 404,
  );
  const [redirectStatus, setRedirectStatus] = useState(
    String(defaultResponse?.mode === "redirect" ? (defaultResponse.status ?? 302) : 302),
  );
  const [body, setBody] = useState(
    defaultResponse?.mode === "respond" ? (defaultResponse.body ?? "") : "",
  );
  const [redirectUrl, setRedirectUrl] = useState(
    defaultResponse?.mode === "redirect" ? (defaultResponse.redirectUrl ?? "") : "",
  );
  const storedHeaders = Object.entries(defaultResponse?.headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
  // Switching modes starts from that mode's default rather than the other mode's headers.
  const [headers, setHeaders] = useState(
    defaultResponse?.mode === "respond" || defaultResponse?.mode === "redirect"
      ? storedHeaders
      : "Content-Type: text/plain; charset=utf-8",
  );

  return (
    <VStack gap={4}>
      <FormCard title={t("unknownHostHandling")}>
        <form action={defaultResponseFormAction}>
          <VStack gap={3}>
            {defaultResponseState?.message && (
              <StatusAlert
                message={defaultResponseState.message}
                success={defaultResponseState.success}
              />
            )}
            <Selector
              label={t("behavior")}
              description={t("defaultResponseBehaviorHelp")}
              htmlName="mode"
              options={DEFAULT_RESPONSE_MODES.map(({ value, labelKey }) => ({
                value,
                label: t(labelKey),
              }))}
              value={mode}
              onChange={(v) => setMode(v as DefaultResponseSettings["mode"])}
            />

            {mode === "respond" && (
              <>
                <NumberInput
                  hasNumberSteppers
                  label={t("statusCode")}
                  description={t("defaultResponseStatusHelp")}
                  htmlName="status"
                  min={200}
                  max={599}
                  isIntegerOnly
                  value={status}
                  onChange={setStatus}
                />
                <TextArea
                  label={t("responseBody")}
                  isOptional
                  description={t("defaultResponseBodyHelp")}
                  htmlName="body"
                  value={body}
                  onChange={setBody}
                  rows={8}
                  placeholder={t("notFound")}
                />
              </>
            )}

            {mode === "redirect" && (
              <>
                <Selector
                  label={t("redirectStatus")}
                  description={t("defaultRedirectStatusHelp")}
                  htmlName="status"
                  options={REDIRECT_STATUS_OPTIONS.map(({ value, labelKey }) => ({
                    value,
                    label: t(labelKey),
                  }))}
                  value={redirectStatus}
                  onChange={setRedirectStatus}
                />
                <TextInput
                  startIcon={LinkIcon}
                  label={t("redirectUrl")}
                  isRequired
                  description={t("defaultRedirectUrlHelp")}
                  htmlName="redirectUrl"
                  value={redirectUrl}
                  onChange={setRedirectUrl}
                  placeholder="https://example.com{http.request.uri}"
                />
              </>
            )}

            {(mode === "respond" || mode === "redirect") && (
              <TextArea
                label={t("responseHeaders")}
                isOptional
                description={t("defaultResponseHeadersHelp")}
                htmlName="headers"
                value={headers}
                onChange={setHeaders}
                rows={4}
                placeholder={"Content-Type: text/html; charset=utf-8\nCache-Control: no-store"}
              />
            )}

            {mode === "abort" && (
              <WarnAlert title={t("abortResponseTitle")}>{t("abortResponseDescription")}</WarnAlert>
            )}
          </VStack>
        </form>
      </FormCard>
      <InfoAlert title={t("defaultResponsePriorityTitle")}>
        {t("defaultResponseTlsDescription")}
      </InfoAlert>
    </VStack>
  );
}

// ─── Section: ACME Server ────────────────────────────────────────────────────

function AcmeSection({
  acme,
  acmeState,
  acmeFormAction,
}: {
  acme: AcmeSettings | null;
  acmeState: { success: boolean; message?: string } | null;
  acmeFormAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const [caUrl, setCaUrl] = useState(acme?.caUrl ?? "");
  const [caRootPem, setCaRootPem] = useState(acme?.caRootPem ?? "");

  return (
    <FormCard title={t("customAcmeDirectory")}>
      <form action={acmeFormAction}>
        <VStack gap={3}>
          {acmeState?.message && (
            <StatusAlert message={acmeState.message} success={acmeState.success} />
          )}
          <TextInput
            startIcon={LinkIcon}
            label={t("acmeDirectoryUrl")}
            isOptional
            description={t("acmeDirectoryHelp")}
            htmlName="caUrl"
            value={caUrl}
            onChange={setCaUrl}
            placeholder="https://ca.internal.example.com/acme/acme/directory"
          />
          <EnvLabelledField label={t("caRootCertificatePem")} env={["ACME_CA_ROOT_DIR"]}>
            <TextArea
              label={t("caRootCertificatePem")}
              isOptional
              description={t("acmeRootCertificateHelp")}
              htmlName="caRootPem"
              value={caRootPem}
              onChange={setCaRootPem}
              placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
              rows={6}
            />
          </EnvLabelledField>
        </VStack>
      </form>
    </FormCard>
  );
}

// ─── Section: DNS Providers ──────────────────────────────────────────────────

function DnsProviderCredentialFields({ providerDef }: { providerDef: DnsProviderDefinition }) {
  const t = useTranslations("settings");
  // Keyed on the provider so switching resets credentials instead of carrying them across.
  const [values, setValues] = useState<Record<string, string>>({});
  const description = dnsProviderDescription(t, providerDef);

  return (
    <>
      {description && (
        <Text type="body" size="xsm" color="secondary">
          {description}
        </Text>
      )}
      {providerDef.fields.map((field) => {
        const text = dnsProviderFieldText(t, providerDef, field);
        return (
          <TextInput
            key={field.key}
            {...(field.type === "password" ? AUTOFILL_NEW_PASSWORD : AUTOFILL_OFF)}
            label={text.label}
            isOptional={!field.required}
            isRequired={field.required}
            description={text.description}
            type={field.type === "password" ? "password" : "text"}
            htmlName={`credential_${field.key}`}
            value={values[field.key] ?? ""}
            onChange={(v) => setValues((prev) => ({ ...prev, [field.key]: v }))}
            placeholder={text.placeholder ?? ""}
          />
        );
      })}
    </>
  );
}

function DnsProvidersSection({
  dnsProvider,
  dnsProviderDefinitions,
  dnsProviderState,
  dnsProviderFormAction,
  selectedProvider,
  setSelectedProvider,
  configuredProviders,
}: {
  dnsProvider: DnsProviderApiStatus | null;
  dnsProviderDefinitions: DnsProviderDefinition[];
  dnsProviderState: { success: boolean; message?: string } | null;
  dnsProviderFormAction: (payload: FormData) => void;
  selectedProvider: string;
  setSelectedProvider: (v: string) => void;
  configuredProviders: string[];
}) {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const { enabledModuleIds } = useModuleGate();
  // Each provider is its own caddy-dns module; one switched off would make Caddy reject the config,
  // so it is refused here rather than at issuance time.
  const isProviderAvailable = (name: string) =>
    enabledModuleIds === null || enabledModuleIds.includes(dnsModuleId(name));

  const providerDef = dnsProviderDefinitions.find((p) => p.name === selectedProvider);
  const isUpdate = configuredProviders.includes(selectedProvider);
  const hasProvider = Boolean(selectedProvider) && selectedProvider !== "none";
  const selectedUnavailable = hasProvider && !isProviderAvailable(selectedProvider);

  const unavailableCount = dnsProviderDefinitions.filter(
    (p) => !isProviderAvailable(p.name),
  ).length;

  const providerOptions = [
    { value: "none", label: t("dnsProviderSelectPlaceholder") },
    ...dnsProviderDefinitions.map((p) => ({
      value: p.name,
      // A brand name, so it stays as the registry spells it.
      label: configuredProviders.includes(p.name)
        ? t("dnsProviderOptionUpdate", { name: p.displayName })
        : p.displayName,
      // Listed rather than filtered, so an admin looking for it learns why it is unavailable.
      disabled: !isProviderAvailable(p.name),
      description: isProviderAvailable(p.name) ? undefined : t("dnsProviderModuleDisabledOption"),
    })),
  ];

  return (
    <>
      {dnsProviderState?.message && (
        <StatusAlert message={dnsProviderState.message} success={dnsProviderState.success} />
      )}

      {configuredProviders.length > 0 && (
        <FormCard title={t("configuredProviders")}>
          <VStack gap={2}>
            {configuredProviders.map((name) => {
              const def = dnsProviderDefinitions.find((p) => p.name === name);
              const isDefault = dnsProvider?.default === name;
              return (
                <Card key={name} variant="muted" padding={3}>
                  <HStack justify="between" gap={3} vAlign="center" wrap="wrap">
                    <HStack gap={2} vAlign="center">
                      <Text type="body" size="sm" weight="semibold">
                        {def?.displayName ?? name}
                      </Text>
                      {isDefault && <Badge variant="info" label={t("default")} />}
                    </HStack>
                    <HStack gap={2}>
                      {!isDefault && (
                        <form action={dnsProviderFormAction}>
                          <input type="hidden" name="action" value="set-default" />
                          <input type="hidden" name="provider" value={name} />
                          <Button
                            type="submit"
                            variant="secondary"
                            size="sm"
                            label={t("setDefault")}
                          />
                        </form>
                      )}
                      <form action={dnsProviderFormAction}>
                        <input type="hidden" name="action" value="remove" />
                        <input type="hidden" name="provider" value={name} />
                        <Button
                          type="submit"
                          variant="destructive"
                          size="sm"
                          label={tCommon("remove")}
                        />
                      </form>
                    </HStack>
                  </HStack>
                </Card>
              );
            })}
            {dnsProvider?.default && (
              <form action={dnsProviderFormAction}>
                <input type="hidden" name="action" value="set-default" />
                <input type="hidden" name="provider" value="none" />
                <Button type="submit" variant="ghost" size="sm" label={t("clearDefaultHttp01")} />
              </form>
            )}
          </VStack>
        </FormCard>
      )}

      <FormCard
        title={
          configuredProviders.length > 0
            ? t("addOrUpdateDnsProviderTitle")
            : t("addDnsProviderTitle")
        }
        footer={
          <Button
            type="submit"
            form="dnsp-add-form"
            variant="primary"
            size="sm"
            label={hasProvider && isUpdate ? t("updateOauthProvider") : t("addProvider")}
            isDisabled={!hasProvider}
          />
        }
      >
        <form id="dnsp-add-form" action={dnsProviderFormAction}>
          <VStack gap={3}>
            <input type="hidden" name="action" value="save" />
            <Selector
              label={tCommon("provider")}
              description={
                unavailableCount > 0
                  ? t("dnsProvidersSupportedWithUnavailable", {
                      count: dnsProviderDefinitions.length,
                      unavailable: unavailableCount,
                    })
                  : t("dnsProvidersSupported", { count: dnsProviderDefinitions.length })
              }
              htmlName="provider"
              options={providerOptions}
              value={selectedProvider}
              onChange={setSelectedProvider}
              placeholder={t("dnsProviderPlaceholder")}
              hasSearch
            />

            {selectedUnavailable && (
              <WarnAlert title={t("dnsProviderModuleDisabledTitle")}>
                {t("dnsProviderModuleDisabledDescription")}
              </WarnAlert>
            )}

            {hasProvider && providerDef && (
              <>
                <DnsProviderCredentialFields key={providerDef.name} providerDef={providerDef} />
                {isUpdate && (
                  <InfoAlert title={t("credentialsAreAlreadyConfigured")}>
                    {t("storedCredentialsHelp")}
                  </InfoAlert>
                )}
                {providerDef.docsUrl && (
                  <Link href={providerDef.docsUrl} target="_blank">
                    {t("providerDocumentation")}
                  </Link>
                )}
              </>
            )}
          </VStack>
        </form>
      </FormCard>

      <DnsDelegationSection
        dnsProvider={dnsProvider}
        dnsProviderDefinitions={dnsProviderDefinitions}
        configuredProviders={configuredProviders}
        formAction={dnsProviderFormAction}
        isProviderAvailable={isProviderAvailable}
      />
    </>
  );
}

// ─── Section: DNS Resolvers ──────────────────────────────────────────────────

function DnsResolversSection({
  dns,
  dnsState,
  dnsFormAction,
}: {
  dns: DnsSettings | null;
  dnsState: { success: boolean; message?: string } | null;
  dnsFormAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const [enabled, setEnabled] = useState(dns?.enabled ?? false);
  const [resolvers, setResolvers] = useState(dns?.resolvers?.join("\n") ?? "");
  const [fallbacks, setFallbacks] = useState(dns?.fallbacks?.join("\n") ?? "");
  const [timeout, setTimeoutValue] = useState(dns?.timeout ?? "");

  return (
    <>
      <FormCard>
        <form action={dnsFormAction}>
          <VStack gap={3}>
            {dnsState?.message && (
              <StatusAlert message={dnsState.message} success={dnsState.success} />
            )}
            <Switch
              label={t("enableCustomDnsResolvers")}
              htmlName="enabled"
              value={enabled}
              onChange={setEnabled}
            />
            <TextArea
              label={t("primaryResolvers")}
              isOptional
              htmlName="resolvers"
              value={resolvers}
              onChange={setResolvers}
              placeholder={"1.1.1.1\n9.9.9.9"}
              rows={2}
            />
            <TextArea
              label={t("fallbackResolvers")}
              isOptional
              htmlName="fallbacks"
              value={fallbacks}
              onChange={setFallbacks}
              placeholder={"1.0.0.1\n149.112.112.112"}
              rows={2}
            />
            <TextInput
              startIcon={Clock}
              label={t("queryTimeout")}
              isOptional
              description={t("dnsQueryTimeoutHelp")}
              htmlName="timeout"
              value={timeout}
              onChange={setTimeoutValue}
              placeholder="5s"
              width={160}
            />
          </VStack>
        </form>
      </FormCard>
      <InfoAlert title={t("dnsResolversInfoTitle")}>{t("dnsResolversInfoDescription")}</InfoAlert>
    </>
  );
}

// ─── Section: Upstream DNS Pinning ───────────────────────────────────────────

const FAMILY_OPTIONS = [
  { value: "both", labelKey: "optDnsFamilyBoth" },
  { value: "ipv6", labelKey: "optDnsFamilyIpv6" },
  { value: "ipv4", labelKey: "optDnsFamilyIpv4" },
] as const;

function UpstreamDnsSection({
  upstreamDnsResolution,
  upstreamDnsResolutionState,
  upstreamDnsResolutionFormAction,
}: {
  upstreamDnsResolution: UpstreamDnsResolutionSettings | null;
  upstreamDnsResolutionState: { success: boolean; message?: string } | null;
  upstreamDnsResolutionFormAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const tProxyHosts = useTranslations("proxyHosts");
  const [enabled, setEnabled] = useState(upstreamDnsResolution?.enabled ?? false);
  const [family, setFamily] = useState<string>(upstreamDnsResolution?.family ?? "both");

  return (
    <>
      <FormCard>
        <form action={upstreamDnsResolutionFormAction}>
          <VStack gap={3}>
            {upstreamDnsResolutionState?.message && (
              <StatusAlert
                message={upstreamDnsResolutionState.message}
                success={upstreamDnsResolutionState.success}
              />
            )}
            <Switch
              label={t("enableUpstreamDnsPinning")}
              description={t("dnsPinningHelp")}
              htmlName="enabled"
              value={enabled}
              onChange={setEnabled}
            />
            <Selector
              label={t("addressFamily")}
              description={t("dnsAddressFamilyHelp")}
              htmlName="family"
              options={FAMILY_OPTIONS.map(({ value, labelKey }) => ({
                value,
                label: tProxyHosts(labelKey),
              }))}
              value={family}
              onChange={setFamily}
              width={280}
            />
          </VStack>
        </form>
      </FormCard>
      <InfoAlert title={t("authentikDefaultsHelp")}>{t("dnsPinningInfoDescription")}</InfoAlert>
    </>
  );
}

// ─── Section: Trusted Proxies ────────────────────────────────────────────────

function TrustedProxiesSection({
  trustedProxies,
  trustedProxiesState,
  trustedProxiesFormAction,
}: {
  trustedProxies: TrustedProxiesSettings | null;
  trustedProxiesState: { success: boolean; message?: string } | null;
  trustedProxiesFormAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const [ranges, setRanges] = useState((trustedProxies?.ranges ?? []).join("\n"));
  const [clientIpHeaders, setClientIpHeaders] = useState(
    (trustedProxies?.client_ip_headers ?? []).join("\n"),
  );
  const [strict, setStrict] = useState(trustedProxies?.strict ?? false);
  const [defaultGeoblock, setDefaultGeoblock] = useState(trustedProxies?.default_geoblock ?? false);

  return (
    <>
      <FormCard>
        <form action={trustedProxiesFormAction}>
          <VStack gap={3}>
            {trustedProxiesState?.message && (
              <StatusAlert
                message={trustedProxiesState.message}
                success={trustedProxiesState.success}
              />
            )}
            <TextArea
              label={t("trustedProxyRanges")}
              isOptional
              description={t("trustedProxyRangesHelp")}
              htmlName="ranges"
              value={ranges}
              onChange={setRanges}
              rows={3}
              placeholder={"private_ranges\n172.21.0.1/32"}
            />
            <TextArea
              label={t("clientIpHeaders")}
              isOptional
              description={t("clientIpHeadersHelp")}
              htmlName="clientIpHeaders"
              value={clientIpHeaders}
              onChange={setClientIpHeaders}
              rows={2}
              placeholder={t("clientIpHeadersPlaceholder")}
            />
            <Switch
              label={t("enableStrictTrustedProxies")}
              description={t("strictTrustedProxiesHelp")}
              htmlName="strict"
              value={strict}
              onChange={setStrict}
            />
            <Switch
              label={t("defaultGeoblockTrustedProxies")}
              description={t("geoblockTrustedProxiesHelp")}
              htmlName="defaultGeoblock"
              value={defaultGeoblock}
              onChange={setDefaultGeoblock}
            />
          </VStack>
        </form>
      </FormCard>
      <InfoAlert title={t("trustedProxiesScopeDescription")}>
        {t("trustedProxiesInfoDescription")}
      </InfoAlert>
    </>
  );
}

function GlobalCaddyConfigSection({
  globalCaddyConfig,
  state,
  formAction,
}: {
  globalCaddyConfig: GlobalCaddyConfigSettings;
  state: { success: boolean; message?: string } | null;
  formAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const [caddyfile, setCaddyfile] = useState(globalCaddyConfig.caddyfile);

  return (
    <FormCard>
      <form action={formAction}>
        <VStack gap={3}>
          {state?.message && <StatusAlert message={state.message} success={state.success} />}
          <CodeEditor
            label={t("globalCaddyfile")}
            htmlName="caddyfile"
            language="caddyfile"
            value={caddyfile}
            onChange={setCaddyfile}
            height="md"
            description={t("globalCaddyfileHelp")}
          />
        </VStack>
      </form>
    </FormCard>
  );
}

function HttpProtocolsSection({
  httpProtocols,
  state,
  formAction,
}: {
  httpProtocols: HttpProtocolsSettings;
  state: { success: boolean; message?: string } | null;
  formAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const [http2, setHttp2] = useState(httpProtocols.http2);
  const [http3, setHttp3] = useState(httpProtocols.http3);

  return (
    <FormCard>
      <form action={formAction}>
        <VStack gap={3}>
          {state?.message && <StatusAlert message={state.message} success={state.success} />}
          <Switch
            label={t("http2")}
            description={t("http2Help")}
            htmlName="http2"
            value={http2}
            onChange={setHttp2}
          />
          <Switch
            label={t("http3")}
            description={t("http3Help")}
            htmlName="http3"
            value={http3}
            onChange={setHttp3}
          />
        </VStack>
      </form>
    </FormCard>
  );
}

function CompressionSection({
  compression,
  state,
  formAction,
}: {
  compression: CompressionSettings;
  state: { success: boolean; message?: string } | null;
  formAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const [enabled, setEnabled] = useState(compression.enabled);

  return (
    <FormCard>
      <form action={formAction}>
        <VStack gap={3}>
          {state?.message && <StatusAlert message={state.message} success={state.success} />}
          <Switch
            label={t("compressionEnabled")}
            description={t("compressionEnabledHelp")}
            htmlName="enabled"
            value={enabled}
            onChange={setEnabled}
          />
        </VStack>
      </form>
    </FormCard>
  );
}

// ─── Section: Global Geoblocking ─────────────────────────────────────────────

function GeoBlockSection({
  globalGeoBlock,
  geoBlockState,
  geoBlockFormAction,
}: {
  globalGeoBlock?: GeoBlockSettings | null;
  geoBlockState: { success: boolean; message?: string } | null;
  geoBlockFormAction: (payload: FormData) => void;
}) {
  return (
    <FormCard>
      <form action={geoBlockFormAction}>
        <VStack gap={3}>
          {geoBlockState?.message && (
            <StatusAlert message={geoBlockState.message} success={geoBlockState.success} />
          )}
          <GeoBlockFields
            initialValues={{ geoblock: globalGeoBlock ?? null, geoblock_mode: "merge" }}
            showModeSelector={false}
          />
        </VStack>
      </form>
    </FormCard>
  );
}

// ─── Section: Error Pages ────────────────────────────────────────────────────

function ErrorPagesSection({
  globalErrorPages,
  errorPagesState,
  errorPagesFormAction,
}: {
  globalErrorPages?: ErrorPagesSettings | null;
  errorPagesState: { success: boolean; message?: string } | null;
  errorPagesFormAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  return (
    <FormCard>
      <form action={errorPagesFormAction}>
        <VStack gap={3}>
          {errorPagesState?.message && (
            <StatusAlert message={errorPagesState.message} success={errorPagesState.success} />
          )}
          <Text type="body" size="sm" color="secondary">
            {t("globalErrorPagesHelp")}
          </Text>
          <ErrorPagesFields initialData={globalErrorPages?.rules ?? []} />
        </VStack>
      </form>
    </FormCard>
  );
}

// ─── Section: Tailscale ──────────────────────────────────────────────────────

function TailscaleSection({
  tailscale,
  tailscaleState,
  tailscaleFormAction,
}: {
  tailscale: TailscaleSettingsView;
  tailscaleState: { success: boolean; message?: string } | null;
  tailscaleFormAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const [enabled, setEnabled] = useState(tailscale.enabled);
  const [authKey, setAuthKey] = useState("");
  const [defaultNode, setDefaultNode] = useState(tailscale.defaultNode);
  const [controlUrl, setControlUrl] = useState(tailscale.controlUrl);
  const [stateDir, setStateDir] = useState(tailscale.stateDir);
  const [tags, setTags] = useState(tailscale.tags.join(", "));
  const [ephemeral, setEphemeral] = useState(tailscale.ephemeral);
  const [http3, setHttp3] = useState(tailscale.http3);
  const [validateAuthKey, setValidateAuthKey] = useState(tailscale.validateAuthKey);
  const [apiAccessToken, setApiAccessToken] = useState("");
  const [apiTailnet, setApiTailnet] = useState(tailscale.apiTailnet);
  const moduleDisabledReason = useDisabledReason("tailscale");

  return (
    <FormCard title={t("tailscaleNodeDefaults")}>
      <form action={tailscaleFormAction}>
        <VStack gap={3}>
          {tailscaleState?.message && (
            <StatusAlert message={tailscaleState.message} success={tailscaleState.success} />
          )}
          {moduleDisabledReason && (
            <WarnAlert title={t("tailscaleModuleDisabledTitle")}>
              {t("tailscaleModuleDisabledBody", { reason: moduleDisabledReason })}
            </WarnAlert>
          )}
          <ModuleGated feature="tailscale">
            <Switch
              label={t("useTailscale")}
              description={t("tailscaleHelp")}
              htmlName="tailscaleEnabled"
              value={enabled}
              onChange={setEnabled}
              isDisabled={Boolean(moduleDisabledReason)}
            />
          </ModuleGated>
          <InfoAlert title={t("trustedProxiesInfoTitle")}>
            {t.rich("tailscaleUserspaceNote", { code: (chunks) => <Code>{chunks}</Code> })}
          </InfoAlert>
          <EnvLabelledField label={t("authKey")} env={["TS_AUTHKEY"]}>
            <TextInput
              startIcon={KeyRound}
              {...AUTOFILL_NEW_PASSWORD}
              label={t("authKey")}
              type="password"
              isOptional
              description={
                tailscale.hasAuthKey ? t("tailscaleAuthKeyStored") : t("tailscaleAuthKeyHelp")
              }
              htmlName="tailscaleAuthKey"
              value={authKey}
              onChange={setAuthKey}
            />
          </EnvLabelledField>
          <TextInput
            {...AUTOFILL_OFF}
            label={t("defaultNodeName")}
            description={t("tailscaleDefaultNodeHelp")}
            htmlName="tailscaleDefaultNode"
            value={defaultNode}
            onChange={setDefaultNode}
            placeholder="caddy"
          />
          <TextInput
            startIcon={Tag}
            {...AUTOFILL_OFF}
            label={t("tags")}
            isOptional
            description={t("tailscaleTagsHelp")}
            htmlName="tailscaleTags"
            value={tags}
            onChange={setTags}
            placeholder="tag:caddy"
          />
          <TextInput
            startIcon={LinkIcon}
            {...AUTOFILL_OFF}
            label={t("controlServerUrl")}
            isOptional
            description={t("tailscaleControlServerHelp")}
            htmlName="tailscaleControlUrl"
            value={controlUrl}
            onChange={setControlUrl}
            placeholder="https://headscale.example.com"
          />
          <TextInput
            startIcon={FolderOpen}
            {...AUTOFILL_OFF}
            label={t("stateDirectory")}
            isOptional
            description={t("tailscaleStateDirectoryHelp")}
            htmlName="tailscaleStateDir"
            value={stateDir}
            onChange={setStateDir}
            placeholder="/data/tailscale"
          />
          <Switch
            label={t("registerNodesAsEphemeral")}
            description={t("ephemeralNodesHelp")}
            htmlName="tailscaleEphemeral"
            value={ephemeral}
            onChange={setEphemeral}
          />
          <Switch
            label={t("tailscaleHttp3Label")}
            description={t("tailscaleHttp3Help")}
            htmlName="tailscaleHttp3"
            value={http3}
            onChange={setHttp3}
          />
          <WarnAlert title={t("tailscaleHttp3WarningTitle")}>
            {t("tailscaleHttp3WarningBody")}
          </WarnAlert>
          <Switch
            label={t("tailscaleKeyValidationLabel")}
            description={t("tailscaleKeyValidationHelp")}
            htmlName="tailscaleValidateAuthKey"
            value={validateAuthKey}
            onChange={setValidateAuthKey}
          />
          {validateAuthKey ? (
            <>
              <TextInput
                startIcon={KeyRound}
                {...AUTOFILL_NEW_PASSWORD}
                label={t("apiAccessToken")}
                type="password"
                isOptional
                description={
                  tailscale.hasApiAccessToken
                    ? t("tailscaleApiTokenStored")
                    : t("tailscaleApiTokenHelp")
                }
                htmlName="tailscaleApiAccessToken"
                value={apiAccessToken}
                onChange={setApiAccessToken}
              />
              <TextInput
                startIcon={Network}
                {...AUTOFILL_OFF}
                label={t("tailnet")}
                isOptional
                description={t("tailscaleTailnetHelp")}
                htmlName="tailscaleApiTailnet"
                value={apiTailnet}
                onChange={setApiTailnet}
                placeholder="-"
              />
            </>
          ) : (
            <WarnAlert title={t("tailscaleKeyValidationDisabledTitle")}>
              {t.rich("tailscaleKeyValidationDisabledBody", {
                em: (chunks) => <em>{chunks}</em>,
              })}
            </WarnAlert>
          )}
        </VStack>
      </form>
    </FormCard>
  );
}

// ─── Section: Authentik Defaults ─────────────────────────────────────────────

function AuthentikSection({
  authentik,
  authentikState,
  authentikFormAction,
}: {
  authentik: AuthentikSettings | null;
  authentikState: { success: boolean; message?: string } | null;
  authentikFormAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const [outpostDomain, setOutpostDomain] = useState(authentik?.outpostDomain ?? "");
  const [outpostUpstream, setOutpostUpstream] = useState(authentik?.outpostUpstream ?? "");
  const [authEndpoint, setAuthEndpoint] = useState(authentik?.authEndpoint ?? "");

  return (
    <FormCard>
      <form action={authentikFormAction}>
        <VStack gap={3}>
          {authentikState?.message && (
            <StatusAlert message={authentikState.message} success={authentikState.success} />
          )}
          <TextInput
            startIcon={Globe}
            {...NATIVE_REQUIRED}
            label={t("outpostDomain")}
            htmlName="outpostDomain"
            value={outpostDomain}
            onChange={setOutpostDomain}
            placeholder="outpost.goauthentik.io"
            isRequired
          />
          <TextInput
            startIcon={LinkIcon}
            {...NATIVE_REQUIRED}
            label={t("outpostUpstream")}
            htmlName="outpostUpstream"
            value={outpostUpstream}
            onChange={setOutpostUpstream}
            placeholder="http://authentik-server:9000"
            isRequired
          />
          <TextInput
            startIcon={Route}
            label={t("authEndpoint")}
            isOptional
            htmlName="authEndpoint"
            value={authEndpoint}
            onChange={setAuthEndpoint}
            placeholder="/outpost.goauthentik.io/auth/caddy"
          />
        </VStack>
      </form>
    </FormCard>
  );
}

/** Forward-auth defaults every host would otherwise repeat; the rest is per host. */
function ForwardAuthSection({
  forwardAuth,
  forwardAuthState,
  forwardAuthFormAction,
}: {
  forwardAuth: ForwardAuthSettings | null;
  forwardAuthState: { success: boolean; message?: string } | null;
  forwardAuthFormAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const [provider, setProvider] = useState<string>(forwardAuth?.provider ?? "authelia");
  const [authUpstream, setAuthUpstream] = useState(forwardAuth?.authUpstream ?? "");
  const [authEndpoint, setAuthEndpoint] = useState(forwardAuth?.authEndpoint ?? "");

  return (
    <FormCard>
      <form action={forwardAuthFormAction}>
        <VStack gap={3}>
          {forwardAuthState?.message && (
            <StatusAlert message={forwardAuthState.message} success={forwardAuthState.success} />
          )}
          <Selector
            label={tCommon("provider")}
            htmlName="forwardAuthProvider"
            options={[
              { value: "authelia", label: "Authelia" },
              { value: "custom", label: t("forwardAuthProviderCustom") },
            ]}
            value={provider}
            onChange={(next) => setProvider(next as string)}
          />
          <TextInput
            startIcon={LinkIcon}
            {...NATIVE_REQUIRED}
            label={t("forwardAuthUpstream")}
            htmlName="forwardAuthUpstream"
            value={authUpstream}
            onChange={setAuthUpstream}
            placeholder="http://authelia:9091"
            isRequired
          />
          <TextInput
            startIcon={Route}
            label={t("authEndpoint")}
            isOptional
            htmlName="forwardAuthEndpoint"
            value={authEndpoint}
            onChange={setAuthEndpoint}
            placeholder="/api/authz/forward-auth"
          />
        </VStack>
      </form>
    </FormCard>
  );
}

// ─── Section: OAuth Providers ────────────────────────────────────────────────

function OAuthSection({
  oauthProviders,
  primaryProviderId,
  localUsersDisabled,
  baseUrl,
}: {
  oauthProviders: OAuthProviderView[];
  /** The provider offered first on the sign-in screen, or null for alphabetical order. */
  primaryProviderId: string | null;
  localUsersDisabled: boolean;
  baseUrl: string;
}) {
  return (
    <FormCard>
      <OAuthProvidersSection
        initialProviders={oauthProviders}
        initialPrimaryProviderId={primaryProviderId}
        baseUrl={baseUrl}
        localUsersDisabled={localUsersDisabled}
      />
    </FormCard>
  );
}

// ─── Section: Password Policy ────────────────────────────────────────────────

/** Not an agent override: inheriting it would let one instance lock another's users out. */
function PasswordPolicySection({
  passwordPolicy,
  passwordPolicyState,
  passwordPolicyFormAction,
}: {
  passwordPolicy: { requireChangeOnLegacyHash: boolean; fromEnv: boolean };
  passwordPolicyState: { success: boolean; message?: string } | null;
  passwordPolicyFormAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const [requireChange, setRequireChange] = useState(passwordPolicy.requireChangeOnLegacyHash);

  return (
    <FormCard title={t("legacyPasswordHashes")}>
      <form action={passwordPolicyFormAction}>
        <VStack gap={3}>
          {passwordPolicy.fromEnv && (
            <InfoAlert title={t("passwordPolicyEnvironmentOverrideTitle")}>
              {t("environmentOverrideDescription")}
            </InfoAlert>
          )}
          {passwordPolicyState?.message && (
            <StatusAlert
              message={passwordPolicyState.message}
              success={passwordPolicyState.success}
            />
          )}
          <EnvLabelledField
            label={t("legacyPasswordResetLabel")}
            env={["AUTH_REQUIRE_PASSWORD_CHANGE_ON_LEGACY_HASH"]}
            description={t("legacyPasswordResetHelp")}
            layout="inline"
          >
            <Switch
              label={t("legacyPasswordResetLabel")}
              htmlName="requireChangeOnLegacyHash"
              value={requireChange}
              onChange={setRequireChange}
              isDisabled={passwordPolicy.fromEnv}
            />
          </EnvLabelledField>
        </VStack>
      </form>
    </FormCard>
  );
}

// ─── Section: User Avatars ───────────────────────────────────────────────────

function AvatarsSection({
  avatars,
  avatarsState,
  avatarsFormAction,
}: {
  avatars: { gravatarEnabled: boolean; fromEnv: boolean };
  avatarsState: { success: boolean; message?: string } | null;
  avatarsFormAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const [gravatarEnabled, setGravatarEnabled] = useState(avatars.gravatarEnabled);

  return (
    <FormCard title={t("fallbackIcon")}>
      <form action={avatarsFormAction}>
        <VStack gap={3}>
          {avatars.fromEnv && (
            <InfoAlert title={t("gravatarEnvironmentOverrideTitle")}>
              {t("environmentOverrideDescription")}
            </InfoAlert>
          )}
          {avatarsState?.message && (
            <StatusAlert message={avatarsState.message} success={avatarsState.success} />
          )}
          <EnvLabelledField
            label={t("gravatarLabel")}
            env={["AVATAR_GRAVATAR"]}
            description={t("gravatarHelp")}
            layout="inline"
          >
            <Switch
              label={t("gravatarLabel")}
              htmlName="gravatarEnabled"
              value={gravatarEnabled}
              onChange={setGravatarEnabled}
              isDisabled={avatars.fromEnv}
            />
          </EnvLabelledField>
        </VStack>
      </form>
    </FormCard>
  );
}

// ─── Section: Branding ───────────────────────────────────────────────────────

/**
 * Narrowed to `blob:` though createObjectURL cannot return anything else: the value derives from a
 * user-picked file, which scanners flag as XSS (js/xss-through-dom). Null, not a throw, so a failed
 * preview never breaks the form.
 */
function objectUrlForPreview(file: File): string | null {
  const url = URL.createObjectURL(file);
  if (url.startsWith("blob:")) return url;
  URL.revokeObjectURL(url);
  return null;
}

/**
 * One row: a preview tile that uploads on click and removes from its corner, then what is set.
 * Both only mark the form changed; the page's save bar stages it like any other block. The file
 * input stays native and hidden, since Astryx's FileInput posts nothing with a form; the tile opens
 * it. `faviconSrc` is the staged icon, which the public route cannot serve.
 */
function BrandingSection({
  accentField,
  accentState,
  accentFormAction,
  faviconSrc,
  faviconState,
  faviconFormAction,
}: {
  accentField: RegistryField | undefined;
  accentState: { success: boolean; message?: string } | null;
  accentFormAction: (payload: FormData) => void;
  faviconSrc: string | null;
  faviconState: { success: boolean; message?: string } | null;
  faviconFormAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const [preview, setPreview] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Revoked on replacement and unmount: an object URL pins the file in memory until it is.
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  // React resets the form after its action, emptying the file input; the pending state goes too.
  useEffect(() => {
    if (!faviconState) return;
    setPreview(null);
    setChosen(null);
    setRemoving(false);
  }, [faviconState]);

  const pick = () => fileInput.current?.click();
  const shown = removing ? null : (preview ?? faviconSrc);

  return (
    // One card, untitled: the block's heading already says Branding, and each part has its own.
    <FormCard>
      <AccentColorPicker field={accentField} state={accentState} formAction={accentFormAction} />
      {accentField && <Divider />}
      <Heading level={3}>{t("favicon")}</Heading>
      <form action={faviconFormAction}>
        <VStack gap={3}>
          {faviconState?.message && (
            <StatusAlert message={faviconState.message} success={faviconState.success} />
          )}
          <HStack gap={3} vAlign="center" wrap="wrap">
            {/* Our tooltip, not Thumbnail's `label`: it also composes the tile's and the remove
                button's names ("Open {label}"), which a sentence would garble. `alt` names them. */}
            <Tooltip
              content={
                preview
                  ? t("faviconTooltipPicked")
                  : shown
                    ? t("faviconTooltipReplace")
                    : t("faviconTooltipUpload")
              }
            >
              <Thumbnail
                src={shown ?? undefined}
                alt={
                  preview
                    ? t("faviconSelectedAlt")
                    : shown
                      ? t("faviconCurrentAlt")
                      : t("faviconNoneAlt")
                }
                // The tile is the upload control; there is no separate button.
                onClick={pick}
                onRemove={
                  shown
                    ? () => {
                        // A picked file is dropped, not staged: removing means nothing replaces it.
                        if (fileInput.current) fileInput.current.value = "";
                        setPreview(null);
                        setChosen(null);
                        setRemoving(faviconSrc !== null);
                      }
                    : undefined
                }
              />
            </Tooltip>
            <VStack gap={0} className="min-w-0 grow basis-55">
              <Text type="body">
                {removing
                  ? t("faviconWillBeRemoved")
                  : preview
                    ? t("faviconSelected", { name: String(chosen) })
                    : faviconSrc
                      ? t("faviconCustomSet")
                      : t("faviconNone")}
              </Text>
              <Text type="supporting" color="secondary">
                {t("faviconUploadHelp")}
              </Text>
            </VStack>
            <HStack gap={2}>
              {removing && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  label={tCommon("keep")}
                  onClick={() => setRemoving(false)}
                />
              )}
            </HStack>
          </HStack>

          <input type="hidden" name="intent" value={removing ? "remove" : ""} />
          <input
            ref={fileInput}
            type="file"
            name="favicon"
            hidden
            aria-label={t("faviconFileLabel")}
            accept="image/png,image/x-icon,image/vnd.microsoft.icon,image/svg+xml,image/webp,image/gif,image/jpeg,.ico"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              setRemoving(false);
              setChosen(file?.name ?? null);
              setPreview(file ? objectUrlForPreview(file) : null);
            }}
          />
        </VStack>
      </form>
    </FormCard>
  );
}

// ─── Section: Updates ────────────────────────────────────────────────────────

function UpdatesSection({
  updates,
  updatesState,
  updatesFormAction,
}: {
  updates: UpdateStatus;
  updatesState: { success: boolean; message?: string } | null;
  updatesFormAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const now = useNow();
  const [enabled, setEnabled] = useState(updates.enabled);
  const [repository, setRepository] = useState(updates.repository);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ success: boolean; message?: string } | null>(
    null,
  );

  return (
    <FormCard title={t("releaseUpdates")}>
      <form action={updatesFormAction}>
        <VStack gap={3}>
          {updatesState?.message && (
            <StatusAlert message={updatesState.message} success={updatesState.success} />
          )}
          {checkResult?.message && (
            <StatusAlert message={checkResult.message} success={checkResult.success} />
          )}

          {updates.updateAvailable ? (
            <WarnAlert title={t("updateAvailableTitle", { version: updates.latest ?? "" })}>
              {t("updateAvailableBody", { current: updates.current })}
            </WarnAlert>
          ) : (
            <InfoAlert title={t("runningVersionTitle", { version: updates.current })}>
              {updates.error
                ? t("updateCheckIncomplete", { error: updates.error })
                : updates.latest
                  ? t("updateUpToDate", { latest: updates.latest })
                  : updates.enabled
                    ? t("updateNoCheckYet")
                    : t("updateChecksOff")}
            </InfoAlert>
          )}

          <EnvLabelledField
            label={t("checkForUpdates")}
            env={["UPDATE_CHECK_ENABLED"]}
            description={t("registry.update_check_enabled.description")}
            layout="inline"
          >
            <Switch
              label={t("checkForUpdates")}
              htmlName="updateCheckEnabled"
              value={enabled}
              onChange={setEnabled}
            />
          </EnvLabelledField>

          <EnvLabelledField
            label={t("registry.update_image_repository.label")}
            env={["UPDATE_IMAGE_REPOSITORY"]}
          >
            <TextInput
              startIcon={Container}
              {...AUTOFILL_OFF}
              label={t("registry.update_image_repository.label")}
              description={t("imageRepositoryHelp")}
              placeholder={t("imageRepositoryPlaceholder")}
              htmlName="updateImageRepository"
              value={repository}
              onChange={setRepository}
              isDisabled={!enabled}
            />
          </EnvLabelledField>

          {updates.enabled && updates.checkedAt ? (
            <UtcTooltip value={updates.checkedAt}>
              {/* The server and the browser read the clock moments apart, so "3 minutes ago" can
                  differ by a second between the two renders. */}
              <Text size="xsm" color="secondary">
                <span suppressHydrationWarning>
                  {t("updateLastChecked", {
                    when: format.relativeTime(new Date(updates.checkedAt), now),
                  })}
                </span>
              </Text>
            </UtcTooltip>
          ) : (
            <Text size="xsm" color="secondary">
              {!updates.enabled ? t("updateNotChecking") : t("updateNeverChecked")}
            </Text>
          )}

          <HStack gap={2} justify="end">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              label={checking ? tCommon("checking") : tCommon("check")}
              isDisabled={!enabled || checking}
              onClick={async () => {
                setChecking(true);
                setCheckResult(null);
                try {
                  setCheckResult(await checkForUpdatesAction());
                } finally {
                  setChecking(false);
                }
              }}
            />
          </HStack>
        </VStack>
      </form>
    </FormCard>
  );
}

// ─── Section: Analytics ──────────────────────────────────────────────────────

/**
 * Where the current answer came from when nothing is stored, so a pre-ticked box reads as the
 * deployment's configuration rather than a setting someone else changed.
 */
function InferredNote({ source, children }: { source: string; children: ReactNode }) {
  const t = useTranslations("settings");
  if (source === "environment") {
    return (
      <InfoAlert title={t("environmentOverrideTitle")}>
        {t.rich("inferredEnvironmentNote", { code: (chunks) => <Code>{chunks}</Code> })}
      </InfoAlert>
    );
  }
  return <InfoAlert title={t("credentialsMissingStatus")}>{children}</InfoAlert>;
}

function AnalyticsSection({
  analytics,
  canManageServices,
  analyticsState,
  analyticsFormAction,
}: {
  analytics: AnalyticsView;
  canManageServices: boolean;
  analyticsState: { success: boolean; message?: string } | null;
  analyticsFormAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const [enabled, setEnabled] = useState(analytics.enabled);
  const [url, setUrl] = useState(analytics.url);
  const [user, setUser] = useState(analytics.user);
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState(analytics.database);
  const [retentionDays, setRetentionDays] = useState(analytics.retentionDays);

  return (
    <FormCard title={t("trafficAndWafEvents")}>
      <form action={analyticsFormAction}>
        <VStack gap={3}>
          {analytics.inferred && (
            <InferredNote source={analytics.source}>
              {t("analyticsInferredNote", {
                state: analytics.enabled ? "on" : "off",
                password: analytics.hasPassword ? "set" : "unset",
              })}
            </InferredNote>
          )}
          {analyticsState?.message && (
            <StatusAlert message={analyticsState.message} success={analyticsState.success} />
          )}
          <EnvLabelledField
            label={t("collectAnalytics")}
            env={["ANALYTICS_ENABLED"]}
            description={t("analyticsCollectionHelp")}
            layout="inline"
          >
            <Switch
              label={t("collectAnalytics")}
              htmlName="analyticsEnabled"
              value={enabled}
              onChange={setEnabled}
            />
          </EnvLabelledField>
          {canManageServices ? (
            <InfoAlert title={t("managedAnalyticsTitle")}>
              {t.rich("analyticsManagedNote", { code: (chunks) => <Code>{chunks}</Code> })}
            </InfoAlert>
          ) : (
            <WarnAlert title={t("agentManagementUnavailableTitle")}>
              {t.rich("analyticsUnmanagedNote", { code: (chunks) => <Code>{chunks}</Code> })}
            </WarnAlert>
          )}
          {/* Tells the action a password already exists, so "enabled with an empty field" is a
              keep-what-is-stored rather than a misconfiguration to refuse. */}
          <input type="hidden" name="hasPassword" value={analytics.hasPassword ? "yes" : "no"} />
          <EnvLabelledField label={t("registry.clickhouse_url.label")} env={["CLICKHOUSE_URL"]}>
            <TextInput
              startIcon={LinkIcon}
              {...AUTOFILL_OFF}
              label={t("registry.clickhouse_url.label")}
              description={t("registry.clickhouse_url.description")}
              htmlName="clickhouseUrl"
              value={url}
              onChange={setUrl}
            />
          </EnvLabelledField>
          <EnvLabelledField label={t("registry.clickhouse_user.label")} env={["CLICKHOUSE_USER"]}>
            <TextInput
              startIcon={User}
              {...AUTOFILL_OFF}
              label={t("registry.clickhouse_user.label")}
              htmlName="clickhouseUser"
              value={user}
              onChange={setUser}
            />
          </EnvLabelledField>
          <EnvLabelledField
            label={t("registry.clickhouse_password.label")}
            env={["CLICKHOUSE_PASSWORD"]}
          >
            <GeneratedPasswordField
              label={t("registry.clickhouse_password.label")}
              isOptional={analytics.hasPassword}
              description={
                analytics.hasPassword
                  ? t("clickhousePasswordStored")
                  : t("clickhousePasswordRequired")
              }
              htmlName="clickhousePassword"
              value={password}
              onChange={setPassword}
            />
          </EnvLabelledField>
          <EnvLabelledField label={t("registry.clickhouse_db.label")} env={["CLICKHOUSE_DB"]}>
            <TextInput
              {...AUTOFILL_OFF}
              label={t("registry.clickhouse_db.label")}
              htmlName="clickhouseDb"
              value={database}
              onChange={setDatabase}
            />
          </EnvLabelledField>
          <EnvLabelledField label={t("retentionDays")} env={["CLICKHOUSE_RETENTION_DAYS"]}>
            <NumberInput
              startIcon={CalendarDays}
              hasNumberSteppers
              units={t("units.days")}
              label={t("retentionDays")}
              description={t("analyticsRetentionHelp")}
              htmlName="clickhouseRetentionDays"
              value={retentionDays}
              onChange={setRetentionDays}
              isIntegerOnly
              min={1}
              max={3650}
            />
          </EnvLabelledField>
        </VStack>
      </form>
    </FormCard>
  );
}

// ─── Section: GeoIP ──────────────────────────────────────────────────────────

/**
 * The last MaxMind check, and a way to run one. A run finding nothing new leaves no trace on disk,
 * so the file's date cannot tell a quiet week from a failing updater.
 */
function GeoipUpdateCheckLine({ geoip }: { geoip: GeoipView }) {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  const checkNow = () => {
    setResult(null);
    startTransition(async () => {
      const outcome = await updateGeoipDatabasesAction();
      setResult(outcome.message ?? null);
    });
  };

  const behind = geoip.editionsBehind;
  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center">
        {geoip.lastCheckedAt ? (
          <UtcTooltip value={geoip.lastCheckedAt}>
            <Text size="sm" color="secondary">
              {t("geoipLastChecked", {
                when: format.dateTime(new Date(geoip.lastCheckedAt), TIMESTAMP_STYLES.dateTime),
              })}
            </Text>
          </UtcTooltip>
        ) : (
          <Text size="sm" color="secondary">
            {t("geoipNeverChecked")}
          </Text>
        )}
        <Button
          variant="secondary"
          size="sm"
          label={pending ? tCommon("checking") : tCommon("check")}
          onClick={checkNow}
          isDisabled={pending}
        />
      </HStack>
      {geoip.checkError && <WarnAlert title={geoip.checkError} />}
      {geoip.downloadError && (
        <WarnAlert title={t("geoipDownloadFailed", { error: geoip.downloadError })} />
      )}
      {behind.length > 0 && <WarnAlert title={t("geoipBehind", { editions: behind.join(", ") })} />}
      {result && (
        <Text size="sm" color="secondary">
          {result}
        </Text>
      )}
    </VStack>
  );
}

function GeoipSection({
  geoip,
  geoipState,
  geoipFormAction,
}: {
  geoip: GeoipView;
  geoipState: { success: boolean; message?: string } | null;
  geoipFormAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const [enabled, setEnabled] = useState(geoip.enabled);
  const [accountId, setAccountId] = useState(geoip.accountId);
  const [licenseKey, setLicenseKey] = useState("");
  const [intervalHours, setIntervalHours] = useState(geoip.updateIntervalHours);

  return (
    <FormCard title={t("maxmindGeolite2")}>
      <form action={geoipFormAction}>
        <VStack gap={3}>
          {geoip.inferred && (
            <InferredNote source={geoip.source}>
              {t("geoipInferredNote", {
                state: geoip.enabled ? "on" : "off",
                present: geoip.installedEditions.length > 0 ? "yes" : "no",
              })}
            </InferredNote>
          )}
          {geoipState?.message && (
            <StatusAlert message={geoipState.message} success={geoipState.success} />
          )}
          <EnvLabelledField
            label={t("useGeoip")}
            env={["GEOIP_ENABLED"]}
            description={t("geoipHelp")}
            layout="inline"
          >
            <Switch
              label={t("useGeoip")}
              htmlName="geoipEnabled"
              value={enabled}
              onChange={setEnabled}
            />
          </EnvLabelledField>
          <InfoAlert title={t("geoipDownloadsTitle")}>{t("geoipDownloadsDescription")}</InfoAlert>
          <Text size="sm" color="secondary">
            {geoip.installedEditions.length > 0
              ? t("geoipInstalled", { editions: geoip.installedEditions.join(", ") })
              : t("geoipNoneInstalled")}
          </Text>
          <GeoipUpdateCheckLine geoip={geoip} />
          <input type="hidden" name="hasLicenseKey" value={geoip.hasLicenseKey ? "yes" : "no"} />
          <EnvLabelledField
            label={t("registry.geoipupdate_account_id.label")}
            env={["GEOIPUPDATE_ACCOUNT_ID"]}
          >
            <TextInput
              {...AUTOFILL_OFF}
              label={t("registry.geoipupdate_account_id.label")}
              isOptional
              description={t("maxmindCredentialsHelp")}
              htmlName="geoipAccountId"
              value={accountId}
              onChange={setAccountId}
            />
          </EnvLabelledField>
          <EnvLabelledField
            label={t("registry.geoipupdate_license_key.label")}
            env={["GEOIPUPDATE_LICENSE_KEY"]}
          >
            <TextInput
              startIcon={KeyRound}
              {...AUTOFILL_NEW_PASSWORD}
              label={t("registry.geoipupdate_license_key.label")}
              type="password"
              isOptional
              description={
                geoip.hasLicenseKey
                  ? t("maxmindLicenceKeyStored")
                  : t("registry.geoipupdate_license_key.description")
              }
              htmlName="geoipLicenseKey"
              value={licenseKey}
              onChange={setLicenseKey}
            />
          </EnvLabelledField>
          <EnvLabelledField label={t("geoipUpdateInterval")} env={["GEOIP_UPDATE_INTERVAL_HOURS"]}>
            <NumberInput
              label={t("geoipUpdateInterval")}
              description={t("geoipUpdateIntervalHelp")}
              htmlName="geoipUpdateIntervalHours"
              value={intervalHours}
              onChange={setIntervalHours}
              isIntegerOnly
              hasNumberSteppers
              units={t("units.hours")}
              startIcon={Clock}
              min={1}
              max={168}
            />
          </EnvLabelledField>
        </VStack>
      </form>
    </FormCard>
  );
}

// ─── Section: Agent ──────────────────────────────────────────────────────────

/** Through next-intl, not `toLocaleString()`, so zone and locale match the rest of the page. */
function whenText(
  format: ReturnType<typeof useFormatter>,
  iso: string | null,
  never: string,
): string {
  if (!iso) return never;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? never
    : format.dateTime(parsed, TIMESTAMP_STYLES.dateTime);
}

function AgentRow({
  name,
  status,
  error,
  lastSeenAt,
  onRemove,
}: {
  name: string;
  status: AgentStatus | null;
  error: string | null;
  lastSeenAt: string | null;
  onRemove: ReactNode;
}) {
  const t = useTranslations("settings");
  const format = useFormatter();
  return (
    <VStack gap={2}>
      <HStack gap={2} align="center" justify="between">
        <VStack gap={1}>
          <HStack gap={2} align="center">
            <Text size="sm" weight="semibold">
              {name}
            </Text>
            {status ? (
              <Text size="xsm" color="secondary">
                {t("agentRowSummary", {
                  version: status.version,
                  mode: status.mode,
                  project: status.composeProject,
                })}
              </Text>
            ) : (
              <Badge variant="error" label={t("notAnswering")} />
            )}
          </HStack>
          <Text size="xsm" color="secondary">
            {t("agentLastReported", {
              when: whenText(format, lastSeenAt, t("agentNeverReported")),
            })}
          </Text>
          {status && (
            <Text size="xsm" color="secondary">
              {t("agentRowPorts", {
                count: status.l4Ports.applied.length,
                portsState: status.l4Ports.status.state,
                buildState: status.caddyBuild.status.state,
              })}
            </Text>
          )}
        </VStack>
        {onRemove}
      </HStack>
      {error && <WarnAlert title={t("agentNotReachableTitle", { name })}>{error}</WarnAlert>}
    </VStack>
  );
}

function AgentSection({
  agents,
  pairingHost,
}: {
  agents: Props["agents"];
  /** The dashboard domain, when set - otherwise the command keeps a placeholder to fill in. */
  pairingHost: { host: string; insecure: boolean } | null;
}) {
  const t = useTranslations("settings");
  const tNav = useTranslations("nav");
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [repair, setRepair] = useState<{ name: string; result: RepairAgentResult } | null>(null);

  const { paired, statuses } = agents;
  const usingPaired = paired.length > 0;
  const statusFor = (agentName: string) => statuses.find((entry) => entry.agent === agentName);
  const answering = statuses.filter((entry) => entry.ok).length;
  const repairResult = repair?.result ?? null;

  const repairControls = (agent: { id: number; name: string }) => (
    <HStack gap={2}>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        label={t("repairAgent")}
        onClick={() => {
          repairAgentAction(agent.id)
            .then((result) => setRepair({ name: agent.name, result }))
            .catch(() => setRepair({ name: agent.name, result: { kind: "failed" } }));
        }}
      />
      <form action={unpairAgentAction}>
        <input type="hidden" name="agentId" value={agent.id} />
        <Button type="submit" size="sm" variant="secondary" label={t("unpair")} />
      </form>
    </HStack>
  );

  return (
    <>
      <FormCard title={usingPaired ? tNav("agents") : t("currentAgentTitle")}>
        <VStack gap={3}>
          <Text size="sm" color="secondary">
            {t("agentsDescription")}
          </Text>

          {usingPaired && paired.length > 1 && (
            <InfoAlert title={t("sharedAgentConfigTitle")}>
              {t("sharedAgentConfigBody", { count: paired.length })}
            </InfoAlert>
          )}

          {statuses.length === 0 ? (
            <WarnAlert title={t("agentsUnavailableTitle")}>
              {usingPaired ? t("agentsNothingReached") : t("agentsStartContainer")}
            </WarnAlert>
          ) : (
            <VStack gap={3}>
              {!usingPaired && (
                <>
                  <InfoAlert title={t("localAgentTitle")}>{t("localAgentDescription")}</InfoAlert>
                  <AgentRow
                    name={t("localAgentName")}
                    status={statuses[0]?.ok ? statuses[0].value : null}
                    error={statuses[0]?.ok ? null : (statuses[0]?.error ?? null)}
                    lastSeenAt={null}
                    onRemove={null}
                  />
                </>
              )}

              {paired.map((agent) => {
                const entry = statusFor(agent.name);
                return (
                  <AgentRow
                    key={agent.id}
                    name={agent.name}
                    status={entry?.ok ? entry.value : null}
                    error={entry && !entry.ok ? entry.error : null}
                    lastSeenAt={agent.lastSeenAt}
                    onRemove={repairControls(agent)}
                  />
                );
              })}

              {repair && repairResult?.kind === "failed" && (
                <StatusAlert message={t("repairFailed")} success={false} />
              )}
              {repair && repairResult?.kind === "bootstrap" && (
                <InfoAlert title={t("repairTitle", { name: repair.name })}>
                  {t("repairBootstrapIssued")}
                </InfoAlert>
              )}
              {repair && repairResult?.kind === "code" && (
                <InfoAlert title={t("repairTitle", { name: repair.name })}>
                  <VStack gap={2}>
                    <Text size="xl" weight="semibold">
                      {repairResult.code}
                    </Text>
                    <Text size="sm" color="secondary">
                      {t("repairCodeHelp")}
                    </Text>
                    <Code>{`cpm-agent --pair --host <this-controller> --code ${repairResult.code}`}</Code>
                  </VStack>
                </InfoAlert>
              )}
            </VStack>
          )}

          {usingPaired && (
            <Text size="xsm" color="secondary">
              {t("agentsAnsweringNote", { answering, total: paired.length })}
            </Text>
          )}
        </VStack>
      </FormCard>

      <FormCard title={t("pairAnAgent")}>
        <VStack gap={3}>
          <Text size="sm" color="secondary">
            {t("pairingCodeHelp")}
          </Text>
          {agents.autoPairingDisabled && (
            <InfoAlert title={t("autoPairingDisabledTitle")}>
              <VStack gap={2}>
                <Text size="sm">{t("autoPairingDisabledDescription")}</Text>
                <form action={enableAutoPairingAction}>
                  <Button
                    type="submit"
                    size="sm"
                    variant="secondary"
                    label={t("enableAutoPairing")}
                  />
                </form>
              </VStack>
            </InfoAlert>
          )}
          {codeError && <StatusAlert message={codeError} success={false} />}
          {code ? (
            <VStack gap={2}>
              <Text size="xl" weight="semibold">
                {code.code}
              </Text>
              <Text size="xsm" color="secondary">
                {t("pairingCodeExpires", {
                  minutes: Math.max(1, Math.round((code.expiresAt - Date.now()) / 60000)),
                })}
              </Text>
              <Text size="sm" color="secondary">
                {t("pairingCodeRun")}
              </Text>
              <CodeBlock
                code={`docker exec -it caddy-proxy-manager-agent cpm-agent --pair --host ${pairingHost?.host ?? "<this-controller>"} --code ${code.code}`}
                language="bash"
                hasLanguageLabel={false}
                isWrapped
                width="100%"
              />
              {pairingHost?.insecure && (
                <Text size="xsm" color="secondary">
                  {t("pairingHostInsecureHint")}
                </Text>
              )}
            </VStack>
          ) : (
            <Button
              type="button"
              variant="primary"
              size="sm"
              label={t("generatePairingCode")}
              onClick={() => {
                setCodeError(null);
                pairingCodeAction()
                  .then(setCode)
                  .catch(() => setCodeError(t("pairingCodeFailed")));
              }}
            />
          )}
        </VStack>
      </FormCard>
    </>
  );
}

// ─── Section: Caddy Build ────────────────────────────────────────────────────

/**
 * Per-agent selections over a fleet default: the module list describes one host's binary, so a
 * plugin only one agent needs should not land in every image.
 */
function CaddyBuildSection({
  caddyBuild,
  caddyBuildState,
  caddyBuildFormAction,
  agents,
  agentBuildSelections,
}: {
  caddyBuild: CaddyBuildSettings | null;
  caddyBuildState: { success: boolean; message?: string } | null;
  caddyBuildFormAction: (formData: FormData) => void;
  agents?: { id: number; name: string; connected: boolean }[];
  agentBuildSelections?: Record<number, CaddyBuildSettings | null>;
}) {
  return (
    <form action={caddyBuildFormAction}>
      <VStack gap={4}>
        {caddyBuildState?.message && (
          <StatusAlert
            message={caddyBuildState.message}
            success={Boolean(caddyBuildState.success)}
          />
        )}
        <CaddyBuildFields
          initialModules={caddyBuild?.modules ?? {}}
          initialCustomModules={caddyBuild?.customModules ?? []}
          agents={agents ?? []}
          agentSelections={agentBuildSelections ?? {}}
        />
      </VStack>
    </form>
  );
}

// ─── Section: Metrics & Monitoring ───────────────────────────────────────────

function MetricsSection({
  metrics,
  metricsState,
  metricsFormAction,
}: {
  metrics: MetricsSettings | null;
  metricsState: { success: boolean; message?: string } | null;
  metricsFormAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const [enabled, setEnabled] = useState(metrics?.enabled ?? false);
  const [port, setPort] = useState(metrics?.port ?? 9090);

  return (
    <>
      <FormCard>
        <form action={metricsFormAction}>
          <VStack gap={3}>
            {metricsState?.message && (
              <StatusAlert message={metricsState.message} success={metricsState.success} />
            )}
            <Switch
              label={t("enableMetricsEndpoint")}
              description={t("metricsEndpointHelp")}
              htmlName="enabled"
              value={enabled}
              onChange={setEnabled}
            />
            <NumberInput
              startIcon={EthernetPort}
              hasNumberSteppers
              label={tCommon("port")}
              description={t("metricsPortHelp")}
              htmlName="port"
              value={port}
              onChange={setPort}
              isIntegerOnly
              min={1}
              max={65535}
              width={160}
            />
          </VStack>
        </form>
      </FormCard>
      <InfoAlert title={t("metricsInfoTitle")}>
        {/* A string, not a number: ICU would group a port of 10000 as "10,000". */}
        {t("metricsScrapeNote", { port: String(metrics?.port ?? 9090) })}
      </InfoAlert>
    </>
  );
}

// ─── Section: Access Logging ─────────────────────────────────────────────────

function LoggingSection({
  logging,
  loggingState,
  loggingFormAction,
}: {
  logging: LoggingSettings | null;
  loggingState: { success: boolean; message?: string } | null;
  loggingFormAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const [enabled, setEnabled] = useState(logging?.enabled ?? false);
  const [format, setFormat] = useState<string>(logging?.format ?? "json");

  return (
    <>
      <FormCard>
        <form action={loggingFormAction}>
          <VStack gap={3}>
            {loggingState?.message && (
              <StatusAlert message={loggingState.message} success={loggingState.success} />
            )}
            <Switch
              label={t("enableAccessLogging")}
              htmlName="enabled"
              value={enabled}
              onChange={setEnabled}
            />
            <Selector
              label={t("format")}
              htmlName="format"
              // JSON is the format's name, not a description of it.
              options={[
                { value: "json", label: "JSON" },
                { value: "console", label: t("logFormatConsole") },
              ]}
              value={format}
              onChange={setFormat}
              width={280}
            />
          </VStack>
        </form>
      </FormCard>
      <InfoAlert title={t("accessLogsInfoTitle")}>{t("accessLogsCommand")}</InfoAlert>
    </>
  );
}
