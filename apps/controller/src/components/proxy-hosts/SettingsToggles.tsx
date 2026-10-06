"use client";

import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import { useTranslations } from "next-intl";
import type { HostCompressionMode } from "@/lib/proxy-hosts/compression";

type ToggleKey =
  | "sslForced"
  | "hstsEnabled"
  | "hstsSubdomains"
  | "allowWebsocket"
  | "preserveHostHeader"
  | "skipHttpsHostnameValidation"
  | "discourageIndexing";

type ToggleSetting = {
  key: ToggleKey;
  labelKey:
    | "forceHttps"
    | "hsts"
    | "hstsSubdomains"
    | "websocketSupport"
    | "preserveHostHeader"
    | "skipHttpsValidation"
    | "discourageIndexing";
  descriptionKey:
    | "forceHttpsHelp"
    | "hstsHelp"
    | "hstsSubdomainsHelp"
    | "websocketSupportHelp"
    | "preserveHostHeaderHelp"
    | "skipHttpsValidationHelp"
    | "discourageIndexingHelp";
  /** Only meaningful while this other toggle is on; disabled (and so submitted off) otherwise. */
  requires?: ToggleKey;
  /** Hidden on the managed dashboard host, which derives these from its own settings. */
  hostOnly?: boolean;
};

type SettingsTogglesProps = {
  sslForced?: boolean;
  hstsEnabled?: boolean;
  hstsSubdomains?: boolean;
  allowWebsocket?: boolean;
  preserveHostHeader?: boolean;
  skipHttpsValidation?: boolean;
  discourageIndexing?: boolean;
  enabled?: boolean;
  compression?: HostCompressionMode;
  /** Off for the dashboard host, whose form already posts its own `enabled` field. */
  showEnabled?: boolean;
  /** The host editor renders the enabled banner and the options card in different sections. */
  part?: "both" | "enabled" | "options";
};

// HSTS follows NPM: it pins browsers to HTTPS, which is only safe once HTTP is redirected.
const SETTINGS: ToggleSetting[] = [
  { key: "sslForced", labelKey: "forceHttps", descriptionKey: "forceHttpsHelp", hostOnly: true },
  {
    key: "hstsEnabled",
    labelKey: "hsts",
    descriptionKey: "hstsHelp",
    requires: "sslForced",
    hostOnly: true,
  },
  {
    key: "hstsSubdomains",
    labelKey: "hstsSubdomains",
    descriptionKey: "hstsSubdomainsHelp",
    requires: "hstsEnabled",
  },
  {
    key: "allowWebsocket",
    labelKey: "websocketSupport",
    descriptionKey: "websocketSupportHelp",
    hostOnly: true,
  },
  {
    key: "preserveHostHeader",
    labelKey: "preserveHostHeader",
    descriptionKey: "preserveHostHeaderHelp",
    hostOnly: true,
  },
  {
    key: "skipHttpsHostnameValidation",
    labelKey: "skipHttpsValidation",
    descriptionKey: "skipHttpsValidationHelp",
  },
  {
    key: "discourageIndexing",
    labelKey: "discourageIndexing",
    descriptionKey: "discourageIndexingHelp",
    hostOnly: true,
  },
];

export function SettingsToggles({
  sslForced = true,
  hstsEnabled = true,
  hstsSubdomains = false,
  allowWebsocket = true,
  preserveHostHeader = true,
  skipHttpsValidation = false,
  discourageIndexing = false,
  enabled = true,
  compression: initialCompression = "inherit",
  showEnabled = true,
  part = "both",
}: SettingsTogglesProps) {
  const t = useTranslations("proxyHosts");
  const [compression, setCompression] = useState<HostCompressionMode>(initialCompression);
  const [values, setValues] = useState({
    sslForced,
    hstsEnabled,
    hstsSubdomains,
    allowWebsocket,
    preserveHostHeader,
    skipHttpsHostnameValidation: skipHttpsValidation,
    discourageIndexing,
    enabled,
  });
  const settings = showEnabled ? SETTINGS : SETTINGS.filter((setting) => !setting.hostOnly);
  // A prerequisite that isn't rendered (the dashboard host has no HSTS toggle) never blocks.
  const isBlocked = (setting: ToggleSetting): boolean => {
    const parent = settings.find((s) => s.key === setting.requires);
    return parent !== undefined && (!values[parent.key] || isBlocked(parent));
  };

  const handleChange = (name: keyof typeof values) => (checked: boolean) =>
    setValues((prev) => ({ ...prev, [name]: checked }));

  return (
    <VStack gap={6}>
      {showEnabled && part !== "options" && (
        <>
          <input type="hidden" name="enabledPresent" value="1" />
          <input type="hidden" name="enabled" value={values.enabled ? "on" : ""} />

          <Banner
            status={values.enabled ? "success" : "warning"}
            title={values.enabled ? t("proxyHostEnabledTitle") : t("proxyHostPausedTitle")}
            description={
              values.enabled ? t("proxyHostActiveDescription") : t("proxyHostPausedDescription")
            }
            endContent={
              <Switch
                label={t("proxyHostEnabled")}
                isLabelHidden
                value={values.enabled}
                onChange={handleChange("enabled")}
              />
            }
          />
        </>
      )}

      {part !== "enabled" && (
        <Card>
          <VStack gap={3}>
            <Text type="body" size="sm" weight="semibold">
              {t("advancedOptions")}
            </Text>
            <Divider />
            {settings.map((setting, index) => {
              const blocked = isBlocked(setting);
              return (
                <VStack key={setting.key} gap={3}>
                  {index > 0 && <Divider />}
                  <input type="hidden" name={`${setting.key}Present`} value="1" />
                  <Switch
                    label={t(setting.labelKey)}
                    description={t(setting.descriptionKey)}
                    htmlName={setting.key}
                    labelPosition="start"
                    labelSpacing="spread"
                    value={blocked ? false : values[setting.key]}
                    isDisabled={blocked}
                    onChange={handleChange(setting.key)}
                  />
                </VStack>
              );
            })}
            {showEnabled && (
              <>
                <Divider />
                <input type="hidden" name="compression" value={compression} />
                <HStack justify="between" vAlign="center" gap={4}>
                  <VStack gap={1}>
                    <Text type="body" size="sm">
                      {t("compression")}
                    </Text>
                    <Text type="body" size="sm" color="secondary">
                      {t("compressionHelp")}
                    </Text>
                  </VStack>
                  <SegmentedControl
                    label={t("compression")}
                    size="sm"
                    value={compression}
                    onChange={(next) => setCompression(next as HostCompressionMode)}
                  >
                    <SegmentedControlItem value="inherit" label={t("compressionInherit")} />
                    <SegmentedControlItem value="on" label={t("compressionOn")} />
                    <SegmentedControlItem value="off" label={t("compressionOff")} />
                  </SegmentedControl>
                </HStack>
              </>
            )}
          </VStack>
        </Card>
      )}
    </VStack>
  );
}
