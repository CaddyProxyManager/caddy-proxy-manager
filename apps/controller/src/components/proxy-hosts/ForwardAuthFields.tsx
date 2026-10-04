"use client";

import { Link, Network, Route } from "lucide-react";
import { useEffect, useState } from "react";
import { Card } from "@astryxdesign/core/Card";
import { Selector } from "@astryxdesign/core/Selector";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import type { ForwardAuthSettings } from "@/lib/settings";
import type { ForwardAuthProvider, ProxyHost } from "@/lib/models/proxy-hosts";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import { useTranslations } from "next-intl";

/** Kept in step with DEFAULT_AUTHELIA_FORWARD_AUTH_* in the model, which stores them. */
const AUTHELIA_DEFAULT_ENDPOINT = "/api/authz/forward-auth";
const AUTHELIA_DEFAULT_HEADERS = [
  "Remote-User",
  "Remote-Groups",
  "Remote-Email",
  "Remote-Name",
  "Remote-IP",
];
const DEFAULT_TRUSTED_PROXIES = ["private_ranges"];

function formDefaults(
  forwardAuth: ProxyHost["forwardAuth"] | null,
  defaults: ForwardAuthSettings | null | undefined,
) {
  const provider: ForwardAuthProvider = forwardAuth?.provider ?? defaults?.provider ?? "authelia";
  return {
    enabled: forwardAuth?.enabled ?? false,
    provider,
    authUpstream: forwardAuth?.authUpstream ?? defaults?.authUpstream ?? "",
    authEndpoint:
      forwardAuth?.authEndpoint ??
      defaults?.authEndpoint ??
      (provider === "authelia" ? AUTHELIA_DEFAULT_ENDPOINT : ""),
    copyHeaders:
      forwardAuth && forwardAuth.copyHeaders.length > 0
        ? forwardAuth.copyHeaders.join("\n")
        : provider === "authelia"
          ? AUTHELIA_DEFAULT_HEADERS.join("\n")
          : "",
    trustedProxies:
      forwardAuth && forwardAuth.trustedProxies.length > 0
        ? forwardAuth.trustedProxies.join("\n")
        : DEFAULT_TRUSTED_PROXIES.join("\n"),
    apiSplit: forwardAuth?.apiSplit ?? false,
    apiBypassHeaders: forwardAuth?.apiBypassHeaders?.join(", ") ?? "",
    protectedPaths: forwardAuth?.protectedPaths?.join(", ") ?? "",
    excludedPaths: forwardAuth?.excludedPaths?.join(", ") ?? "",
  };
}

