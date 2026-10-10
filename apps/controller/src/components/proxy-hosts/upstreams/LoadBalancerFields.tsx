"use client";

import { Clock, EthernetPort, KeyRound, Route } from "lucide-react";
import { useState } from "react";
import { Card } from "@astryxdesign/core/Card";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text } from "@astryxdesign/core/Text";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import type { ProxyHost, LoadBalancingPolicy } from "@/lib/models/proxy-hosts";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import { useTranslations } from "next-intl";

/**
 * Every selection policy the shipped Caddy build registers. A function because the labels come
 * from `useTranslations`, which only works inside the component.
 */
function loadBalancingPolicies(t: ReturnType<typeof useTranslations<"proxyHosts">>) {
  return [
    { value: "random", label: t("lbPolicyRandom"), description: t("lbPolicyRandomHelp") },
    {
      value: "random_choose",
      label: t("lbPolicyRandomChoose"),
      description: t("lbPolicyRandomChooseHelp"),
    },
    {
      value: "round_robin",
      label: t("lbPolicyRoundRobin"),
      description: t("lbPolicyRoundRobinHelp"),
    },
    {
      value: "weighted_round_robin",
      label: t("lbPolicyWeightedRoundRobin"),
      description: t("lbPolicyWeightedRoundRobinHelp"),
    },
    { value: "least_conn", label: t("lbPolicyLeastConn"), description: t("lbPolicyLeastConnHelp") },
    { value: "ip_hash", label: t("lbPolicyIpHash"), description: t("lbPolicyIpHashHelp") },
    {
      value: "client_ip_hash",
      label: t("lbPolicyClientIpHash"),
      description: t("lbPolicyClientIpHashHelp"),
    },
    { value: "first", label: t("lbPolicyFirst"), description: t("lbPolicyFirstHelp") },
    { value: "header", label: t("lbPolicyHeader"), description: t("lbPolicyHeaderHelp") },
    { value: "cookie", label: t("lbPolicyCookie"), description: t("lbPolicyCookieHelp") },
    { value: "uri_hash", label: t("lbPolicyUriHash"), description: t("lbPolicyUriHashHelp") },
    { value: "query", label: t("lbPolicyQuery"), description: t("lbPolicyQueryHelp") },
  ];
}

/**
 * One state object because Astryx inputs are controlled. `htmlName` keeps the submitted FormData
 * keys byte-identical.
 */
type TextFields = {
  policyHeaderField: string;
  policyCookieName: string;
  policyCookieSecret: string;
  policyQueryKey: string;
  policyWeights: string;
  tryDuration: string;
  tryInterval: string;
  activeHealthUri: string;
  activeHealthInterval: string;
  activeHealthTimeout: string;
  activeHealthBody: string;
  activeHealthMethod: string;
  activeHealthRequestBody: string;
  passiveHealthFailDuration: string;
  passiveHealthUnhealthyStatus: string;
  passiveHealthUnhealthyLatency: string;
};

type NumberFields = {
  retries: number | null;
  policyChoose: number | null;
  activeHealthPort: number | null;
  activeHealthStatus: number | null;
  activeHealthPasses: number | null;
  activeHealthFails: number | null;
  passiveHealthMaxFails: number | null;
  passiveHealthUnhealthyRequestCount: number | null;
};

