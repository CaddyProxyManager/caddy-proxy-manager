"use client";

import { type EditorRollback, RollbackNotice } from "@/components/host-history/RollbackNotice";
import { type ReactNode, useActionState, useEffect, useState } from "react";
import {
  createL4ProxyHostAction,
  deleteL4ProxyHostAction,
  previewL4ProxyHostAction,
  updateL4ProxyHostAction,
} from "@/src/app/(dashboard)/l4-proxy-hosts/actions";
import { HostEditorShell } from "@/components/host-review/HostEditorShell";
import { useCloseOnSuccess } from "@/components/host-review/useCloseOnSuccess";
import { linkEditorSection } from "@/components/host-review/section-link";
import {
  L4_EDITOR_SECTIONS,
  type L4EditorSection,
  l4EditorSectionAnchor,
} from "@/lib/l4/editor-sections";
import { INITIAL_ACTION_STATE } from "@/lib/errors/action-error";
import type { L4ProxyHost } from "@/lib/models/l4-proxy-hosts";
import type { L4ProxyHostDefaults } from "@/lib/proxy-hosts/host-defaults";
import type { L4AccessListOption } from "@/lib/models/access-lists";
import { AppDialog } from "@/components/ui/AppDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Icon } from "@astryxdesign/core/Icon";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { NATIVE_REQUIRED, NO_SPELLCHECK } from "@/components/ui/native-input-attrs";
import { Clock, Earth, Globe, Layers, MapPin, Network, Pin, ShieldBan } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import { AgentAssignmentFields, type AgentOption } from "@/components/agents/AgentAssignmentFields";
import { HostNotesField } from "@/components/proxy-hosts/HostNotesField";
import { HostTagsField } from "@/components/proxy-hosts/HostTagsField";
import { useTranslations } from "next-intl";

type Translator = ReturnType<typeof useTranslations<"l4ProxyHosts">>;

function l4SectionLinks(prefix: string) {
  return L4_EDITOR_SECTIONS.map((id) => ({ id, anchor: `${prefix}${l4EditorSectionAnchor(id)}` }));
}

const PROTOCOL_OPTIONS = [
  { value: "tcp", label: "TCP" },
  { value: "udp", label: "UDP" },
];

function matcherOptions(t: Translator) {
  return [
    { value: "none", label: t("optMatcherNone") },
    { value: "tls_sni", label: t("optMatcherTlsSni") },
    { value: "http_host", label: t("optMatcherHttpHost") },
    { value: "proxy_protocol", label: t("optMatcherProxyProtocol") },
  ];
}

function proxyProtocolOptions(t: Translator) {
  return [
    { value: "__none__", label: t("optProxyProtocolNone") },
    // Version identifiers, not prose - nothing to translate.
    { value: "v1", label: "v1" },
    { value: "v2", label: "v2" },
  ];
}

/**
 * What `layer4.proxy.selection_policies.*` registers, checked against the shipped binary: no
 * request-reading policies, since layer 4 has only a connection.
 */
function lbPolicyOptions(t: ReturnType<typeof useTranslations<"proxyHosts">>) {
  return [
    { value: "random", label: t("lbPolicyRandom") },
    { value: "random_choose", label: t("lbPolicyRandomChoose") },
    { value: "round_robin", label: t("lbPolicyRoundRobin") },
    { value: "weighted_round_robin", label: t("lbPolicyWeightedRoundRobin") },
    { value: "least_conn", label: t("lbPolicyLeastConn") },
    { value: "ip_hash", label: t("lbPolicyIpHash") },
    { value: "first", label: t("lbPolicyFirst") },
  ];
}

const NO_ACCESS_LIST = "__none__";

/** A list with no IP rules has nothing that applies here; the host's own stays so it can be seen. */
function accessListOptions(t: Translator, lists: L4AccessListOption[], currentId: number | null) {
  return [
    { value: NO_ACCESS_LIST, label: t("accessListNone") },
    ...lists
      .filter((list) => list.ipRuleCount > 0 || list.id === currentId)
      .map((list) => ({
        value: String(list.id),
        label: t("accessListOption", { name: list.name, count: list.ipRuleCount }),
      })),
  ];
}

function geoblockModeOptions(t: Translator) {
  return [
    { value: "merge", label: t("optGeoblockMerge") },
    { value: "override", label: t("optGeoblockOverride") },
  ];
}

