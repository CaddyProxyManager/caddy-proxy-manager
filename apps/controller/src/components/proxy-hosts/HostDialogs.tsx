"use client";

import { type EditorRollback, RollbackNotice } from "@/components/host-history/RollbackNotice";
import { useActionState, useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Selector } from "@astryxdesign/core/Selector";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";
import {
  createProxyHostAction,
  deleteProxyHostAction,
  previewProxyHostAction,
  updateProxyHostAction,
} from "@/src/app/(dashboard)/proxy-hosts/actions";
import { INITIAL_ACTION_STATE } from "@/lib/errors/action-error";
import type { AccessList } from "@/lib/models/access-lists";
import type { CertificatePickerOption } from "@/lib/certificates/api";
import type { ProxyHost } from "@/lib/models/proxy-hosts";
import type { AuthentikSettings, ForwardAuthSettings } from "@/lib/settings";
import type { ProxyHostDefaults } from "@/lib/proxy-hosts/host-defaults";
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
import { HostTagsField } from "./HostTagsField";
import { UpstreamHealthPanel } from "./upstreams/UpstreamHealthPanel";
import { NONE_VALUE, accessListOptions, accessListStatus, toOptions } from "./host-pickers";
import {
  EDITOR_SECTIONS,
  type EditorSection,
  editorSectionAnchor,
} from "@/lib/proxy-hosts/editor-sections";
import { HostEditorShell } from "@/components/host-review/HostEditorShell";
import { useCloseOnSuccess } from "@/components/host-review/useCloseOnSuccess";
import { linkEditorSection } from "@/components/host-review/section-link";

type ForwardAuthUser = { id: number; email: string; name: string | null; role: string };
type ForwardAuthGroup = {
  id: number;
  name: string;
  description: string | null;
  member_count: number;
};
type ForwardAuthAccessData = { userIds: number[]; groupIds: number[] };

function ActionStatus({ status, message }: { status: string; message?: string }) {
  if (status === "idle" || !message) return null;
  return <Banner status={status === "error" ? "error" : "success"} title={message} />;
}

/** The create dialog's anchors differ: it stays mounted beside an open editor. */
function sectionLinks(prefix: string) {
  return EDITOR_SECTIONS.map((id) => ({ id, anchor: `${prefix}${editorSectionAnchor(id)}` }));
}

