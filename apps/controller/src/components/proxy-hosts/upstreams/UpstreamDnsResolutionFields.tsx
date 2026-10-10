"use client";

import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";
import type { ProxyHost } from "@/lib/models/proxy-hosts";
import { useTranslations } from "next-intl";

// Labels resolve at render: `useTranslations` only exists inside the component.
type ResolutionMode = "inherit" | "enabled" | "disabled";
type FamilyMode = "inherit" | "ipv6" | "ipv4" | "both";

const MODE_OPTIONS = [
  { value: "inherit", key: "optDnsFamilyInherit" },
  { value: "enabled", key: "optDnsEnabled" },
  { value: "disabled", key: "optDnsDisabled" },
] as const;

const FAMILY_OPTIONS = [
  { value: "inherit", key: "optDnsFamilyInherit" },
  { value: "both", key: "optDnsFamilyBoth" },
  { value: "ipv6", key: "optDnsFamilyIpv6" },
  { value: "ipv4", key: "optDnsFamilyIpv4" },
] as const;

function toResolutionMode(enabled: boolean | null | undefined): ResolutionMode {
  if (enabled === true) return "enabled";
  if (enabled === false) return "disabled";
  return "inherit";
}

function toFamilyMode(family: "ipv6" | "ipv4" | "both" | null | undefined): FamilyMode {
  if (family === "ipv6" || family === "ipv4" || family === "both") {
    return family;
  }
  return "inherit";
}

export function UpstreamDnsResolutionFields({
  upstreamDnsResolution,
}: {
  upstreamDnsResolution?: ProxyHost["upstreamDnsResolution"] | null;
}) {
  const t = useTranslations("proxyHosts");
  const tSettings = useTranslations("settings");
  const mode = toResolutionMode(upstreamDnsResolution?.enabled);
  const family = toFamilyMode(upstreamDnsResolution?.family);
  const [currentMode, setCurrentMode] = useState<ResolutionMode>(mode);
  const [currentFamily, setCurrentFamily] = useState<FamilyMode>(family);

  const summary =
    currentMode === "inherit" && currentFamily === "inherit"
      ? t("dnsPinningSummaryInherit")
      : t("dnsPinningSummaryOverride", { mode: currentMode, family: currentFamily });

  return (
    <Card>
      <input type="hidden" name="upstreamDnsResolutionPresent" value="1" />

      <Collapsible
        defaultIsOpen={mode !== "inherit" || family !== "inherit"}
        trigger={
          <VStack gap={1} hAlign="start">
            <Text type="body" size="sm" weight="semibold">
              {t("upstreamDnsPinning")}
            </Text>
            <Text type="body" size="sm" color="secondary">
              {summary}
            </Text>
          </VStack>
        }
      >
        <VStack gap={4}>
          <input type="hidden" name="upstreamDnsResolutionMode" value={currentMode} />
          <Selector
            label={t("resolutionMode")}
            options={MODE_OPTIONS.map((o) => ({ value: o.value, label: t(o.key) }))}
            value={currentMode}
            onChange={(next) => setCurrentMode(next as ResolutionMode)}
            description={t("dnsPinningModeHelp")}
          />

          <input type="hidden" name="upstreamDnsResolutionFamily" value={currentFamily} />
          <Selector
            label={t("addressFamilyPreference")}
            options={FAMILY_OPTIONS.map((o) => ({ value: o.value, label: t(o.key) }))}
            value={currentFamily}
            onChange={(next) => setCurrentFamily(next as FamilyMode)}
            description={tSettings("dnsAddressFamilyHelp")}
          />

          <Banner
            status="info"
            title={t("dnsPinningInfoTitle")}
            description={t("dnsPinningInfoDescription")}
          />
        </VStack>
      </Collapsible>
    </Card>
  );
}