function upstreamDnsModeOptions(t: Translator) {
  return [
    { value: "inherit", label: t("optDnsFamilyInherit") },
    { value: "enabled", label: t("optDnsEnabled") },
    { value: "disabled", label: t("optDnsDisabled") },
  ];
}

function upstreamDnsFamilyOptions(t: Translator) {
  return [
    { value: "inherit", label: t("optDnsFamilyInherit") },
    { value: "both", label: t("optDnsFamilyBoth") },
    { value: "ipv6", label: t("optDnsFamilyIpv6") },
    { value: "ipv4", label: t("optDnsFamilyIpv4") },
  ];
}

function Section({
  icon,
  title,
  defaultIsOpen,
  children,
}: {
  icon: LucideIcon;
  title: string;
  defaultIsOpen: boolean;
  children: ReactNode;
}) {
  return (
    <Card padding={3}>
      <Collapsible
        defaultIsOpen={defaultIsOpen}
        trigger={
          <HStack gap={2} vAlign="center">
            <Icon icon={icon} />
            <Text type="label" size="lg">
              {title}
            </Text>
          </HStack>
        }
      >
        <VStack gap={3}>{children}</VStack>
      </Collapsible>
    </Card>
  );
}

/** Keyed by form field name. */
type TextFields = {
  name: string;
  description: string;
  listenAddress: string;
  upstreams: string;
  matcherValue: string;
  lbPolicyChoose: string;
  lbPolicyWeights: string;
  lbTryDuration: string;
  lbTryInterval: string;
  lbActiveHealthPort: string;
  lbActiveHealthInterval: string;
  lbActiveHealthTimeout: string;
  lbPassiveHealthFailDuration: string;
  lbPassiveHealthMaxFails: string;
  dnsResolvers: string;
  dnsFallbacks: string;
  dnsTimeout: string;
  geoblockBlockCountries: string;
  geoblockBlockContinents: string;
  geoblockBlockAsns: string;
  geoblockBlockCidrs: string;
  geoblockBlockIps: string;
  geoblockAllowCountries: string;
  geoblockAllowContinents: string;
  geoblockAllowAsns: string;
  geoblockAllowCidrs: string;
  geoblockAllowIps: string;
};

function initialText(initialData?: L4ProxyHost | null): TextFields {
  const lb = initialData?.loadBalancer;
  const geo = initialData?.geoblock;
  return {
    name: initialData?.name ?? "",
    description: initialData?.description ?? "",
    listenAddress: initialData?.listenAddress ?? "",
    upstreams: initialData?.upstreams.join("\n") ?? "",
    matcherValue: initialData?.matcherValue?.join(", ") ?? "",
    lbPolicyChoose: lb?.policyChoose != null ? String(lb.policyChoose) : "",
    lbPolicyWeights: lb?.policyWeights?.join(", ") ?? "",
    lbTryDuration: lb?.tryDuration ?? "",
    lbTryInterval: lb?.tryInterval ?? "",
    lbActiveHealthPort:
      lb?.activeHealthCheck?.port != null ? String(lb.activeHealthCheck.port) : "",
    lbActiveHealthInterval: lb?.activeHealthCheck?.interval ?? "",
    lbActiveHealthTimeout: lb?.activeHealthCheck?.timeout ?? "",
    lbPassiveHealthFailDuration: lb?.passiveHealthCheck?.failDuration ?? "",
    lbPassiveHealthMaxFails:
      lb?.passiveHealthCheck?.maxFails != null ? String(lb.passiveHealthCheck.maxFails) : "",
    dnsResolvers: initialData?.dnsResolver?.resolvers?.join("\n") ?? "",
    dnsFallbacks: initialData?.dnsResolver?.fallbacks?.join("\n") ?? "",
    dnsTimeout: initialData?.dnsResolver?.timeout ?? "",
    geoblockBlockCountries: geo?.block_countries?.join(", ") ?? "",
    geoblockBlockContinents: geo?.block_continents?.join(", ") ?? "",
    geoblockBlockAsns: geo?.block_asns?.join(", ") ?? "",
    geoblockBlockCidrs: geo?.block_cidrs?.join(", ") ?? "",
    geoblockBlockIps: geo?.block_ips?.join(", ") ?? "",
    geoblockAllowCountries: geo?.allow_countries?.join(", ") ?? "",
    geoblockAllowContinents: geo?.allow_continents?.join(", ") ?? "",
    geoblockAllowAsns: geo?.allow_asns?.join(", ") ?? "",
    geoblockAllowCidrs: geo?.allow_cidrs?.join(", ") ?? "",
    geoblockAllowIps: geo?.allow_ips?.join(", ") ?? "",
  };
}