export function CreateHostDialog({
  open,
  onClose,
  certificates,
  accessLists,
  authentikDefaults,
  forwardAuthDefaults,
  defaultDomain,
  hostDefaults,
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
  /** Prefilled for a new host only; a duplicate starts with none, as two hosts cannot share one. */
  defaultDomain?: string;
  /** Settings' host defaults, for a new host only: a duplicate keeps its source's values. */
  hostDefaults?: ProxyHostDefaults | null;
  initialData?: ProxyHost | null;
  caCertificates?: CaCertificate[];
  mtlsRoles?: MtlsRole[];
  issuedClientCerts?: IssuedClientCertificate[];
  forwardAuthUsers?: ForwardAuthUser[];
  forwardAuthGroups?: ForwardAuthGroup[];
  agents?: AgentOption[];
}) {
  const t = useTranslations("proxyHosts");
  const tCommon = useTranslations("common");
  const [state, formAction, isPending] = useActionState(
    createProxyHostAction,
    INITIAL_ACTION_STATE,
  );

  const [name, setName] = useState(
    initialData ? tCommon("copyName", { name: initialData.name }) : "",
  );
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [domains, setDomains] = useState(initialData ? "" : (defaultDomain ?? ""));
  const [certificateId, setCertificateId] = useState(
    String(initialData?.certificateId ?? NONE_VALUE),
  );
  const [accessListId, setAccessListId] = useState(String(initialData?.accessListId ?? NONE_VALUE));
  const preset = initialData ? null : hostDefaults;

  useCloseOnSuccess(state, onClose);
  const anchor = (section: EditorSection) => `create-${editorSectionAnchor(section)}`;

  return (
    <HostEditorShell
      open={open}
      onClose={onClose}
      title={initialData ? t("duplicateProxyHost") : t("createProxyHost")}
      kind="http"
      isCreate
      formId="create-host-form"
      state={state}
      isPending={isPending}
      preview={(data) => previewProxyHostAction(null, data)}
      sections={sectionLinks("create-")}
    >
      <form id="create-host-form" action={formAction}>
        <VStack gap={5}>
          <ActionStatus status={state.status} message={state.message} />
          <VStack gap={5} id={anchor("general")}>
            <SettingsToggles part="enabled" enabled={true} />
            <TextInput
              label={tCommon("name")}
              htmlName="name"
              placeholder={t("namePlaceholder")}
              value={name}
              onChange={setName}
              isRequired
            />
            <HostNotesField value={description} onChange={setDescription} />
            <HostTagsField initial={initialData?.tags} />
            <TextArea
              {...NO_SPELLCHECK}
              label={tCommon("domains")}
              htmlName="domains"
              placeholder="app.example.com"
              value={domains}
              onChange={setDomains}
              isRequired
              rows={2}
              description={t("domainsHelp")}
            />
          </VStack>
          <VStack gap={5} id={anchor("upstreams")}>
            <UpstreamInput defaultUpstreams={initialData?.upstreams} />
            <SettingsToggles
              part="options"
              sslForced={initialData?.sslForced ?? preset?.sslForced}
              hstsEnabled={initialData?.hstsEnabled ?? preset?.hstsEnabled}
              hstsSubdomains={initialData?.hstsSubdomains ?? preset?.hstsSubdomains}
              allowWebsocket={initialData?.allowWebsocket ?? preset?.allowWebsocket}
              preserveHostHeader={initialData?.preserveHostHeader ?? preset?.preserveHostHeader}
              skipHttpsValidation={
                initialData?.skipHttpsHostnameValidation ?? preset?.skipHttpsValidation
              }
              compression={initialData?.compression ?? preset?.compression}
              discourageIndexing={initialData?.discourageIndexing ?? preset?.discourageIndexing}
              skipAccessLog={initialData?.skipAccessLog}
            />
            <LoadBalancerFields loadBalancer={initialData?.loadBalancer} />
            <DnsResolverFields dnsResolver={initialData?.dnsResolver} />
            <UpstreamTimeoutsFields upstreamTimeouts={initialData?.upstreamTimeouts} />
            <UpstreamDnsResolutionFields
              upstreamDnsResolution={initialData?.upstreamDnsResolution}
            />
          </VStack>
          <VStack gap={5} id={anchor("tls")}>
            <Selector
              label={t("certificate")}
              htmlName="certificateId"
              options={toOptions(certificates, t("managedByCaddyAuto"))}
              value={certificateId}
              onChange={(next) => setCertificateId(next as string)}
            />
            <MtlsFields
              value={initialData?.mtls}
              caCertificates={caCertificates}
              mtlsRoles={mtlsRoles}
              issuedClientCerts={issuedClientCerts}
            />
          </VStack>
          <VStack gap={5} id={anchor("access")}>
            <Selector
              label={t("accessList")}
              htmlName="accessListId"
              options={accessListOptions(accessLists, t)}
              value={accessListId}
              onChange={(next) => setAccessListId(next as string)}
              status={accessListStatus(accessLists, accessListId, t)}
            />
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
          </VStack>
          <VStack gap={5} id={anchor("protection")}>
            <RateLimitFields rateLimit={initialData?.rateLimit} />
            <GeoBlockFields />
            <CrowdSecFields enabled={initialData?.crowdsec ?? preset?.crowdsecEnabled} />
            <AnubisFields anubis={initialData?.anubis} />
            <WafFields value={preset?.wafEnabled ? { enabled: true } : initialData?.waf} />
          </VStack>
          <VStack gap={5} id={anchor("routing")}>
            <RedirectsFields initialData={initialData?.redirects} />
            <LocationRulesFields
              initialData={initialData?.locationRules}
              accessLists={accessLists}
            />
            <RewriteFields initialData={initialData?.rewrite} />
            <PathAllowsFields initialData={initialData?.pathAllows} />
            <PathBlocksFields initialData={initialData?.pathBlocks} />
            <PathRewritesFields initialData={initialData?.pathRewrites} />
            <ErrorPagesFields initialData={initialData?.errorPages} />
          </VStack>
          <VStack gap={5} id={anchor("advanced")}>
            <AgentAssignmentFields agents={agents} selected={[]} />
            <CacheFields cache={initialData?.cache} />
            <MaintenanceFields maintenance={initialData?.maintenance} />
            <AdvancedConfigFields host={initialData} />
          </VStack>
        </VStack>
      </form>
    </HostEditorShell>
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
  initialSection = null,
  rollback = null,
}: {
  open: boolean;
  host: ProxyHost;
  onClose: () => void;
  /** The editor holds this revision rather than the stored host. */
  rollback?: EditorRollback | null;
  /** Scrolled to on open, from a section link on the host's page. */
  initialSection?: EditorSection | null;
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
  const tCommon = useTranslations("common");
  const [state, formAction, isPending] = useActionState(
    updateProxyHostAction.bind(null, host.id),
    INITIAL_ACTION_STATE,
  );

  const [name, setName] = useState(host.name);
  const [description, setDescription] = useState(host.description ?? "");
  const [domains, setDomains] = useState(host.domains.join("\n"));
  const [certificateId, setCertificateId] = useState(String(host.certificateId ?? NONE_VALUE));
  const [accessListId, setAccessListId] = useState(String(host.accessListId ?? NONE_VALUE));

  useCloseOnSuccess(state, onClose);

  // After the dialog has laid out; the anchor is inside it.
  useEffect(() => {
    if (!open || !initialSection) return;
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(editorSectionAnchor(initialSection))
        ?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, initialSection]);

  return (
    <HostEditorShell
      open={open}
      onClose={onClose}
      title={t("editProxyHost")}
      kind="http"
      isCreate={false}
      formId="edit-host-form"
      state={state}
      isPending={isPending}
      preview={(data) => previewProxyHostAction(host.id, data)}
      sections={sectionLinks("")}
      onSectionLink={(section) => linkEditorSection(host.uuid, section)}
    >
      <form id="edit-host-form" action={formAction}>
        {/* Grouped by the sections the host's page links to (lib/proxy-hosts/editor-sections). */}
        <VStack gap={5}>
          <ActionStatus status={state.status} message={state.message} />
          {rollback && <RollbackNotice rollback={rollback} />}
          <VStack gap={5} id={editorSectionAnchor("general")}>
            <SettingsToggles part="enabled" enabled={host.enabled} />
            <TextInput
              label={tCommon("name")}
              htmlName="name"
              value={name}
              onChange={setName}
              isRequired
            />
            <HostNotesField value={description} onChange={setDescription} />
            <HostTagsField initial={host.tags} />
            <TextArea
              {...NO_SPELLCHECK}
              label={tCommon("domains")}
              htmlName="domains"
              value={domains}
              onChange={setDomains}
              rows={2}
              description={t("domainsHelp")}
            />
          </VStack>
          <VStack gap={5} id={editorSectionAnchor("upstreams")}>
            <UpstreamInput defaultUpstreams={host.upstreams} />
            <SettingsToggles
              part="options"
              sslForced={host.sslForced}
              hstsEnabled={host.hstsEnabled}
              hstsSubdomains={host.hstsSubdomains}
              allowWebsocket={host.allowWebsocket}
              preserveHostHeader={host.preserveHostHeader}
              skipHttpsValidation={host.skipHttpsHostnameValidation}
              compression={host.compression}
              discourageIndexing={host.discourageIndexing}
              skipAccessLog={host.skipAccessLog}
            />
            <UpstreamHealthPanel hostId={host.id} />
            <LoadBalancerFields loadBalancer={host.loadBalancer} />
            <DnsResolverFields dnsResolver={host.dnsResolver} />
            <UpstreamTimeoutsFields upstreamTimeouts={host.upstreamTimeouts} />
            <UpstreamDnsResolutionFields upstreamDnsResolution={host.upstreamDnsResolution} />
          </VStack>
          <VStack gap={5} id={editorSectionAnchor("tls")}>
            <Selector
              label={t("certificate")}
              htmlName="certificateId"
              options={toOptions(certificates, t("managedByCaddyAuto"))}
              value={certificateId}
              onChange={(next) => setCertificateId(next as string)}
            />
            <MtlsFields
              value={host.mtls}
              caCertificates={caCertificates}
              proxyHostUuid={host.uuid}
              mtlsRoles={mtlsRoles}
              issuedClientCerts={issuedClientCerts}
            />
          </VStack>
          <VStack gap={5} id={editorSectionAnchor("access")}>
            <Selector
              label={t("accessList")}
              htmlName="accessListId"
              options={accessListOptions(accessLists, t)}
              value={accessListId}
              onChange={(next) => setAccessListId(next as string)}
              status={accessListStatus(accessLists, accessListId, t)}
            />
            <AuthentikFields authentik={host.authentik} defaults={authentikDefaults} />
            <ForwardAuthFields forwardAuth={host.forwardAuth} defaults={forwardAuthDefaults} />
            <CpmForwardAuthFields
              cpmForwardAuth={host.cpmForwardAuth}
              users={forwardAuthUsers}
              groups={forwardAuthGroups}
              currentAccess={forwardAuthAccess}
            />
            <TailscaleFields tailscale={host.tailscale} defaults={tailscaleDefaults} />
          </VStack>
          <VStack gap={5} id={editorSectionAnchor("protection")}>
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
          </VStack>
          <VStack gap={5} id={editorSectionAnchor("routing")}>
            <RedirectsFields initialData={host.redirects} />
            <LocationRulesFields initialData={host.locationRules} accessLists={accessLists} />
            <RewriteFields initialData={host.rewrite} />
            <PathAllowsFields initialData={host.pathAllows} />
            <PathBlocksFields initialData={host.pathBlocks} />
            <PathRewritesFields initialData={host.pathRewrites} />
            <ErrorPagesFields initialData={host.errorPages} />
          </VStack>
          <VStack gap={5} id={editorSectionAnchor("advanced")}>
            <AgentAssignmentFields agents={agents} selected={assignedAgentIds} />
            <CacheFields cache={host.cache} />
            <MaintenanceFields maintenance={host.maintenance} />
            {canEditRawConfig && <AdvancedConfigFields host={host} />}
          </VStack>
        </VStack>
      </form>
    </HostEditorShell>
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
  const tCommon = useTranslations("common");
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
      submitLabel={tCommon("delete")}
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
