"use client";

import { Clock, Globe, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Grid } from "@astryxdesign/core/Grid";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { useDisabledReason, useModuleGate } from "@/components/caddy-modules/ModuleGate";
import { NO_SPELLCHECK } from "@/components/ui/native-input-attrs";
import { isCaddyDuration } from "@/lib/caddy/duration";
import { dnsModuleId } from "@/lib/caddy/image-build/modules";
import {
  DYNAMIC_DNS_MAX_ENDPOINTS,
  DYNAMIC_DNS_MAX_RECORD_SETS,
  type DynamicDnsRecordSet,
  type DynamicDnsSettings,
  isDynamicDnsProvider,
} from "@/lib/dns/dynamic-dns";
import type { DnsProviderDefinition } from "@/lib/dns/providers";
import { type WithRowId, withRowId, withRowIds } from "@/lib/forms/row-id";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import { FormCard, StatusAlert } from "@/src/components/ui/FormLayout";

/** The agent selector's value for a set without one; an agentId never takes this form. */
const CONTROLLER_AGENT = "@controller";

type RecordSetState = { provider: string; zone: string; names: string; agent: string };

function toState(sets: readonly DynamicDnsRecordSet[]): WithRowId<RecordSetState>[] {
  return withRowIds(
    sets.map((set) => ({
      provider: set.provider,
      zone: set.zone,
      names: set.names.join(", "),
      agent: set.agentId ?? CONTROLLER_AGENT,
    })),
  );
}

function recordSetsJson(rows: readonly RecordSetState[]): string {
  return JSON.stringify(
    rows.map((row) => ({
      provider: row.provider,
      zone: row.zone.trim(),
      names: row.names.split(/[\s,]+/).filter(Boolean),
      agentId: row.agent === CONTROLLER_AGENT ? null : row.agent,
    })),
  );
}