function L4HostForm({
  formId,
  formAction,
  state,
  initialData,
  defaults,
  agents = [],
  accessLists = [],
  assignedAgentIds = [],
  anchorPrefix = "",
}: {
  /** The create dialog's anchors differ: it stays mounted beside an open editor. */
  anchorPrefix?: string;
  formId: string;
  formAction: (formData: FormData) => void;
  state: { status: string; message?: string };
  initialData?: L4ProxyHost | null;
  /** Read only without initialData. */
  defaults?: L4ProxyHostDefaults | null;
  agents?: AgentOption[];
  accessLists?: L4AccessListOption[];
  assignedAgentIds?: number[];
}) {
  const t = useTranslations("l4ProxyHosts");
  const tSettings = useTranslations("settings");
  const tProxyHosts = useTranslations("proxyHosts");
  const tCommon = useTranslations("common");
  const anchor = (section: L4EditorSection) => `${anchorPrefix}${l4EditorSectionAnchor(section)}`;
  const [enabled, setEnabled] = useState(initialData?.enabled ?? true);
  const preset = initialData ? null : defaults;
  const [protocol, setProtocol] = useState(initialData?.protocol ?? preset?.protocol ?? "tcp");
  const [matcherType, setMatcherType] = useState(initialData?.matcherType ?? "none");
  const [samePort, setSamePort] = useState(initialData?.upstreamPortMode === "same");

  // Astryx inputs are controlled; one object rather than dozens of useStates.
  const [text, setText] = useState<TextFields>(() => initialText(initialData));
  const set =
    <K extends keyof TextFields>(key: K) =>
    (value: string) =>
      setText((prev) => ({ ...prev, [key]: value }));

  const [tlsTermination, setTlsTermination] = useState(
    initialData?.tlsTermination ?? preset?.tlsTermination ?? false,
  );
  const [proxyProtocolReceive, setProxyProtocolReceive] = useState(
    initialData?.proxyProtocolReceive ?? preset?.proxyProtocolReceive ?? false,
  );
  const [proxyProtocolVersion, setProxyProtocolVersion] = useState<string>(
    initialData?.proxyProtocolVersion ?? "__none__",
  );
  const [accessListId, setAccessListId] = useState<string>(
    initialData?.accessListId != null ? String(initialData.accessListId) : NO_ACCESS_LIST,
  );
  const [lbEnabled, setLbEnabled] = useState(initialData?.loadBalancer?.enabled ?? false);
  const [lbPolicy, setLbPolicy] = useState<string>(initialData?.loadBalancer?.policy ?? "random");
  const [lbActiveHealthEnabled, setLbActiveHealthEnabled] = useState(
    initialData?.loadBalancer?.activeHealthCheck?.enabled ?? false,
  );
  const [lbPassiveHealthEnabled, setLbPassiveHealthEnabled] = useState(
    initialData?.loadBalancer?.passiveHealthCheck?.enabled ?? false,
  );
  const [dnsEnabled, setDnsEnabled] = useState(initialData?.dnsResolver?.enabled ?? false);
  const [geoblockEnabled, setGeoblockEnabled] = useState(initialData?.geoblock?.enabled ?? false);
  const [crowdsecEnabled, setCrowdsecEnabled] = useState(
    initialData?.crowdsec ?? preset?.crowdsecEnabled ?? true,
  );
  const [geoblockMode, setGeoblockMode] = useState<string>(initialData?.geoblockMode ?? "merge");
  const [upstreamDnsMode, setUpstreamDnsMode] = useState(
    initialData?.upstreamDnsResolution?.enabled === true
      ? "enabled"
      : initialData?.upstreamDnsResolution?.enabled === false
        ? "disabled"
        : "inherit",
  );
  const [upstreamDnsFamily, setUpstreamDnsFamily] = useState<string>(
    initialData?.upstreamDnsResolution?.family ?? "inherit",
  );

  return (
    <form id={formId} action={formAction}>
      <VStack gap={5}>
        {state.status !== "idle" && state.message && (
          <Banner status={state.status === "error" ? "error" : "success"} title={state.message} />
        )}

        <VStack gap={5} id={anchor("general")}>
          <input type="hidden" name="enabledPresent" value="1" />
          {/* Empty, not "off": the parser reads anything but on/true/1 as false. */}
          <input type="hidden" name="enabled" value={enabled ? "on" : ""} />

          <Card variant={enabled ? "muted" : "default"} padding={4}>
            <HStack justify="between" vAlign="center" gap={4}>
              <VStack gap={0}>
                <Text type="body" size="sm" weight="semibold">
                  {enabled ? t("hostEnabledTitle") : t("hostPausedTitle")}
                </Text>
                <Text type="body" size="sm" color="secondary">
                  {enabled ? t("hostEnabledDescription") : t("hostPausedDescription")}
                </Text>
              </VStack>
              <Switch
                label={t("enableHostLabel")}
                isLabelHidden
                value={enabled}
                onChange={setEnabled}
              />
            </HStack>
          </Card>

          <TextInput
            {...NATIVE_REQUIRED}
            label={tCommon("name")}
            htmlName="name"
            placeholder={t("namePlaceholder")}
            value={text.name}
            onChange={set("name")}
            isRequired
          />

          <HostNotesField value={text.description} onChange={set("description")} />

          <HostTagsField initial={initialData?.tags} />
        </VStack>

        <VStack gap={5} id={anchor("listener")}>
          <Selector
            label={tProxyHosts("protocol")}
            htmlName="protocol"
            options={PROTOCOL_OPTIONS}
            value={protocol}
            onChange={(v) => setProtocol(v as "tcp" | "udp")}
          />

          <TextInput
            startIcon={Network}
            {...NATIVE_REQUIRED}
            label={t("listenAddress")}
            htmlName="listenAddress"
            placeholder=":5432"
            value={text.listenAddress}
            onChange={set("listenAddress")}
            isRequired
            description={t("listenAddressHelp")}
          />

          <AgentAssignmentFields agents={agents} selected={assignedAgentIds} />

          <Selector
            label={t("matcher")}
            htmlName="matcherType"
            options={matcherOptions(t)}
            value={matcherType}
            onChange={(v) =>
              setMatcherType(v as "none" | "tls_sni" | "http_host" | "proxy_protocol")
            }
            description={t("matcherHelp")}
          />

          {(matcherType === "tls_sni" || matcherType === "http_host") && (
            <TextInput
              startIcon={Globe}
              {...NATIVE_REQUIRED}
              label={matcherType === "tls_sni" ? t("sniHostnames") : t("httpHostnames")}
              htmlName="matcherValue"
              placeholder={t("matcherHostnamesPlaceholder")}
              value={text.matcherValue}
              onChange={set("matcherValue")}
              isRequired
              description={t("matcherHostnamesHelp")}
            />
          )}

          {/* Unconditional: over UDP the switch is gone and the update must read that as off. */}
          <input type="hidden" name="tlsTerminationPresent" value="1" />
          {protocol === "tcp" && (
            <Switch
              label={t("tlsTermination")}
              htmlName="tlsTermination"
              value={tlsTermination}
              onChange={setTlsTermination}
            />
          )}

          <input type="hidden" name="proxyProtocolReceivePresent" value="1" />
          <Switch
            label={t("acceptInboundProxyProtocol")}
            htmlName="proxyProtocolReceive"
            value={proxyProtocolReceive}
            onChange={setProxyProtocolReceive}
          />
        </VStack>

        <VStack gap={5} id={anchor("upstreams")}>
          <input type="hidden" name="upstreamPortMode" value={samePort ? "same" : "fixed"} />
          <Switch
            label={t("samePortUpstream")}
            description={t("samePortUpstreamHelp")}
            value={samePort}
            onChange={setSamePort}
          />

          <TextArea
            {...NATIVE_REQUIRED}
            {...NO_SPELLCHECK}
            label={tProxyHosts("upstreams")}
            htmlName="upstreams"
            placeholder={samePort ? "10.0.0.1\n10.0.0.2" : "10.0.0.1:5432\n10.0.0.2:5432"}
            value={text.upstreams}
            onChange={set("upstreams")}
            rows={2}
            isRequired
            description={samePort ? t("upstreamsSamePortHelp") : t("upstreamsHelp")}
          />

          <Selector
            label={t("upstreamProxyProtocolLabel")}
            htmlName="proxyProtocolVersion"
            options={proxyProtocolOptions(t)}
            value={proxyProtocolVersion}
            onChange={setProxyProtocolVersion}
          />

          <Section
            icon={Layers}
            title={tProxyHosts("loadBalancer")}
            defaultIsOpen={initialData?.loadBalancer?.enabled ?? false}
          >
            <input type="hidden" name="lbPresent" value="1" />
            <input type="hidden" name="lbEnabledPresent" value="1" />
            <Switch
              label={tProxyHosts("enableLoadBalancing")}
              htmlName="lbEnabled"
              value={lbEnabled}
              onChange={setLbEnabled}
            />
            <Selector
              label={t("policy")}
              htmlName="lbPolicy"
              options={lbPolicyOptions(tProxyHosts)}
              value={lbPolicy}
              onChange={setLbPolicy}
            />
            {lbPolicy === "random_choose" && (
              <TextInput
                label={tProxyHosts("lbChoose")}
                isOptional
                htmlName="lbPolicyChoose"
                placeholder="2"
                value={text.lbPolicyChoose}
                onChange={set("lbPolicyChoose")}
              />
            )}
            {lbPolicy === "weighted_round_robin" && (
              <TextInput
                label={tProxyHosts("lbWeights")}
                isOptional
                htmlName="lbPolicyWeights"
                placeholder="3, 2, 1"
                value={text.lbPolicyWeights}
                onChange={set("lbPolicyWeights")}
              />
            )}
            <TextInput
              startIcon={Clock}
              label={tProxyHosts("tryDuration")}
              isOptional
              htmlName="lbTryDuration"
              placeholder="5s"
              value={text.lbTryDuration}
              onChange={set("lbTryDuration")}
            />
            <TextInput
              startIcon={Clock}
              label={tProxyHosts("tryInterval")}
              isOptional
              htmlName="lbTryInterval"
              placeholder="250ms"
              value={text.lbTryInterval}
              onChange={set("lbTryInterval")}
            />

            <Text type="label" size="sm" weight="semibold" color="secondary">
              {t("activeHealthCheck")}
            </Text>
            <input type="hidden" name="lbActiveHealthEnabledPresent" value="1" />
            {/* Disabled, it posts nothing and saves as off. */}
            <Switch
              label={t("enableActiveHealthCheck")}
              htmlName="lbActiveHealthEnabled"
              value={lbActiveHealthEnabled && !samePort}
              onChange={setLbActiveHealthEnabled}
              isDisabled={samePort}
              description={samePort ? t("activeHealthCheckSamePort") : undefined}
            />
            <TextInput
              label={tProxyHosts("healthCheckPort")}
              isOptional
              htmlName="lbActiveHealthPort"
              value={text.lbActiveHealthPort}
              onChange={set("lbActiveHealthPort")}
            />
            <TextInput
              startIcon={Clock}
              label={tProxyHosts("interval")}
              isOptional
              htmlName="lbActiveHealthInterval"
              placeholder="30s"
              value={text.lbActiveHealthInterval}
              onChange={set("lbActiveHealthInterval")}
            />
            <TextInput
              startIcon={Clock}
              label={tProxyHosts("timeout")}
              isOptional
              htmlName="lbActiveHealthTimeout"
              placeholder="5s"
              value={text.lbActiveHealthTimeout}
              onChange={set("lbActiveHealthTimeout")}
            />

            <Text type="label" size="sm" weight="semibold" color="secondary">
              {t("passiveHealthCheck")}
            </Text>
            <input type="hidden" name="lbPassiveHealthEnabledPresent" value="1" />
            <Switch
              label={t("enablePassiveHealthCheck")}
              htmlName="lbPassiveHealthEnabled"
              value={lbPassiveHealthEnabled}
              onChange={setLbPassiveHealthEnabled}
            />
            <TextInput
              startIcon={Clock}
              label={tProxyHosts("failDuration")}
              isOptional
              htmlName="lbPassiveHealthFailDuration"
              placeholder="30s"
              value={text.lbPassiveHealthFailDuration}
              onChange={set("lbPassiveHealthFailDuration")}
            />
            <TextInput
              label={t("maxFails")}
              isOptional
              htmlName="lbPassiveHealthMaxFails"
              value={text.lbPassiveHealthMaxFails}
              onChange={set("lbPassiveHealthMaxFails")}
            />
          </Section>

          <Section
            icon={Globe}
            title={tProxyHosts("customDnsResolvers")}
            defaultIsOpen={initialData?.dnsResolver?.enabled ?? false}
          >
            <input type="hidden" name="dnsPresent" value="1" />
            <input type="hidden" name="dnsEnabledPresent" value="1" />
            <Switch
              label={t("enableCustomDns")}
              htmlName="dnsEnabled"
              value={dnsEnabled}
              onChange={setDnsEnabled}
            />
            <TextArea
              label={tProxyHosts("dnsResolvers")}
              isOptional
              htmlName="dnsResolvers"
              placeholder={"1.1.1.1\n9.9.9.9"}
              value={text.dnsResolvers}
              onChange={set("dnsResolvers")}
              rows={2}
              description={t("dnsResolversHelp")}
            />
            <TextArea
              label={tSettings("fallbackResolvers")}
              isOptional
              htmlName="dnsFallbacks"
              placeholder={"1.0.0.1\n149.112.112.112"}
              value={text.dnsFallbacks}
              onChange={set("dnsFallbacks")}
              rows={1}
              description={t("fallbackResolversHelp")}
            />
            <TextInput
              startIcon={Clock}
              label={tProxyHosts("timeout")}
              isOptional
              htmlName="dnsTimeout"
              placeholder="5s"
              value={text.dnsTimeout}
              onChange={set("dnsTimeout")}
            />
          </Section>

          <Section
            icon={Pin}
            title={tProxyHosts("upstreamDnsPinning")}
            defaultIsOpen={initialData?.upstreamDnsResolution?.enabled === true}
          >
            <input type="hidden" name="upstreamDnsResolutionPresent" value="1" />
            <Text type="body" size="sm" color="secondary">
              {t("dnsPinningDescription")}
            </Text>
            <Selector
              label={tProxyHosts("resolutionMode")}
              htmlName="upstreamDnsResolutionMode"
              options={upstreamDnsModeOptions(t)}
              value={upstreamDnsMode}
              onChange={setUpstreamDnsMode}
            />
            <Selector
              label={tProxyHosts("addressFamilyPreference")}
              htmlName="upstreamDnsResolutionFamily"
              options={upstreamDnsFamilyOptions(t)}
              value={upstreamDnsFamily}
              onChange={setUpstreamDnsFamily}
            />
          </Section>
        </VStack>

        <VStack gap={5} id={anchor("protection")}>
          <Selector
            label={tProxyHosts("accessList")}
            htmlName="accessListId"
            options={accessListOptions(t, accessLists, initialData?.accessListId ?? null)}
            value={accessListId}
            onChange={setAccessListId}
            description={t("accessListHelp")}
          />

          {/* Open when the host has opted out, so that choice is visible without a click. */}
          <Section icon={ShieldBan} title={t("crowdsec")} defaultIsOpen={!crowdsecEnabled}>
            <input type="hidden" name="crowdsecPresent" value="1" />
            <Switch
              label={tProxyHosts("enableCrowdsec")}
              description={t("crowdsecHelp")}
              htmlName="crowdsecEnabled"
              value={crowdsecEnabled}
              onChange={setCrowdsecEnabled}
            />
          </Section>

          <Section
            icon={MapPin}
            title={tProxyHosts("geoBlocking")}
            defaultIsOpen={initialData?.geoblock?.enabled ?? false}
          >
            <input type="hidden" name="geoblockPresent" value="1" />
            <Switch
              label={tProxyHosts("enableGeoBlocking")}
              htmlName="geoblockEnabled"
              value={geoblockEnabled}
              onChange={setGeoblockEnabled}
            />
            <Selector
              label={t("mode")}
              htmlName="geoblockMode"
              options={geoblockModeOptions(t)}
              value={geoblockMode}
              onChange={setGeoblockMode}
            />

            <Text type="label" size="sm" weight="semibold" color="secondary">
              {tProxyHosts("blockRules")}
            </Text>
            <TextInput
              startIcon={Earth}
              label={t("blockCountries")}
              isOptional
              htmlName="geoblockBlockCountries"
              placeholder={t("blockedCountriesPlaceholder")}
              value={text.geoblockBlockCountries}
              onChange={set("geoblockBlockCountries")}
              description={t("countryCodesHelp")}
            />
            <TextInput
              startIcon={Earth}
              label={t("blockContinents")}
              isOptional
              htmlName="geoblockBlockContinents"
              placeholder={t("blockedContinentsPlaceholder")}
              value={text.geoblockBlockContinents}
              onChange={set("geoblockBlockContinents")}
              description={t("continentCodesHelp")}
            />
            <TextInput
              startIcon={Network}
              label={t("blockAsns")}
              isOptional
              htmlName="geoblockBlockAsns"
              placeholder="12345, 67890"
              value={text.geoblockBlockAsns}
              onChange={set("geoblockBlockAsns")}
            />
            <TextInput
              startIcon={Network}
              label={t("blockCidrs")}
              isOptional
              htmlName="geoblockBlockCidrs"
              placeholder="192.0.2.0/24"
              value={text.geoblockBlockCidrs}
              onChange={set("geoblockBlockCidrs")}
            />
            <TextInput
              startIcon={Network}
              label={t("blockIps")}
              isOptional
              htmlName="geoblockBlockIps"
              placeholder="203.0.113.1"
              value={text.geoblockBlockIps}
              onChange={set("geoblockBlockIps")}
            />

            <Text type="label" size="sm" weight="semibold" color="secondary">
              {t("allowRulesOverrideBlocks")}
            </Text>
            <TextInput
              startIcon={Earth}
              label={t("allowCountries")}
              isOptional
              htmlName="geoblockAllowCountries"
              placeholder={t("allowedCountriesPlaceholder")}
              value={text.geoblockAllowCountries}
              onChange={set("geoblockAllowCountries")}
            />
            <TextInput
              startIcon={Earth}
              label={t("allowContinents")}
              isOptional
              htmlName="geoblockAllowContinents"
              placeholder={t("allowedContinentsPlaceholder")}
              value={text.geoblockAllowContinents}
              onChange={set("geoblockAllowContinents")}
            />
            <TextInput
              startIcon={Network}
              label={t("allowAsns")}
              isOptional
              htmlName="geoblockAllowAsns"
              placeholder="11111"
              value={text.geoblockAllowAsns}
              onChange={set("geoblockAllowAsns")}
            />
            <TextInput
              startIcon={Network}
              label={t("allowCidrs")}
              isOptional
              htmlName="geoblockAllowCidrs"
              placeholder="10.0.0.0/8"
              value={text.geoblockAllowCidrs}
              onChange={set("geoblockAllowCidrs")}
            />
            <TextInput
              startIcon={Network}
              label={t("allowIps")}
              isOptional
              htmlName="geoblockAllowIps"
              placeholder="1.2.3.4"
              value={text.geoblockAllowIps}
              onChange={set("geoblockAllowIps")}
            />

            <Banner
              status="info"
              title={t("geoblockClientIpTitle")}
              description={t("geoblockClientIpDescription")}
            />
          </Section>
        </VStack>
      </VStack>
    </form>
  );
}