/** An external forward-auth server. Authentik stays separate: it knows about outposts. */
export function ForwardAuthFields({
  forwardAuth,
  defaults,
}: {
  forwardAuth?: ProxyHost["forwardAuth"] | null;
  /** Fleet-wide defaults for blank fields, as the Authentik section takes them. */
  defaults: ForwardAuthSettings | null;
}) {
  const t = useTranslations("proxyHosts");
  const initial = forwardAuth ?? null;
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<ForwardAuthProvider>("authelia");
  const [authUpstream, setAuthUpstream] = useState("");
  const [authEndpoint, setAuthEndpoint] = useState("");
  const [copyHeaders, setCopyHeaders] = useState("");
  const [trustedProxies, setTrustedProxies] = useState("");
  const [apiSplit, setApiSplit] = useState(false);
  const [apiBypassHeaders, setApiBypassHeaders] = useState("");
  const [protectedPaths, setProtectedPaths] = useState("");
  const [excludedPaths, setExcludedPaths] = useState("");

  useEffect(() => {
    const next = formDefaults(initial, defaults);
    setEnabled(next.enabled);
    setProvider(next.provider);
    setAuthUpstream(next.authUpstream);
    setAuthEndpoint(next.authEndpoint);
    setCopyHeaders(next.copyHeaders);
    setTrustedProxies(next.trustedProxies);
    setApiSplit(next.apiSplit);
    setApiBypassHeaders(next.apiBypassHeaders);
    setProtectedPaths(next.protectedPaths);
    setExcludedPaths(next.excludedPaths);
  }, [initial, defaults]);

  /** Refills the preset's two fields unless the host set them itself. */
  const onProviderChange = (next: ForwardAuthProvider) => {
    setProvider(next);
    if (next !== "authelia") return;
    if (!authEndpoint.trim()) setAuthEndpoint(AUTHELIA_DEFAULT_ENDPOINT);
    if (!copyHeaders.trim()) setCopyHeaders(AUTHELIA_DEFAULT_HEADERS.join("\n"));
  };

  return (
    <Card>
      <input type="hidden" name="forwardAuthPresent" value="1" />
      <input type="hidden" name="forwardAuthEnabledPresent" value="1" />
      <input type="hidden" name="forwardAuthEnabled" value={enabled ? "true" : "false"} />
      <input type="hidden" name="forwardAuthApiSplitPresent" value="1" />

      <VStack gap={4}>
        <HStack justify="between" vAlign="center" gap={4}>
          <VStack gap={1}>
            <Text type="body" size="sm" weight="semibold">
              {t("forwardAuth")}
            </Text>
            <Text type="body" size="sm" color="secondary">
              {t("forwardAuthDescription")}
            </Text>
          </VStack>
          <Switch
            label={t("enableForwardAuth")}
            isLabelHidden
            value={enabled}
            onChange={setEnabled}
          />
        </HStack>

        {/* Unmounted, not disabled: a disabled control drops out of the FormData. */}
        {enabled && (
          <VStack gap={4}>
            <Selector
              label={t("forwardAuthProvider")}
              htmlName="forwardAuthProvider"
              options={[
                { value: "authelia", label: t("forwardAuthProviderAuthelia") },
                { value: "custom", label: t("forwardAuthProviderCustom") },
              ]}
              value={provider}
              onChange={(next) => onProviderChange(next as ForwardAuthProvider)}
            />
            <TextInput
              startIcon={Link}
              label={t("forwardAuthUpstream")}
              htmlName="forwardAuthUpstream"
              placeholder="http://authelia:9091"
              value={authUpstream}
              onChange={setAuthUpstream}
              isRequired
              description={t("forwardAuthUpstreamHelp")}
            />
            <TextInput
              startIcon={Route}
              label={t("authEndpoint")}
              htmlName="forwardAuthEndpoint"
              isOptional={provider === "authelia"}
              isRequired={provider === "custom"}
              placeholder={AUTHELIA_DEFAULT_ENDPOINT}
              value={authEndpoint}
              onChange={setAuthEndpoint}
            />
            <TextArea
              label={t("headersToCopy")}
              isOptional
              htmlName="forwardAuthCopyHeaders"
              value={copyHeaders}
              onChange={setCopyHeaders}
              rows={3}
              description={t("forwardAuthCopyHeadersHelp")}
            />
            <TextInput
              startIcon={Network}
              label={t("trustedProxies")}
              htmlName="forwardAuthTrustedProxies"
              value={trustedProxies}
              onChange={setTrustedProxies}
            />

            <VStack gap={1}>
              <Switch
                label={t("forwardAuthApiSplitLabel")}
                description={t("forwardAuthApiSplitHelp")}
                htmlName="forwardAuthApiSplit"
                value={apiSplit}
                onChange={setApiSplit}
              />
            </VStack>

            <TextInput
              label={t("forwardAuthBypassHeaders")}
              isOptional
              htmlName="forwardAuthApiBypassHeaders"
              placeholder="X-Api-Key, Authorization"
              value={apiBypassHeaders}
              onChange={setApiBypassHeaders}
              description={t("forwardAuthBypassHeadersHelp")}
            />

            <TextArea
              label={t("protectedPaths")}
              isOptional
              htmlName="forwardAuthProtectedPaths"
              placeholder="/secret/*, /admin/*"
              value={protectedPaths}
              onChange={setProtectedPaths}
              rows={2}
              description={t("forwardAuthProtectedPathsHelp")}
            />
            <TextArea
              label={t("excludedPaths")}
              isOptional
              htmlName="forwardAuthExcludedPaths"
              placeholder="/share/*, /rest/*"
              value={excludedPaths}
              onChange={setExcludedPaths}
              rows={2}
              description={t("forwardAuthExcludedPathsHelp")}
            />
          </VStack>
        )}
      </VStack>
    </Card>
  );
}