export function DynamicDnsSection({
  dynamicDns,
  providerDefinitions,
  configuredProviders,
  agents,
  state,
  formAction,
}: {
  dynamicDns: DynamicDnsSettings;
  providerDefinitions: DnsProviderDefinition[];
  /** Providers with saved credentials. */
  configuredProviders: string[];
  agents: { agentId: string; name: string }[];
  state: { success: boolean; message?: string } | null;
  formAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings.dynamicDns");
  const tCommon = useTranslations("common");
  const moduleDisabledReason = useDisabledReason("ddns");
  const { enabledModuleIds } = useModuleGate();
  const [enabled, setEnabled] = useState(dynamicDns.enabled);
  const [rows, setRows] = useState(() => toState(dynamicDns.recordSets));
  const [ipv4, setIpv4] = useState(dynamicDns.ipv4);
  const [ipv6, setIpv6] = useState(dynamicDns.ipv6);
  const [checkInterval, setCheckInterval] = useState(dynamicDns.checkInterval);
  const [ttl, setTtl] = useState(dynamicDns.ttl);
  const [updateOnly, setUpdateOnly] = useState(dynamicDns.updateOnly);
  const [endpoints, setEndpoints] = useState(dynamicDns.ipEndpoints.join("\n"));

  const providerOptions = configuredProviders.filter(isDynamicDnsProvider).map((name) => {
    const usable = enabledModuleIds === null || enabledModuleIds.includes(dnsModuleId(name));
    return {
      value: name,
      // A brand name, so it stays as the registry spells it.
      label: providerDefinitions.find((p) => p.name === name)?.displayName ?? name,
      disabled: !usable,
      description: usable ? undefined : t("providerModuleDisabled"),
    };
  });
  const agentOptions = [
    { value: CONTROLLER_AGENT, label: t("agentDefault") },
    ...agents.map((agent) => ({ value: agent.agentId, label: agent.name })),
  ];

  const addRow = () =>
    setRows((current) => [
      ...current,
      withRowId({
        provider: providerOptions.find((option) => !option.disabled)?.value ?? "",
        zone: "",
        names: "@",
        agent: CONTROLLER_AGENT,
      }),
    ]);
  const removeRow = (rowId: string) =>
    setRows((current) => current.filter((row) => row.rowId !== rowId));
  const updateRow = (rowId: string, key: keyof RecordSetState, value: string) =>
    setRows((current) =>
      current.map((row) => (row.rowId === rowId ? { ...row, [key]: value } : row)),
    );

  const intervalText = checkInterval.trim();
  const ttlText = ttl.trim();

  return (
    <FormCard>
      <form action={formAction}>
        <VStack gap={4}>
          {state?.message && <StatusAlert message={state.message} success={state.success} />}
          {moduleDisabledReason && (
            <Banner status="warning" title={t("unavailable")} description={moduleDisabledReason} />
          )}
          <Text type="body" size="sm" color="secondary">
            {t("help")}
          </Text>
          <Switch
            label={t("enabled")}
            description={t("enabledHelp")}
            htmlName="ddnsEnabled"
            labelPosition="start"
            labelSpacing="spread"
            value={enabled}
            onChange={setEnabled}
          />
          {providerOptions.length === 0 && (
            <Banner status="info" title={t("noProvidersTitle")} description={t("noProviders")} />
          )}

          <input type="hidden" name="ddnsRecordSetsJson" value={recordSetsJson(rows)} />
          {rows.map((row, index) => (
            <VStack key={row.rowId} gap={3}>
              {index > 0 && <Divider />}
              <HStack justify="between" vAlign="center" gap={2}>
                <Text type="body" size="sm" weight="semibold">
                  {t("recordSet", { index: index + 1 })}
                </Text>
                <IconButton
                  variant="ghost"
                  size="sm"
                  label={t("removeRecordSet", { index: index + 1 })}
                  icon={<Trash2 />}
                  onClick={() => removeRow(row.rowId)}
                />
              </HStack>
              <Grid columns={{ minWidth: 220, max: 2 }} gap={3}>
                <Selector
                  label={tCommon("provider")}
                  description={t("providerHelp")}
                  size="sm"
                  options={providerOptions}
                  value={row.provider}
                  onChange={(next) => updateRow(row.rowId, "provider", next)}
                  placeholder={t("providerPlaceholder")}
                />
                <TextInput
                  startIcon={Globe}
                  {...NO_SPELLCHECK}
                  label={t("zone")}
                  description={t("zoneHelp")}
                  size="sm"
                  placeholder="example.com"
                  value={row.zone}
                  onChange={(next) => updateRow(row.rowId, "zone", next)}
                />
                <TextInput
                  {...NO_SPELLCHECK}
                  label={t("names")}
                  description={t("namesHelp")}
                  size="sm"
                  placeholder="@, home"
                  value={row.names}
                  onChange={(next) => updateRow(row.rowId, "names", next)}
                />
                <Selector
                  label={tCommon("agent")}
                  description={t("agentHelp")}
                  size="sm"
                  options={agentOptions}
                  value={row.agent}
                  onChange={(next) => updateRow(row.rowId, "agent", next)}
                />
              </Grid>
            </VStack>
          ))}
          {rows.length < DYNAMIC_DNS_MAX_RECORD_SETS && (
            <HStack>
              <Button
                variant="ghost"
                size="sm"
                label={tCommon("add")}
                icon={<Plus />}
                onClick={addRow}
                isDisabled={providerOptions.length === 0}
              />
            </HStack>
          )}

          <Divider />
          <Grid columns={{ minWidth: 220, max: 2 }} gap={3}>
            <Switch
              label={t("ipv4")}
              htmlName="ddnsIpv4"
              labelPosition="start"
              labelSpacing="spread"
              value={ipv4}
              onChange={setIpv4}
            />
            <Switch
              label={t("ipv6")}
              htmlName="ddnsIpv6"
              labelPosition="start"
              labelSpacing="spread"
              value={ipv6}
              onChange={setIpv6}
            />
            <TextInput
              startIcon={Clock}
              {...NO_SPELLCHECK}
              label={t("checkInterval")}
              description={t("checkIntervalHelp")}
              htmlName="ddnsCheckInterval"
              size="sm"
              placeholder="5m"
              value={checkInterval}
              onChange={setCheckInterval}
              status={
                intervalText && !isCaddyDuration(intervalText)
                  ? { type: "error", message: t("durationInvalid") }
                  : undefined
              }
            />
            <TextInput
              {...NO_SPELLCHECK}
              label={t("ttl")}
              description={t("ttlHelp")}
              htmlName="ddnsTtl"
              size="sm"
              isOptional
              placeholder="5m"
              value={ttl}
              onChange={setTtl}
              status={
                ttlText && !isCaddyDuration(ttlText)
                  ? { type: "error", message: t("durationInvalid") }
                  : undefined
              }
            />
          </Grid>
          <Switch
            label={t("updateOnly")}
            description={t("updateOnlyHelp")}
            htmlName="ddnsUpdateOnly"
            labelPosition="start"
            labelSpacing="spread"
            value={updateOnly}
            onChange={setUpdateOnly}
          />
          <TextArea
            {...NO_SPELLCHECK}
            label={t("ipEndpoints")}
            description={t("ipEndpointsHelp", { max: DYNAMIC_DNS_MAX_ENDPOINTS })}
            htmlName="ddnsIpEndpoints"
            isOptional
            rows={3}
            placeholder={"https://icanhazip.com\nhttps://ifconfig.me"}
            value={endpoints}
            onChange={setEndpoints}
          />
        </VStack>
      </form>
    </FormCard>
  );
}
