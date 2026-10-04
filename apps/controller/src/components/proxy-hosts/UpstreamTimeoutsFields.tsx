"use client";

import { Clock } from "lucide-react";
import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { NO_SPELLCHECK } from "@/components/ui/native-input-attrs";
import { isCaddyDuration } from "@/lib/caddy-duration";
import {
  type HostUpstreamTimeoutsConfig,
  UPSTREAM_TIMEOUT_KEYS,
  type UpstreamTimeoutKey,
} from "@/lib/host-upstream-timeouts";
import { Switch } from "@/src/components/ui/FormBooleanControls";

const PLACEHOLDERS: Record<UpstreamTimeoutKey, string> = {
  dialTimeout: "3s",
  responseHeaderTimeout: "30s",
  readTimeout: "5m",
  writeTimeout: "5m",
  keepAliveIdleTimeout: "2m",
  streamTimeout: "24h",
  streamCloseDelay: "5m",
};

/** Field names are the API's keys, so the parser needs no mapping. */
export function UpstreamTimeoutsFields({
  upstreamTimeouts,
}: {
  upstreamTimeouts?: HostUpstreamTimeoutsConfig | null;
}) {
  const t = useTranslations("proxyHosts");
  const [enabled, setEnabled] = useState(Boolean(upstreamTimeouts));
  const [values, setValues] = useState<Record<UpstreamTimeoutKey, string>>(
    () =>
      Object.fromEntries(
        UPSTREAM_TIMEOUT_KEYS.map((key) => [key, upstreamTimeouts?.[key] ?? ""]),
      ) as Record<UpstreamTimeoutKey, string>,
  );

  return (
    <Card>
      <input type="hidden" name="upstreamTimeoutsPresent" value="1" />
      <VStack gap={4}>
        <HStack justify="between" vAlign="center" gap={4}>
          <VStack gap={1}>
            <Text type="body" size="sm" weight="semibold">
              {t("upstreamTimeouts")}
            </Text>
            <Text type="body" size="sm" color="secondary">
              {t("upstreamTimeoutsDescription")}
            </Text>
          </VStack>
          <Switch
            label={t("enableUpstreamTimeouts")}
            isLabelHidden
            htmlName="upstreamTimeoutsEnabled"
            value={enabled}
            onChange={setEnabled}
          />
        </HStack>

        {/* Unmounted, so switching it off clears them. */}
        {enabled && (
          <VStack gap={4}>
            <Grid columns={{ minWidth: 240, max: 2 }} gap={4}>
              {UPSTREAM_TIMEOUT_KEYS.map((key) => {
                const value = values[key].trim();
                return (
                  <TextInput
                    startIcon={Clock}
                    {...NO_SPELLCHECK}
                    key={key}
                    label={t(`upstreamTimeoutFields.${key}.label`)}
                    description={t(`upstreamTimeoutFields.${key}.help`)}
                    isOptional
                    htmlName={`upstreamTimeouts.${key}`}
                    placeholder={PLACEHOLDERS[key]}
                    value={values[key]}
                    onChange={(next) => setValues((prev) => ({ ...prev, [key]: next }))}
                    status={
                      value && !isCaddyDuration(value)
                        ? { type: "error", message: t("upstreamTimeoutInvalid") }
                        : undefined
                    }
                  />
                );
              })}
            </Grid>
            <Banner status="info" title={t("upstreamTimeoutsTailscaleNote")} />
          </VStack>
        )}
      </VStack>
    </Card>
  );
}
