"use client";

import { Globe, Link, Network, Route } from "lucide-react";
import { useEffect, useState } from "react";
import { Card } from "@astryxdesign/core/Card";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import type { AuthentikSettings } from "@/lib/settings";
import type { ProxyHost } from "@/lib/models/proxy-hosts";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import { useTranslations } from "next-intl";

const AUTHENTIK_DEFAULT_HEADERS = [
  "X-Authentik-Username",
  "X-Authentik-Groups",
  "X-Authentik-Entitlements",
  "X-Authentik-Email",
  "X-Authentik-Name",
  "X-Authentik-Uid",
  "X-Authentik-Jwt",
  "X-Authentik-Meta-Jwks",
  "X-Authentik-Meta-Outpost",
  "X-Authentik-Meta-Provider",
  "X-Authentik-Meta-App",
  "X-Authentik-Meta-Version",
];

const AUTHENTIK_DEFAULT_TRUSTED_PROXIES = ["private_ranges"];

function getAuthentikFormDefaults(
  authentik: ProxyHost["authentik"] | null,
  defaults: AuthentikSettings | null | undefined,
) {
  return {
    enabled: authentik?.enabled ?? false,
    outpostDomain: authentik?.outpostDomain ?? defaults?.outpostDomain ?? "",
    outpostUpstream: authentik?.outpostUpstream ?? defaults?.outpostUpstream ?? "",
    authEndpoint: authentik?.authEndpoint ?? defaults?.authEndpoint ?? "",
    copyHeaders:
      authentik && authentik.copyHeaders.length > 0
        ? authentik.copyHeaders.join("\n")
        : AUTHENTIK_DEFAULT_HEADERS.join("\n"),
    trustedProxies:
      authentik && authentik.trustedProxies.length > 0
        ? authentik.trustedProxies.join("\n")
        : AUTHENTIK_DEFAULT_TRUSTED_PROXIES.join("\n"),
    setHostHeader: authentik?.setOutpostHostHeader ?? true,
  };
}

export function AuthentikFields({
  authentik,
  defaults,
}: {
  authentik?: ProxyHost["authentik"] | null;
  /** Global Authentik defaults for blank fields. Required so a call site cannot omit it (#232). */
  defaults: AuthentikSettings | null;
}) {
  const t = useTranslations("proxyHosts");
  const tSettings = useTranslations("settings");
  const initial = authentik ?? null;
  const [enabled, setEnabled] = useState(false);
  const [outpostDomain, setOutpostDomain] = useState("");
  const [outpostUpstream, setOutpostUpstream] = useState("");
  const [authEndpoint, setAuthEndpoint] = useState("");
  const [copyHeadersValue, setCopyHeadersValue] = useState("");
  const [trustedProxiesValue, setTrustedProxiesValue] = useState("");
  const [setHostHeader, setSetHostHeader] = useState(true);
  const [protectedPaths, setProtectedPaths] = useState(initial?.protectedPaths?.join(", ") ?? "");
  const [excludedPaths, setExcludedPaths] = useState(initial?.excludedPaths?.join(", ") ?? "");

  useEffect(() => {
    const next = getAuthentikFormDefaults(initial, defaults);
    setEnabled(next.enabled);
    setOutpostDomain(next.outpostDomain);
    setOutpostUpstream(next.outpostUpstream);
    setAuthEndpoint(next.authEndpoint);
    setCopyHeadersValue(next.copyHeaders);
    setTrustedProxiesValue(next.trustedProxies);
    setSetHostHeader(next.setHostHeader);
  }, [initial, defaults]);

  return (
    <Card>
      <input type="hidden" name="authentikPresent" value="1" />
      <input type="hidden" name="authentikEnabledPresent" value="1" />
      <input type="hidden" name="authentikEnabled" value={enabled ? "true" : "false"} />
      {/* Unconditional: the action reads it to decide whether to write setOutpostHostHeader. */}
      <input type="hidden" name="authentikSetHostHeaderPresent" value="1" />

      <VStack gap={4}>
        <HStack justify="between" vAlign="center" gap={4}>
          <VStack gap={1}>
            <Text type="body" size="sm" weight="semibold">
              {t("authentikForwardAuth")}
            </Text>
            <Text type="body" size="sm" color="secondary">
              {t("authentikDescription")}
            </Text>
          </VStack>
          <Switch
            label={t("enableAuthentikForwardAuth")}
            isLabelHidden
            value={enabled}
            onChange={setEnabled}
          />
        </HStack>

        {/* Unmounted when off: disabled controls never reached FormData anyway, and hidden ones
            must not be keyboard-reachable. */}
        {enabled && (
          <VStack gap={4}>
            <TextInput
              startIcon={Globe}
              label={tSettings("outpostDomain")}
              htmlName="authentikOutpostDomain"
              placeholder="outpost.goauthentik.io"
              value={outpostDomain}
              onChange={setOutpostDomain}
              isRequired
            />
            <TextInput
              startIcon={Link}
              label={t("outpostUpstreamUrl")}
              htmlName="authentikOutpostUpstream"
              placeholder="https://outpost.internal:9000"
              value={outpostUpstream}
              onChange={setOutpostUpstream}
              isRequired
            />
            <TextInput
              startIcon={Route}
              label={tSettings("authEndpoint")}
              isOptional
              htmlName="authentikAuthEndpoint"
              placeholder="/outpost.goauthentik.io/auth/caddy"
              value={authEndpoint}
              onChange={setAuthEndpoint}
            />
            <TextArea
              label={t("headersToCopy")}
              htmlName="authentikCopyHeaders"
              value={copyHeadersValue}
              onChange={setCopyHeadersValue}
              rows={3}
            />
            <TextInput
              startIcon={Network}
              label={t("trustedProxies")}
              htmlName="authentikTrustedProxies"
              value={trustedProxiesValue}
              onChange={setTrustedProxiesValue}
            />
            <TextArea
              label={t("protectedPaths")}
              isOptional
              htmlName="authentikProtectedPaths"
              placeholder="/secret/*, /admin/*"
              value={protectedPaths}
              onChange={setProtectedPaths}
              rows={2}
              description={t("forwardAuthProtectedPathsHelp")}
            />
            <TextArea
              label={t("excludedPaths")}
              isOptional
              htmlName="authentikExcludedPaths"
              placeholder="/share/*, /rest/*"
              value={excludedPaths}
              onChange={setExcludedPaths}
              rows={2}
              description={t("forwardAuthExcludedPathsHelp")}
            />

            <VStack gap={1}>
              <Switch
                label={t("authentikHostHeaderLabel")}
                description={t("authentikHostHeaderHelp")}
                htmlName="authentikSetHostHeader"
                value={setHostHeader}
                onChange={setSetHostHeader}
              />
            </VStack>
          </VStack>
        )}
      </VStack>
    </Card>
  );
}
