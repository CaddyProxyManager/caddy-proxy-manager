"use client";

import { Clock, KeyRound, Link } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Selector } from "@astryxdesign/core/Selector";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { useDisabledReason } from "@/components/caddy-modules/ModuleGate";
import { AUTOFILL_NEW_PASSWORD, AUTOFILL_OFF } from "@/components/ui/native-input-attrs";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import { FormCard, InfoAlert, StatusAlert, WarnAlert } from "@/src/components/ui/FormLayout";
// Types only: both modules import server-side code.
import type { ManagedServiceView } from "@/src/lib/agent/managed-services";
import type { CrowdSecMode, CrowdSecSettingsView } from "@/src/lib/caddy/crowdsec";
import { testCrowdSecConnectionAction } from "./actions";

type Result = { success: boolean; message?: string } | null;

function ManagedStatus({ managed }: { managed: ManagedServiceView | null }) {
  const t = useTranslations("settings.crowdsec");
  if (!managed) {
    return <WarnAlert title={t("managedNoAgentTitle")}>{t("managedNoAgentBody")}</WarnAlert>;
  }
  const { agent, running, state, message } = managed;
  const [variant, text] =
    state === "applying" || state === "pending"
      ? (["accent", t("managedStatusStarting", { agent })] as const)
      : state === "failed" && !running
        ? (["error", t("managedStatusFailed", { agent })] as const)
        : running
          ? (["success", t("managedStatusRunning", { agent })] as const)
          : (["neutral", t("managedStatusStopped", { agent })] as const);
  return (
    <VStack gap={1}>
      <HStack gap={2} vAlign="center">
        <StatusDot variant={variant} label={text} />
        <Text type="body" size="sm">
          {text}
        </Text>
      </HStack>
      {state === "failed" && message && (
        <Text type="body" size="xsm" color="secondary">
          {message}
        </Text>
      )}
    </VStack>
  );
}