export function CreateL4HostDialog({
  open,
  onClose,
  initialData,
  defaults,
  agents = [],
  accessLists = [],
}: {
  open: boolean;
  onClose: () => void;
  initialData?: L4ProxyHost | null;
  /** Settings' host defaults, for a new host only: a duplicate keeps its source's values. */
  defaults?: L4ProxyHostDefaults | null;
  agents?: AgentOption[];
  accessLists?: L4AccessListOption[];
}) {
  const t = useTranslations("l4ProxyHosts");
  const tCommon = useTranslations("common");
  const [state, formAction, isPending] = useActionState(
    createL4ProxyHostAction,
    INITIAL_ACTION_STATE,
  );

  useCloseOnSuccess(state, onClose);

  return (
    <HostEditorShell
      open={open}
      onClose={onClose}
      title={initialData ? t("duplicateL4ProxyHost") : t("createL4ProxyHost")}
      kind="l4"
      isCreate
      formId="create-l4-host-form"
      state={state}
      isPending={isPending}
      preview={(data) => previewL4ProxyHostAction(null, data)}
      sections={l4SectionLinks("create-")}
    >
      <L4HostForm
        anchorPrefix="create-"
        formId="create-l4-host-form"
        formAction={formAction}
        state={state}
        initialData={
          initialData
            ? { ...initialData, name: tCommon("copyName", { name: initialData.name }) }
            : null
        }
        defaults={defaults}
        agents={agents}
        accessLists={accessLists}
      />
    </HostEditorShell>
  );
}

