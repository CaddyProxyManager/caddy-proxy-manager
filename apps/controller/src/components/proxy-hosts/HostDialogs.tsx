"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Selector } from "@astryxdesign/core/Selector";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";
import {
  createProxyHostAction,
  deleteProxyHostAction,
  updateProxyHostAction,
} from "@/src/app/(dashboard)/proxy-hosts/actions";
import { INITIAL_ACTION_STATE } from "@/lib/errors/action-error";
import type { AccessList } from "@/lib/models/access-lists";
import type { CertificatePickerOption } from "@/lib/certificates/api";
import type { ProxyHost } from "@/lib/models/proxy-hosts";
import type { AuthentikSettings, ForwardAuthSettings } from "@/lib/settings";
import { AppDialog } from "@/components/ui/AppDialog";
import { AuthentikFields } from "./forward-auth/AuthentikFields";
import { ForwardAuthFields } from "./forward-auth/ForwardAuthFields";
import { DnsResolverFields } from "./upstreams/DnsResolverFields";
import { UpstreamTimeoutsFields } from "./upstreams/UpstreamTimeoutsFields";
import { LoadBalancerFields } from "./upstreams/LoadBalancerFields";
import { SettingsToggles } from "./SettingsToggles";
import { UpstreamDnsResolutionFields } from "./upstreams/UpstreamDnsResolutionFields";
import { UpstreamInput } from "./upstreams/UpstreamInput";
import { GeoBlockFields } from "./protection/GeoBlockFields";
import { WafFields } from "./waf/WafFields";
import { RateLimitFields } from "./protection/RateLimitFields";
import { AnubisFields } from "./protection/AnubisFields";
import { CrowdSecFields } from "./protection/CrowdSecFields";
import { MtlsFields } from "./protection/MtlsConfig";
import { CpmForwardAuthFields } from "./forward-auth/CpmForwardAuthFields";
import { TailscaleFields, type TailscaleHostDefaults } from "./TailscaleFields";
import { RedirectsFields } from "./routing/RedirectsFields";
import { LocationRulesFields } from "./routing/LocationRulesFields";
import { RewriteFields } from "./routing/RewriteFields";
import { PathAllowsFields } from "./routing/PathAllowsFields";
import { PathBlocksFields } from "./routing/PathBlocksFields";
import { PathRewritesFields } from "./routing/PathRewritesFields";
import { ErrorPagesFields } from "./routing/ErrorPagesFields";
import { AdvancedConfigFields } from "./AdvancedConfigFields";
import { CacheFields } from "./CacheFields";
import { MaintenanceFields } from "./MaintenanceFields";
import type { CaCertificate } from "@/lib/models/ca-certificates";
import type { MtlsRole } from "@/lib/models/mtls-roles";
import type { IssuedClientCertificate } from "@/lib/models/issued-client-certificates";
import { AgentAssignmentFields, type AgentOption } from "@/components/agents/AgentAssignmentFields";
import { NO_SPELLCHECK } from "@/components/ui/native-input-attrs";
import { useTranslations } from "next-intl";
import { HostNotesField } from "./HostNotesField";

type ForwardAuthUser = { id: number; email: string; name: string | null; role: string };
type ForwardAuthGroup = {
  id: number;
  name: string;
  description: string | null;
  member_count: number;
};
type ForwardAuthAccessData = { userIds: number[]; groupIds: number[] };

export const NONE_VALUE = "__none__";

/** Keyed on status alone: `onClose` is new each render and would re-arm an uncleared timer. */
function useCloseOnSuccess(state: { status: string }, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (state.status !== "success") return;
    const timer = setTimeout(() => onCloseRef.current(), 1000);
    return () => clearTimeout(timer);
  }, [state.status]);
}

function ActionStatus({ status, message }: { status: string; message?: string }) {
  if (status === "idle" || !message) return null;
  return <Banner status={status === "error" ? "error" : "success"} title={message} />;
}

export function toOptions(items: { id: number; name: string }[], noneLabel: string) {
  return [
    { value: NONE_VALUE, label: noneLabel },
    ...items.map((item) => ({ value: String(item.id), label: item.name })),
  ];
}

type ProxyHostsT = ReturnType<typeof useTranslations<"proxyHosts">>;

/** A list with neither users nor IP rules admits nobody. */
export function accessListIsEmpty(list: Pick<AccessList, "entries" | "ipRules">): boolean {
  return list.entries.length === 0 && (list.ipRules?.length ?? 0) === 0;
}