export function LoadBalancerFields({
  loadBalancer,
}: {
  loadBalancer?: ProxyHost["loadBalancer"] | null;
}) {
  const t = useTranslations("proxyHosts");
  const initial = loadBalancer ?? null;
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [policy, setPolicy] = useState<LoadBalancingPolicy>(initial?.policy ?? "random");
  const [activeHealthEnabled, setActiveHealthEnabled] = useState(
    initial?.activeHealthCheck?.enabled ?? false,
  );
  const [passiveHealthEnabled, setPassiveHealthEnabled] = useState(
    initial?.passiveHealthCheck?.enabled ?? false,
  );

  const [text, setText] = useState<TextFields>({
    policyHeaderField: initial?.policyHeaderField ?? "",
    policyCookieName: initial?.policyCookieName ?? "",
    policyCookieSecret: initial?.policyCookieSecret ?? "",
    policyQueryKey: initial?.policyQueryKey ?? "",
    policyWeights: initial?.policyWeights?.join(", ") ?? "",
    tryDuration: initial?.tryDuration ?? "",
    tryInterval: initial?.tryInterval ?? "",
    activeHealthUri: initial?.activeHealthCheck?.uri ?? "",
    activeHealthInterval: initial?.activeHealthCheck?.interval ?? "",
    activeHealthTimeout: initial?.activeHealthCheck?.timeout ?? "",
    activeHealthBody: initial?.activeHealthCheck?.body ?? "",
    activeHealthMethod: initial?.activeHealthCheck?.method ?? "",
    activeHealthRequestBody: initial?.activeHealthCheck?.requestBody ?? "",
    passiveHealthFailDuration: initial?.passiveHealthCheck?.failDuration ?? "",
    passiveHealthUnhealthyStatus: initial?.passiveHealthCheck?.unhealthyStatus?.join(", ") ?? "",
    passiveHealthUnhealthyLatency: initial?.passiveHealthCheck?.unhealthyLatency ?? "",
  });

  const [numbers, setNumbers] = useState<NumberFields>({
    retries: initial?.retries ?? null,
    policyChoose: initial?.policyChoose ?? null,
    activeHealthPort: initial?.activeHealthCheck?.port ?? null,
    activeHealthStatus: initial?.activeHealthCheck?.status ?? null,
    activeHealthPasses: initial?.activeHealthCheck?.passes ?? null,
    activeHealthFails: initial?.activeHealthCheck?.fails ?? null,
    passiveHealthMaxFails: initial?.passiveHealthCheck?.maxFails ?? null,
    passiveHealthUnhealthyRequestCount: initial?.passiveHealthCheck?.unhealthyRequestCount ?? null,
  });

  const setTextField = (key: keyof TextFields) => (value: string) =>
    setText((prev) => ({ ...prev, [key]: value }));
  const setNumberField = (key: keyof NumberFields) => (value: number | null) =>
    setNumbers((prev) => ({ ...prev, [key]: value }));

  return (
    <Card>
      <input type="hidden" name="lbPresent" value="1" />
      <input type="hidden" name="lbEnabledPresent" value="1" />

      <VStack gap={4}>
        <HStack justify="between" vAlign="center" gap={4}>
          <VStack gap={1}>
            <Text type="body" size="sm" weight="semibold">
              {t("loadBalancer")}
            </Text>
            <Text type="body" size="sm" color="secondary">
              {t("loadBalancerDescription")}
            </Text>
          </VStack>
          <Switch
            label={t("enableLoadBalancing")}
            isLabelHidden
            htmlName="lbEnabled"
            value={enabled}
            onChange={setEnabled}
          />
        </HStack>

        {enabled && (
          <VStack gap={6}>
            <input type="hidden" name="lbPolicy" value={policy} />
            <Selector
              label={t("selectionPolicy")}
              options={loadBalancingPolicies(t)}
              value={policy}
              onChange={(next) => setPolicy(next as LoadBalancingPolicy)}
            />

            {policy === "random_choose" && (
              <NumberInput
                hasNumberSteppers
                label={t("lbChoose")}
                htmlName="lbPolicyChoose"
                min={2}
                max={16}
                isIntegerOnly
                value={numbers.policyChoose}
                onChange={setNumberField("policyChoose")}
                description={t("lbChooseHelp")}
              />
            )}

            {policy === "weighted_round_robin" && (
              <TextInput
                label={t("lbWeights")}
                htmlName="lbPolicyWeights"
                placeholder="3, 2, 1"
                value={text.policyWeights}
                onChange={setTextField("policyWeights")}
                description={t("lbWeightsHelp")}
              />
            )}

            {policy === "query" && (
              <TextInput
                label={t("lbQueryKey")}
                htmlName="lbPolicyQueryKey"
                placeholder={t("lbQueryKeyPlaceholder")}
                value={text.policyQueryKey}
                onChange={setTextField("policyQueryKey")}
                description={t("lbQueryKeyHelp")}
              />
            )}

            {policy === "header" && (
              <TextInput
                label={t("headerFieldName")}
                htmlName="lbPolicyHeaderField"
                placeholder={t("loadBalancerHeaderPlaceholder")}
                value={text.policyHeaderField}
                onChange={setTextField("policyHeaderField")}
                description={t("loadBalancerHeaderHelp")}
              />
            )}

            {policy === "cookie" && (
              <VStack gap={4}>
                <TextInput
                  label={t("cookieName")}
                  htmlName="lbPolicyCookieName"
                  placeholder="server_id"
                  value={text.policyCookieName}
                  onChange={setTextField("policyCookieName")}
                  description={t("stickyCookieNameHelp")}
                />
                <TextInput
                  startIcon={KeyRound}
                  label={t("cookieSecret")}
                  isOptional
                  htmlName="lbPolicyCookieSecret"
                  placeholder={t("stickyCookieSecretPlaceholder")}
                  value={text.policyCookieSecret}
                  onChange={setTextField("policyCookieSecret")}
                  description={t("stickyCookieSecretHelp")}
                />
              </VStack>
            )}

            <VStack gap={2}>
              <Text type="body" size="sm" weight="semibold">
                {t("retrySettings")}
              </Text>
              <Grid columns={3} gap={4}>
                <TextInput
                  startIcon={Clock}
                  label={t("tryDuration")}
                  htmlName="lbTryDuration"
                  placeholder="5s"
                  value={text.tryDuration}
                  onChange={setTextField("tryDuration")}
                  description={t("tryDurationHelp")}
                />
                <TextInput
                  startIcon={Clock}
                  label={t("tryInterval")}
                  htmlName="lbTryInterval"
                  placeholder="250ms"
                  value={text.tryInterval}
                  onChange={setTextField("tryInterval")}
                  description={t("tryIntervalHelp")}
                />
                <NumberInput
                  hasNumberSteppers
                  label={t("maxRetries")}
                  htmlName="lbRetries"
                  min={0}
                  isIntegerOnly
                  value={numbers.retries}
                  onChange={setNumberField("retries")}
                  description={t("maxRetriesHelp")}
                />
              </Grid>
            </VStack>

            <Card variant="muted">
              <input type="hidden" name="lbActiveHealthEnabledPresent" value="1" />
              <VStack gap={4}>
                <Switch
                  label={t("activeHealthChecks")}
                  description={t("activeHealthChecksHelp")}
                  htmlName="lbActiveHealthEnabled"
                  value={activeHealthEnabled}
                  onChange={setActiveHealthEnabled}
                />
                {activeHealthEnabled && (
                  <Grid columns={2} gap={4}>
                    <TextInput
                      startIcon={Route}
                      label={t("healthCheckUri")}
                      htmlName="lbActiveHealthUri"
                      placeholder="/health"
                      value={text.activeHealthUri}
                      onChange={setTextField("activeHealthUri")}
                      description={t("healthCheckUriHelp")}
                    />
                    <NumberInput
                      startIcon={EthernetPort}
                      hasNumberSteppers
                      label={t("healthCheckPort")}
                      htmlName="lbActiveHealthPort"
                      min={1}
                      max={65535}
                      isIntegerOnly
                      value={numbers.activeHealthPort}
                      onChange={setNumberField("activeHealthPort")}
                      description={t("overrideUpstreamPort")}
                    />
                    <TextInput
                      startIcon={Clock}
                      label={t("checkInterval")}
                      htmlName="lbActiveHealthInterval"
                      placeholder="30s"
                      value={text.activeHealthInterval}
                      onChange={setTextField("activeHealthInterval")}
                      description={t("healthCheckIntervalHelp")}
                    />
                    <TextInput
                      startIcon={Clock}
                      label={t("checkTimeout")}
                      htmlName="lbActiveHealthTimeout"
                      placeholder="5s"
                      value={text.activeHealthTimeout}
                      onChange={setTextField("activeHealthTimeout")}
                      description={t("healthCheckTimeoutHelp")}
                    />
                    <NumberInput
                      hasNumberSteppers
                      label={t("expectedStatusCode")}
                      htmlName="lbActiveHealthStatus"
                      min={100}
                      max={599}
                      isIntegerOnly
                      value={numbers.activeHealthStatus}
                      onChange={setNumberField("activeHealthStatus")}
                      description={t("expectedHttpStatus")}
                    />
                    <TextInput
                      label={t("expectedBody")}
                      htmlName="lbActiveHealthBody"
                      placeholder={t("ok")}
                      value={text.activeHealthBody}
                      onChange={setTextField("activeHealthBody")}
                      description={t("expectedResponseBody")}
                    />
                    <NumberInput
                      hasNumberSteppers
                      label={t("lbHealthPasses")}
                      htmlName="lbActiveHealthPasses"
                      min={1}
                      max={100}
                      isIntegerOnly
                      value={numbers.activeHealthPasses}
                      onChange={setNumberField("activeHealthPasses")}
                      description={t("lbHealthPassesHelp")}
                    />
                    <NumberInput
                      hasNumberSteppers
                      label={t("lbHealthFails")}
                      htmlName="lbActiveHealthFails"
                      min={1}
                      max={100}
                      isIntegerOnly
                      value={numbers.activeHealthFails}
                      onChange={setNumberField("activeHealthFails")}
                      description={t("lbHealthFailsHelp")}
                    />
                    <TextInput
                      label={t("lbHealthMethod")}
                      htmlName="lbActiveHealthMethod"
                      placeholder="GET"
                      value={text.activeHealthMethod}
                      onChange={setTextField("activeHealthMethod")}
                      description={t("lbHealthMethodHelp")}
                    />
                    <TextInput
                      label={t("lbHealthRequestBody")}
                      htmlName="lbActiveHealthRequestBody"
                      value={text.activeHealthRequestBody}
                      onChange={setTextField("activeHealthRequestBody")}
                      description={t("lbHealthRequestBodyHelp")}
                    />
                  </Grid>
                )}
              </VStack>
            </Card>

            <Card variant="muted">
              <input type="hidden" name="lbPassiveHealthEnabledPresent" value="1" />
              <VStack gap={4}>
                <Switch
                  label={t("passiveHealthChecks")}
                  description={t("passiveHealthChecksHelp")}
                  htmlName="lbPassiveHealthEnabled"
                  value={passiveHealthEnabled}
                  onChange={setPassiveHealthEnabled}
                />
                {passiveHealthEnabled && (
                  <Grid columns={2} gap={4}>
                    <TextInput
                      startIcon={Clock}
                      label={t("failDuration")}
                      htmlName="lbPassiveHealthFailDuration"
                      placeholder="30s"
                      value={text.passiveHealthFailDuration}
                      onChange={setTextField("passiveHealthFailDuration")}
                      description={t("failDurationHelp")}
                    />
                    <NumberInput
                      hasNumberSteppers
                      label={t("maxFailures")}
                      htmlName="lbPassiveHealthMaxFails"
                      min={0}
                      isIntegerOnly
                      value={numbers.passiveHealthMaxFails}
                      onChange={setNumberField("passiveHealthMaxFails")}
                      description={t("maxFailuresHelp")}
                    />
                    <TextInput
                      label={t("unhealthyStatusCodes")}
                      htmlName="lbPassiveHealthUnhealthyStatus"
                      placeholder="500, 502, 503"
                      value={text.passiveHealthUnhealthyStatus}
                      onChange={setTextField("passiveHealthUnhealthyStatus")}
                      description={t("unhealthyStatusCodesHelp")}
                    />
                    <TextInput
                      startIcon={Clock}
                      label={t("unhealthyLatency")}
                      htmlName="lbPassiveHealthUnhealthyLatency"
                      placeholder="5s"
                      value={text.passiveHealthUnhealthyLatency}
                      onChange={setTextField("passiveHealthUnhealthyLatency")}
                      description={t("unhealthyLatencyHelp")}
                    />
                    <NumberInput
                      hasNumberSteppers
                      label={t("lbUnhealthyRequestCount")}
                      htmlName="lbPassiveHealthUnhealthyRequestCount"
                      min={1}
                      isIntegerOnly
                      value={numbers.passiveHealthUnhealthyRequestCount}
                      onChange={setNumberField("passiveHealthUnhealthyRequestCount")}
                      description={t("lbUnhealthyRequestCountHelp")}
                    />
                  </Grid>
                )}
              </VStack>
            </Card>
          </VStack>
        )}
      </VStack>
    </Card>
  );
}
