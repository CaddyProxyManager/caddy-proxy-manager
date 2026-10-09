"use client";

/**
 * The edit dialog's fields and names, read by the same parser. CPM forward auth and mTLS access
 * rules are left out: their grants are keyed by a host id this host lacks.
 */
import { useState } from "react";
import { Selector } from "@astryxdesign/core/Selector";
import { VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import type { AccessList } from "@/lib/models/access-lists";
import type { CaCertificate } from "@/lib/models/ca-certificates";
import type { IssuedClientCertificate } from "@/lib/models/issued-client-certificates";
import type { MtlsRole } from "@/lib/models/mtls-roles";
import type { CertificatePickerOption } from "@/lib/certificates/api";
import type { DashboardHostFormView } from "@/lib/dashboard-host/options";
import type { AuthentikSettings, ForwardAuthSettings } from "@/lib/settings";
import { AgentAssignmentFields, type AgentOption } from "@/components/agents/AgentAssignmentFields";
import { AdvancedConfigFields } from "./AdvancedConfigFields";
import { AuthentikFields } from "./forward-auth/AuthentikFields";
import { ForwardAuthFields } from "./forward-auth/ForwardAuthFields";
import { DnsResolverFields } from "./upstreams/DnsResolverFields";
import { UpstreamTimeoutsFields } from "./upstreams/UpstreamTimeoutsFields";
import { ErrorPagesFields } from "./routing/ErrorPagesFields";
import { GeoBlockFields } from "./protection/GeoBlockFields";
import { accessListOptions, accessListStatus, NONE_VALUE, toOptions } from "./host-pickers";
import { LoadBalancerFields } from "./upstreams/LoadBalancerFields";
import { LocationRulesFields } from "./routing/LocationRulesFields";
import { MtlsFields } from "./protection/MtlsConfig";
import { PathAllowsFields } from "./routing/PathAllowsFields";
import { PathBlocksFields } from "./routing/PathBlocksFields";
import { PathRewritesFields } from "./routing/PathRewritesFields";
import { RedirectsFields } from "./routing/RedirectsFields";
import { RewriteFields } from "./routing/RewriteFields";
import { SettingsToggles } from "./SettingsToggles";
import { TailscaleFields, type TailscaleHostDefaults } from "./TailscaleFields";
import { UpstreamDnsResolutionFields } from "./upstreams/UpstreamDnsResolutionFields";
import { WafFields } from "./waf/WafFields";
import { RateLimitFields } from "./protection/RateLimitFields";
import { CrowdSecFields } from "./protection/CrowdSecFields";
import {
  type WafPluginOption,
  type WafPresetOption,
  WafPresetOptionsProvider,
} from "./waf/WafPresetOptions";

export type DashboardHostOptionsData = {
  view: DashboardHostFormView;
  certificates: CertificatePickerOption[];
  accessLists: AccessList[];
  authentikDefaults: AuthentikSettings | null;
  forwardAuthDefaults: ForwardAuthSettings | null;
  caCertificates: CaCertificate[];
  mtlsRoles: MtlsRole[];
  issuedClientCerts: IssuedClientCertificate[];
  agents: AgentOption[];
  tailscaleDefaults: TailscaleHostDefaults;
  wafPresets: WafPresetOption[];
  wafPlugins: WafPluginOption[];
};

export function DashboardHostOptionsFields({ data }: { data: DashboardHostOptionsData }) {
  const t = useTranslations("proxyHosts");
  const { view } = data;
  const [certificateId, setCertificateId] = useState(String(view.certificateId ?? NONE_VALUE));
  const [accessListId, setAccessListId] = useState(String(view.accessListId ?? NONE_VALUE));

  return (
    <VStack gap={5}>
      {/* So a form without the options keeps them. */}
      <input type="hidden" name="dashboardOptionsPresent" value="1" />
      <SettingsToggles
        showEnabled={false}
        hstsSubdomains={view.hstsSubdomains}
        skipHttpsValidation={view.skipHttpsHostnameValidation}
        skipAccessLog={view.skipAccessLog}
      />
      <Selector
        label={t("certificate")}
        htmlName="certificateId"
        options={toOptions(data.certificates, t("managedByCaddyAuto"))}
        value={certificateId}
        onChange={(next) => setCertificateId(next as string)}
      />
      <Selector
        label={t("accessList")}
        htmlName="accessListId"
        options={accessListOptions(data.accessLists, t)}
        value={accessListId}
        onChange={(next) => setAccessListId(next as string)}
        status={accessListStatus(data.accessLists, accessListId, t)}
      />
      <AgentAssignmentFields agents={data.agents} selected={view.agentIds} />
      <RedirectsFields initialData={view.redirects} />
      <LocationRulesFields initialData={view.locationRules} accessLists={data.accessLists} />
      <RewriteFields initialData={view.rewrite} />
      <PathAllowsFields initialData={view.pathAllows} />
      <PathBlocksFields initialData={view.pathBlocks} />
      <PathRewritesFields initialData={view.pathRewrites} />
      <ErrorPagesFields initialData={view.errorPages} />
      {/* The settings page is admin-only, which is who may edit raw config. */}
      <AdvancedConfigFields host={view} />
      <AuthentikFields authentik={view.authentik} defaults={data.authentikDefaults} />
      <ForwardAuthFields forwardAuth={view.forwardAuth} defaults={data.forwardAuthDefaults} />
      <TailscaleFields tailscale={view.tailscale} defaults={data.tailscaleDefaults} />
      <LoadBalancerFields loadBalancer={view.loadBalancer} />
      <DnsResolverFields dnsResolver={view.dnsResolver} />
      <UpstreamTimeoutsFields upstreamTimeouts={view.upstreamTimeouts} />
      <UpstreamDnsResolutionFields upstreamDnsResolution={view.upstreamDnsResolution} />
      <RateLimitFields rateLimit={view.rateLimit} hasModes={false} />
      <GeoBlockFields
        initialValues={{
          geoblock: view.geoblock,
          geoblock_mode: view.geoblockMode,
        }}
      />
      <CrowdSecFields enabled={view.crowdsec} />
      <WafPresetOptionsProvider presets={data.wafPresets} plugins={data.wafPlugins}>
        <WafFields value={view.waf} />
      </WafPresetOptionsProvider>
      <MtlsFields
        value={view.mtls}
        caCertificates={data.caCertificates}
        mtlsRoles={data.mtlsRoles}
        issuedClientCerts={data.issuedClientCerts}
      />
    </VStack>
  );
}