/** Names the empty ones: picking one closes the host rather than guarding it. */
export function accessListOptions(accessLists: AccessList[], t: ProxyHostsT) {
  return toOptions(
    accessLists.map((list) => ({
      id: list.id,
      name: accessListIsEmpty(list) ? t("accessListNoMembers", { name: list.name }) : list.name,
    })),
    t("none"),
  );
}

export function accessListStatus(accessLists: AccessList[], accessListId: string, t: ProxyHostsT) {
  const chosen = accessLists.find((list) => String(list.id) === accessListId);
  return chosen && accessListIsEmpty(chosen)
    ? { type: "warning" as const, message: t("accessListEmptyWarning") }
    : undefined;
}

export function CreateHostDialog({
  open,
  onClose,
  certificates,
  accessLists,
  authentikDefaults,
  forwardAuthDefaults,
  defaultDomain,
  initialData,
  caCertificates = [],
  mtlsRoles = [],
  issuedClientCerts = [],
  forwardAuthUsers = [],
  forwardAuthGroups = [],
  agents = [],
  tailscaleDefaults,
}: {
  open: boolean;
  onClose: () => void;
  certificates: CertificatePickerOption[];
  accessLists: AccessList[];
  authentikDefaults: AuthentikSettings | null;
  forwardAuthDefaults: ForwardAuthSettings | null;
  tailscaleDefaults?: TailscaleHostDefaults | null;
  /** Prefilled for a new host only: a duplicate carries the domains the operator came to change. */
  defaultDomain?: string;
  initialData?: ProxyHost | null;
  caCertificates?: CaCertificate[];
  mtlsRoles?: MtlsRole[];
  issuedClientCerts?: IssuedClientCertificate[];
  forwardAuthUsers?: ForwardAuthUser[];
  forwardAuthGroups?: ForwardAuthGroup[];
  agents?: AgentOption[];
}) {
  const t = useTranslations("proxyHosts");
  const [state, formAction] = useActionState(createProxyHostAction, INITIAL_ACTION_STATE);

  const [name, setName] = useState(initialData ? t("copyName", { name: initialData.name }) : "");
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [domains, setDomains] = useState(initialData?.domains.join("\n") ?? defaultDomain ?? "");
  const [certificateId, setCertificateId] = useState(
    String(initialData?.certificateId ?? NONE_VALUE),
  );
  const [accessListId, setAccessListId] = useState(String(initialData?.accessListId ?? NONE_VALUE));

  useCloseOnSuccess(state, onClose);

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={initialData ? t("duplicateProxyHost") : t("createProxyHost")}
      maxWidth="lg"
      submitLabel={t("create")}
      onSubmit={() => {
        (document.getElementById("create-host-form") as HTMLFormElement)?.requestSubmit();
      }}
    >
      <form id="create-host-form" action={formAction}>
        <VStack gap={5}>
          <ActionStatus status={state.status} message={state.message} />
          <SettingsToggles
            sslForced={initialData?.sslForced}
            hstsEnabled={initialData?.hstsEnabled}
            hstsSubdomains={initialData?.hstsSubdomains}
            allowWebsocket={initialData?.allowWebsocket}
            preserveHostHeader={initialData?.preserveHostHeader}
            skipHttpsValidation={initialData?.skipHttpsHostnameValidation}
            compression={initialData?.compression}
            discourageIndexing={initialData?.discourageIndexing}
            enabled={true}
          />
          <TextInput
            label={t("name")}
            htmlName="name"
            placeholder={t("namePlaceholder")}
            value={name}
            onChange={setName}
            isRequired
          />
          <HostNotesField value={description} onChange={setDescription} />
          <TextArea
            {...NO_SPELLCHECK}
            label={t("domains")}
            htmlName="domains"
            placeholder="app.example.com"
            value={domains}
            onChange={setDomains}
            isRequired
            rows={2}
            description={t("domainsHelp")}
          />
          <UpstreamInput defaultUpstreams={initialData?.upstreams} />
          <Selector
            label={t("certificate")}
            htmlName="certificateId"
            options={toOptions(certificates, t("managedByCaddyAuto"))}
            value={certificateId}
            onChange={(next) => setCertificateId(next as string)}
          />
          <Selector
            label={t("accessList")}
            htmlName="accessListId"
            options={accessListOptions(accessLists, t)}
            value={accessListId}
            onChange={(next) => setAccessListId(next as string)}
            status={accessListStatus(accessLists, accessListId, t)}
          />
          <AgentAssignmentFields agents={agents} selected={[]} />
          <RedirectsFields initialData={initialData?.redirects} />
          <LocationRulesFields initialData={initialData?.locationRules} accessLists={accessLists} />
          <RewriteFields initialData={initialData?.rewrite} />
          <PathAllowsFields initialData={initialData?.pathAllows} />
          <PathBlocksFields initialData={initialData?.pathBlocks} />
          <PathRewritesFields initialData={initialData?.pathRewrites} />
          <ErrorPagesFields initialData={initialData?.errorPages} />
          <CacheFields cache={initialData?.cache} />
          <MaintenanceFields maintenance={initialData?.maintenance} />
          <AdvancedConfigFields host={initialData} />
          <AuthentikFields defaults={authentikDefaults} authentik={initialData?.authentik} />
          <ForwardAuthFields
            defaults={forwardAuthDefaults}
            forwardAuth={initialData?.forwardAuth}
          />
          <CpmForwardAuthFields
            cpmForwardAuth={initialData?.cpmForwardAuth}
            users={forwardAuthUsers}
            groups={forwardAuthGroups}
          />
          <TailscaleFields tailscale={initialData?.tailscale} defaults={tailscaleDefaults} />
          <LoadBalancerFields loadBalancer={initialData?.loadBalancer} />
          <DnsResolverFields dnsResolver={initialData?.dnsResolver} />
          <UpstreamTimeoutsFields upstreamTimeouts={initialData?.upstreamTimeouts} />
          <UpstreamDnsResolutionFields upstreamDnsResolution={initialData?.upstreamDnsResolution} />
          <RateLimitFields rateLimit={initialData?.rateLimit} />
          <GeoBlockFields />
          <CrowdSecFields enabled={initialData?.crowdsec} />
          <AnubisFields anubis={initialData?.anubis} />
          <WafFields value={initialData?.waf} />
          <MtlsFields
            value={initialData?.mtls}
            caCertificates={caCertificates}
            mtlsRoles={mtlsRoles}
            issuedClientCerts={issuedClientCerts}
          />
        </VStack>
      </form>
    </AppDialog>
  );
}