export function EditL4HostDialog({
  open,
  host,
  onClose,
  agents = [],
  accessLists = [],
  assignedAgentIds = [],
  initialSection = null,
  rollback = null,
}: {
  open: boolean;
  host: L4ProxyHost;
  onClose: () => void;
  /** The editor holds this revision rather than the stored host. */
  rollback?: EditorRollback | null;
  /** Scrolled to on open, from the hash of an `?edit=` link. */
  initialSection?: L4EditorSection | null;
  agents?: AgentOption[];
  accessLists?: L4AccessListOption[];
  assignedAgentIds?: number[];
}) {
  const t = useTranslations("l4ProxyHosts");
  const [state, formAction, isPending] = useActionState(
    updateL4ProxyHostAction.bind(null, host.id),
    INITIAL_ACTION_STATE,
  );

  useCloseOnSuccess(state, onClose);

  useEffect(() => {
    if (!open || !initialSection) return;
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(l4EditorSectionAnchor(initialSection))
        ?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, initialSection]);

  return (
    <HostEditorShell
      open={open}
      onClose={onClose}
      title={t("editL4ProxyHost")}
      kind="l4"
      isCreate={false}
      formId="edit-l4-host-form"
      state={state}
      isPending={isPending}
      preview={(data) => previewL4ProxyHostAction(host.id, data)}
      sections={l4SectionLinks("")}
      onSectionLink={(section) => linkEditorSection(host.uuid, section)}
    >
      {rollback && <RollbackNotice rollback={rollback} formId="edit-l4-host-form" />}
      <L4HostForm
        formId="edit-l4-host-form"
        formAction={formAction}
        state={state}
        initialData={host}
        agents={agents}
        accessLists={accessLists}
        assignedAgentIds={assignedAgentIds}
      />
    </HostEditorShell>
  );
}