export function CrowdSecSection({
  crowdsec,
  managed,
  state,
  formAction,
}: {
  crowdsec: CrowdSecSettingsView;
  managed: ManagedServiceView | null;
  state: Result;
  formAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings.crowdsec");
  const tCommon = useTranslations("common");
  const tProxyHosts = useTranslations("proxyHosts");
  const moduleDisabledReason = useDisabledReason("crowdsec");
  const [enabled, setEnabled] = useState(crowdsec.enabled);
  const [mode, setMode] = useState<CrowdSecMode>(crowdsec.mode);
  const [onlineApi, setOnlineApi] = useState(crowdsec.onlineApi);
  const [managedAppsec, setManagedAppsec] = useState(crowdsec.managedAppsec);
  const [apiUrl, setApiUrl] = useState(crowdsec.apiUrl);
  const [apiKey, setApiKey] = useState("");
  const [appsecUrl, setAppsecUrl] = useState(crowdsec.appsecUrl);
  const [appsecFailOpen, setAppsecFailOpen] = useState(crowdsec.appsecFailOpen);
  const [tickerInterval, setTickerInterval] = useState(crowdsec.tickerInterval);
  const [testResult, setTestResult] = useState<Result>(null);
  const [testing, startTest] = useTransition();
  // Mirrors the save: a stored key is kept only while both addresses are unchanged.
  const keyKept =
    crowdsec.hasApiKey &&
    apiUrl.trim() === crowdsec.apiUrl &&
    appsecUrl.trim() === crowdsec.appsecUrl;
  // Status describes what is applied, so only once managed mode is what was saved.
  const managedSaved = crowdsec.enabled && crowdsec.mode === "managed";
  const appsecOn = mode === "managed" ? managedAppsec : Boolean(appsecUrl.trim());

  const runTest = () =>
    startTest(async () => {
      setTestResult(await testCrowdSecConnectionAction({ apiUrl, apiKey }));
    });

  return (
    <FormCard>
      <form action={formAction}>
        <VStack gap={3}>
          {state?.message && <StatusAlert message={state.message} success={state.success} />}
          {moduleDisabledReason && (
            <WarnAlert title={t("moduleDisabledTitle")}>
              {t("moduleDisabledBody", { reason: moduleDisabledReason })}
            </WarnAlert>
          )}
          <Switch
            label={tProxyHosts("enableCrowdsec")}
            description={t("enabledHelp")}
            htmlName="crowdsecEnabled"
            value={enabled}
            onChange={setEnabled}
          />
          <Selector
            label={t("mode")}
            description={t("modeHelp")}
            htmlName="crowdsecMode"
            options={[
              { value: "external", label: t("modes.external") },
              { value: "managed", label: t("modes.managed") },
            ]}
            value={mode}
            onChange={(value) => setMode(value === "managed" ? "managed" : "external")}
          />

          {mode === "managed" ? (
            <>
              {managedSaved ? (
                <ManagedStatus managed={managed} />
              ) : (
                <InfoAlert title={t("managedPendingTitle")}>{t("managedPendingBody")}</InfoAlert>
              )}
              <Switch
                label={t("onlineApi")}
                description={t("onlineApiHelp")}
                htmlName="crowdsecOnlineApi"
                value={onlineApi}
                onChange={setOnlineApi}
              />
              <Switch
                label={t("managedAppsec")}
                description={t("managedAppsecHelp")}
                htmlName="crowdsecManagedAppsec"
                value={managedAppsec}
                onChange={setManagedAppsec}
              />
              <InfoAlert title={t("managedRemoteTitle")}>{t("managedRemoteBody")}</InfoAlert>
              {/* The external fields are kept for switching back; the stored key with them. */}
              <input type="hidden" name="crowdsecApiUrl" value={apiUrl} />
              <input type="hidden" name="crowdsecAppsecUrl" value={appsecUrl} />
            </>
          ) : (
            <>
              <TextInput
                startIcon={Link}
                {...AUTOFILL_OFF}
                label={t("apiUrl")}
                description={t("apiUrlHelp")}
                htmlName="crowdsecApiUrl"
                value={apiUrl}
                onChange={setApiUrl}
                placeholder="http://crowdsec:8080"
              />
              <TextInput
                startIcon={KeyRound}
                {...AUTOFILL_NEW_PASSWORD}
                label={t("apiKey")}
                type="password"
                isOptional={keyKept}
                description={
                  keyKept
                    ? t("apiKeyStored")
                    : crowdsec.hasApiKey
                      ? t("apiKeyReenter")
                      : t("apiKeyHelp")
                }
                htmlName="crowdsecApiKey"
                value={apiKey}
                onChange={setApiKey}
              />
              {/* Beside the field rather than in it: a description is plain text, and a command
                  wants to look like one and be copyable. */}
              {!keyKept && !crowdsec.hasApiKey && (
                <VStack gap={1}>
                  <Text type="body" size="sm" color="secondary">
                    {t("apiKeyCreate")}
                  </Text>
                  <CodeBlock
                    code="cscli bouncers add caddy"
                    language="bash"
                    hasLanguageLabel={false}
                    size="sm"
                    width="100%"
                  />
                </VStack>
              )}
              <HStack justify="start" gap={2}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  label={testing ? tCommon("testing") : tCommon("test")}
                  isDisabled={testing || !apiUrl.trim()}
                  onClick={runTest}
                />
              </HStack>
              {testResult?.message && (
                <StatusAlert message={testResult.message} success={testResult.success} />
              )}
              <TextInput
                startIcon={Link}
                {...AUTOFILL_OFF}
                label={t("appsecUrl")}
                isOptional
                description={t("appsecUrlHelp")}
                htmlName="crowdsecAppsecUrl"
                value={appsecUrl}
                onChange={setAppsecUrl}
                placeholder="http://crowdsec:7422"
              />
            </>
          )}

          {appsecOn && (
            <Switch
              label={t("appsecFailOpen")}
              description={t("appsecFailOpenHelp")}
              htmlName="crowdsecAppsecFailOpen"
              value={appsecFailOpen}
              onChange={setAppsecFailOpen}
            />
          )}
          <TextInput
            startIcon={Clock}
            {...AUTOFILL_OFF}
            label={t("tickerInterval")}
            description={t("tickerIntervalHelp")}
            htmlName="crowdsecTickerInterval"
            value={tickerInterval}
            onChange={setTickerInterval}
            placeholder="60s"
          />
          <InfoAlert title={t("trustedProxiesTitle")}>{t("trustedProxiesBody")}</InfoAlert>
        </VStack>
      </form>
    </FormCard>
  );
}