export function EditHostDialog({
  open,
  host,
  onClose,
  certificates,
  accessLists,
  authentikDefaults,
  forwardAuthDefaults,
  caCertificates = [],
  mtlsRoles = [],
  issuedClientCerts = [],
  forwardAuthUsers = [],
  forwardAuthGroups = [],
  forwardAuthAccess,
  agents = [],
  assignedAgentIds = [],
  tailscaleDefaults,
  canEditRawConfig = false,
}: {
  open: boolean;
  host: ProxyHost;
  onClose: () => void;
  /** Admins only. Omitted rather than disabled, so the save leaves an admin's snippet untouched. */
  canEditRawConfig?: boolean;
  certificates: CertificatePickerOption[];
  accessLists: AccessList[];
  // Required, matching CreateHostDialog - see AuthentikFields (#232).
  authentikDefaults: AuthentikSettings | null;
  forwardAuthDefaults: ForwardAuthSettings | null;
  caCertificates?: CaCertificate[];
  mtlsRoles?: MtlsRole[];
  issuedClientCerts?: IssuedClientCertificate[];
  forwardAuthUsers?: ForwardAuthUser[];
  forwardAuthGroups?: ForwardAuthGroup[];
  forwardAuthAccess?: ForwardAuthAccessData | null;
  agents?: AgentOption[];
  assignedAgentIds?: number[];
  tailscaleDefaults?: TailscaleHostDefaults | null;
}) {
  const t = useTranslations("proxyHosts");
  const [state, formAction] = useActionState(
    updateProxyHostAction.bind(null, host.id),
    INITIAL_ACTION_STATE,
  );

  const [name, setName] = useState(host.name);
  const [description, setDescription] = useState(host.description ?? "");
  const [domains, setDomains] = useState(host.domains.join("\n"));
  const [certificateId, setCertificateId] = useState(String(host.certificateId ?? NONE_VALUE));
  const [accessListId, setAccessListId] = useState(String(host.accessListId ?? NONE_VALUE));

  useCloseOnSuccess(state, onClose);

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={t("editProxyHost")}
      maxWidth="lg"
      submitLabel={t("saveChanges")}
      onSubmit={() => {
        (document.getElementById("edit-host-form") as HTMLFormElement)?.requestSubmit();
      }}
    >
      <form id="edit-host-form" action={formAction}>
        <VStack gap={5}>
          <ActionStatus status={state.status} message={state.message} />
          <SettingsToggles
            sslForced={host.sslForced}
            hstsEnabled={host.hstsEnabled}
            hstsSubdomains={host.hstsSubdomains}
            allowWebsocket={host.allowWebsocket}
            preserveHostHeader={host.preserveHostHeader}
            skipHttpsValidation={host.skipHttpsHostnameValidation}
            compression={host.compression}
            discourageIndexing={host.discourageIndexing}
            enabled={host.enabled}
          />
          <TextInput label={t("name")} htmlName="name" value={name} onChange={setName} isRequired />
          <HostNotesField value={description} onChange={setDescription} />
          <TextArea
            {...NO_SPELLCHECK}
            label={t("domains")}
            htmlName="domains"
            value={domains}
            onChange={setDomains}
            rows={2}
            description={t("domainsHelp")}
          />
          <UpstreamInput defaultUpstreams={host.upstreams} />
          <Selector
            label={t("certificate")}
            htmlName="certificateId"
            options={toOptions(certificates, t("managedByCaddyAuto"))}
            value={certificateId}
            onChange={(next) => setCertificateId(next as string)}
          />
          <Selector
            label={t("accessList")}
            htmlName="accessListId"
            options={accessListOptions(accessLists, t)}
            value={accessListId}
            onChange={(next) => setAccessListId(next as string)}
            status={accessListStatus(accessLists, accessListId, t)}
          />
          <AgentAssignmentFields agents={agents} selected={assignedAgentIds} />
          <RedirectsFields initialData={host.redirects} />
          <LocationRulesFields initialData={host.locationRules} accessLists={accessLists} />
          <RewriteFields initialData={host.rewrite} />
          <PathAllowsFields initialData={host.pathAllows} />
          <PathBlocksFields initialData={host.pathBlocks} />
          <PathRewritesFields initialData={host.pathRewrites} />
          <ErrorPagesFields initialData={host.errorPages} />
          <CacheFields cache={host.cache} />
          <MaintenanceFields maintenance={host.maintenance} />
          {canEditRawConfig && <AdvancedConfigFields host={host} />}
          <AuthentikFields authentik={host.authentik} defaults={authentikDefaults} />
          <ForwardAuthFields forwardAuth={host.forwardAuth} defaults={forwardAuthDefaults} />
          <CpmForwardAuthFields
            cpmForwardAuth={host.cpmForwardAuth}
            users={forwardAuthUsers}
            groups={forwardAuthGroups}
            currentAccess={forwardAuthAccess}
          />
          <TailscaleFields tailscale={host.tailscale} defaults={tailscaleDefaults} />
          <LoadBalancerFields loadBalancer={host.loadBalancer} />
          <DnsResolverFields dnsResolver={host.dnsResolver} />
          <UpstreamTimeoutsFields upstreamTimeouts={host.upstreamTimeouts} />
          <UpstreamDnsResolutionFields upstreamDnsResolution={host.upstreamDnsResolution} />
          <RateLimitFields rateLimit={host.rateLimit} />
          <GeoBlockFields
            initialValues={{
              geoblock: host.geoblock,
              geoblock_mode: host.geoblockMode,
            }}
          />
          <CrowdSecFields enabled={host.crowdsec} />
          <AnubisFields anubis={host.anubis} />
          <WafFields value={host.waf} />
          <MtlsFields
            value={host.mtls}
            caCertificates={caCertificates}
            proxyHostId={host.id}
            mtlsRoles={mtlsRoles}
            issuedClientCerts={issuedClientCerts}
          />
        </VStack>
      </form>
    </AppDialog>
  );
}