export function DeleteL4HostDialog({
  open,
  host,
  onClose,
}: {
  open: boolean;
  host: L4ProxyHost;
  onClose: () => void;
}) {
  const t = useTranslations("l4ProxyHosts");
  const tProxyHosts = useTranslations("proxyHosts");
  const tCommon = useTranslations("common");
  const [state, formAction] = useActionState(
    deleteL4ProxyHostAction.bind(null, host.id),
    INITIAL_ACTION_STATE,
  );

  useCloseOnSuccess(state, onClose);

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={t("deleteL4ProxyHost")}
      maxWidth="lg"
      submitLabel={tCommon("delete")}
      onSubmit={() => {
        (document.getElementById("delete-l4-host-form") as HTMLFormElement)?.requestSubmit();
      }}
    >
      <form id="delete-l4-host-form" action={formAction}>
        <VStack gap={4}>
          {state.status !== "idle" && state.message && (
            <Banner status={state.status === "error" ? "error" : "success"} title={state.message} />
          )}
          <Text type="body" size="sm">
            {t.rich("deleteConfirm", {
              name: host.name,
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </Text>
          <Card variant="muted" padding={3}>
            <MetadataList>
              <MetadataListItem label={tProxyHosts("protocol")}>
                <Badge
                  variant={host.protocol === "tcp" ? "info" : "warning"}
                  label={host.protocol.toUpperCase()}
                />
              </MetadataListItem>
              <MetadataListItem label={t("listen")}>
                <Text type="code" size="sm">
                  {host.listenAddress}
                </Text>
              </MetadataListItem>
              <MetadataListItem label={tProxyHosts("upstreams")}>
                <Text type="code" size="sm">
                  {host.upstreams.join(", ")}
                </Text>
              </MetadataListItem>
            </MetadataList>
          </Card>
          <Text type="body" size="sm" weight="medium">
            {t("deleteWarning")}
          </Text>
        </VStack>
      </form>
    </AppDialog>
  );
}
