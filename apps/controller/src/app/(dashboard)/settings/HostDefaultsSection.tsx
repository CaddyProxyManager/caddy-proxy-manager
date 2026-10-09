"use client";

import { type ReactNode, useState } from "react";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { useDisabledReason } from "@/components/caddy-modules/ModuleGate";
import type { HostCompressionMode } from "@/src/lib/proxy-hosts/compression";
import type { L4ProxyHostDefaults, ProxyHostDefaults } from "@/src/lib/proxy-hosts/host-defaults";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import { FormCard, StatusAlert } from "@/src/components/ui/FormLayout";

type BlockProps<T> = {
  defaults: T;
  state: { success: boolean; message?: string } | null;
  formAction: (payload: FormData) => void;
};

/** A labelled choice laid out as the host editor's compression row is. */
function ChoiceRow({
  label,
  description,
  name,
  value,
  children,
  onChange,
}: {
  label: string;
  description?: string;
  name: string;
  value: string;
  children: ReactNode;
  onChange: (next: string) => void;
}) {
  return (
    <HStack justify="between" vAlign="center" gap={4}>
      <input type="hidden" name={name} value={value} />
      <VStack gap={1}>
        <Text type="body" size="sm">
          {label}
        </Text>
        {description && (
          <Text type="body" size="sm" color="secondary">
            {description}
          </Text>
        )}
      </VStack>
      <SegmentedControl label={label} size="sm" value={value} onChange={onChange}>
        {children}
      </SegmentedControl>
    </HStack>
  );
}

/** The host editor's own labels, so a default reads exactly as the switch it presets. */
export function ProxyHostDefaultsSection({
  defaults,
  state,
  formAction,
}: BlockProps<ProxyHostDefaults>) {
  const t = useTranslations("settings.hostDefaults");
  const tHost = useTranslations("proxyHosts");
  const wafUnavailable = useDisabledReason("waf");
  const crowdsecUnavailable = useDisabledReason("crowdsec");
  const [values, setValues] = useState(defaults);
  const set =
    <K extends keyof ProxyHostDefaults>(key: K) =>
    (value: ProxyHostDefaults[K]) =>
      setValues((prev) => ({ ...prev, [key]: value }));
  // As in the editor: HSTS only once HTTPS is forced, its subdomains only once HSTS is on.
  const hstsBlocked = !values.sslForced;
  const subdomainsBlocked = hstsBlocked || !values.hstsEnabled;

  const toggle = (
    key:
      | "sslForced"
      | "hstsEnabled"
      | "hstsSubdomains"
      | "allowWebsocket"
      | "preserveHostHeader"
      | "skipHttpsValidation"
      | "discourageIndexing",
    label: Parameters<typeof tHost>[0],
    description: Parameters<typeof tHost>[0],
    blocked = false,
  ) => (
    <Switch
      label={tHost(label)}
      description={tHost(description)}
      htmlName={key}
      labelPosition="start"
      labelSpacing="spread"
      value={blocked ? false : values[key]}
      isDisabled={blocked}
      onChange={set(key)}
    />
  );

  return (
    <FormCard>
      <form action={formAction}>
        <VStack gap={4}>
          {state?.message && <StatusAlert message={state.message} success={state.success} />}
          <Text type="body" size="sm" color="secondary">
            {t("help")}
          </Text>
          {toggle("sslForced", "forceHttps", "forceHttpsHelp")}
          {toggle("hstsEnabled", "hsts", "hstsHelp", hstsBlocked)}
          {toggle("hstsSubdomains", "hstsSubdomains", "hstsSubdomainsHelp", subdomainsBlocked)}
          {toggle("allowWebsocket", "websocketSupport", "websocketSupportHelp")}
          {toggle("preserveHostHeader", "preserveHostHeader", "preserveHostHeaderHelp")}
          {toggle("skipHttpsValidation", "skipHttpsValidation", "skipHttpsValidationHelp")}
          {toggle("discourageIndexing", "discourageIndexing", "discourageIndexingHelp")}
          <ChoiceRow
            label={tHost("compression")}
            description={tHost("compressionHelp")}
            name="compression"
            value={values.compression}
            onChange={(next) => set("compression")(next as HostCompressionMode)}
          >
            <SegmentedControlItem value="inherit" label={tHost("compressionInherit")} />
            <SegmentedControlItem value="on" label={tHost("compressionOn")} />
            <SegmentedControlItem value="off" label={tHost("compressionOff")} />
          </ChoiceRow>
          <Switch
            label={tHost("enableWebApplicationFirewall")}
            description={wafUnavailable ?? t("wafFollowsGlobal")}
            labelPosition="start"
            labelSpacing="spread"
            value={values.wafEnabled}
            isDisabled
          />
          <Switch
            label={tHost("enableCrowdsec")}
            description={crowdsecUnavailable ?? tHost("crowdsecDescription")}
            htmlName="crowdsecEnabled"
            labelPosition="start"
            labelSpacing="spread"
            value={values.crowdsecEnabled}
            onChange={set("crowdsecEnabled")}
          />
        </VStack>
      </form>
    </FormCard>
  );
}

/** Field names carry an l4 prefix: both blocks share a page, and FocusField finds one by name. */
export function L4ProxyHostDefaultsSection({
  defaults,
  state,
  formAction,
}: BlockProps<L4ProxyHostDefaults>) {
  const t = useTranslations("settings.hostDefaults");
  const tL4 = useTranslations("l4ProxyHosts");
  const tHost = useTranslations("proxyHosts");
  const crowdsecUnavailable = useDisabledReason("crowdsec");
  const [values, setValues] = useState(defaults);
  const set =
    <K extends keyof L4ProxyHostDefaults>(key: K) =>
    (value: L4ProxyHostDefaults[K]) =>
      setValues((prev) => ({ ...prev, [key]: value }));
  // UDP has no TLS to terminate; the L4 editor hides the switch for the same reason.
  const tlsBlocked = values.protocol !== "tcp";

  return (
    <FormCard>
      <form action={formAction}>
        <VStack gap={4}>
          {state?.message && <StatusAlert message={state.message} success={state.success} />}
          <Text type="body" size="sm" color="secondary">
            {t("l4Help")}
          </Text>
          <ChoiceRow
            label={tHost("protocol")}
            name="l4Protocol"
            value={values.protocol}
            onChange={(next) => set("protocol")(next === "udp" ? "udp" : "tcp")}
          >
            <SegmentedControlItem value="tcp" label={tL4("tcpStreams")} />
            <SegmentedControlItem value="udp" label={tL4("udpStreams")} />
          </ChoiceRow>
          <Switch
            label={tL4("tlsTermination")}
            htmlName="l4TlsTermination"
            labelPosition="start"
            labelSpacing="spread"
            value={tlsBlocked ? false : values.tlsTermination}
            isDisabled={tlsBlocked}
            onChange={set("tlsTermination")}
          />
          <Switch
            label={tL4("acceptInboundProxyProtocol")}
            htmlName="l4ProxyProtocolReceive"
            labelPosition="start"
            labelSpacing="spread"
            value={values.proxyProtocolReceive}
            onChange={set("proxyProtocolReceive")}
          />
          <Switch
            label={tHost("enableCrowdsec")}
            description={crowdsecUnavailable ?? tL4("crowdsecHelp")}
            htmlName="l4CrowdsecEnabled"
            labelPosition="start"
            labelSpacing="spread"
            value={values.crowdsecEnabled}
            onChange={set("crowdsecEnabled")}
          />
        </VStack>
      </form>
    </FormCard>
  );
}