export function DeleteHostDialog({
  open,
  host,
  onClose,
}: {
  open: boolean;
  host: ProxyHost;
  onClose: () => void;
}) {
  const t = useTranslations("proxyHosts");
  const [state, formAction] = useActionState(
    deleteProxyHostAction.bind(null, host.id),
    INITIAL_ACTION_STATE,
  );

  useCloseOnSuccess(state, onClose);

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={t("deleteProxyHost")}
      maxWidth="sm"
      submitLabel={t("delete")}
      onSubmit={() => {
        (document.getElementById("delete-host-form") as HTMLFormElement)?.requestSubmit();
      }}
    >
      <form id="delete-host-form" action={formAction}>
        <VStack gap={4}>
          <ActionStatus status={state.status} message={state.message} />
          <Text type="body" size="sm">
            {t.rich("deleteConfirm", {
              name: host.name,
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </Text>
          <VStack gap={1}>
            <Text type="body" size="sm" color="secondary">
              {t("deleteDescription")}
            </Text>
            <Text type="body" size="sm" color="secondary">
              {t("deleteDomainsLine", { domains: host.domains.join(", ") })}
            </Text>
            <Text type="body" size="sm" color="secondary">
              {t("deleteUpstreamsLine", { upstreams: host.upstreams.join(", ") })}
            </Text>
          </VStack>
          <Banner status="warning" title={t("deleteWarning")} />
        </VStack>
      </form>
    </AppDialog>
  );
}
