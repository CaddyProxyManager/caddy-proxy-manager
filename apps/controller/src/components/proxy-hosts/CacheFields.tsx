"use client";

import { Clock } from "lucide-react";
import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { useDisabledReason } from "@/components/caddy-modules/ModuleGate";
import {
  DEFAULT_CACHE_MAX_AGE,
  type HostCacheConfig,
  type HostCacheMode,
  MAX_CACHE_MAX_AGE,
  MIN_CACHE_MAX_AGE,
} from "@/lib/proxy-hosts/cache";
import { Switch } from "@/src/components/ui/FormBooleanControls";

export function CacheFields({ cache }: { cache?: HostCacheConfig | null }) {
  const t = useTranslations("proxyHosts");
  const moduleDisabledReason = useDisabledReason("cache");
  const [enabled, setEnabled] = useState(Boolean(cache));
  const [mode, setMode] = useState<HostCacheMode>(cache?.mode ?? "browser");
  const [maxAge, setMaxAge] = useState<number | null>(cache?.maxAge ?? DEFAULT_CACHE_MAX_AGE);

  return (
    <Card>
      <input type="hidden" name="cachePresent" value="1" />
      <VStack gap={4}>
        <HStack justify="between" vAlign="center" gap={4}>
          <VStack gap={1}>
            <Text type="body" size="sm" weight="semibold">
              {t("cacheAssets")}
            </Text>
            <Text type="body" size="sm" color="secondary">
              {t("cacheAssetsDescription")}
            </Text>
          </VStack>
          <Switch
            label={t("enableCacheAssets")}
            isLabelHidden
            htmlName="cacheEnabled"
            value={enabled}
            onChange={setEnabled}
          />
        </HStack>

        {/* Unmounted, so hidden fields are neither focusable nor submitted. */}
        {enabled && (
          <VStack gap={4}>
            <input type="hidden" name="cacheMode" value={mode} />
            <VStack gap={2}>
              <SegmentedControl
                label={t("cacheMode")}
                value={mode}
                onChange={(next) => setMode(next as HostCacheMode)}
              >
                <SegmentedControlItem value="browser" label={t("cacheModeBrowser")} />
                {/* Still selectable when it is already the saved mode, so a save keeps it. */}
                <SegmentedControlItem
                  value="caddy"
                  label={t("cacheModeCaddy")}
                  isDisabled={Boolean(moduleDisabledReason) && mode !== "caddy"}
                />
              </SegmentedControl>
              <Text type="body" size="sm" color="secondary">
                {mode === "caddy" ? t("cacheModeCaddyHelp") : t("cacheModeBrowserHelp")}
              </Text>
              {/* A disabled segment shows no tooltip, so the reason is spelled out. */}
              {mode !== "caddy" && moduleDisabledReason && (
                <Text type="body" size="sm" color="secondary">
                  {moduleDisabledReason}
                </Text>
              )}
            </VStack>
            {mode === "caddy" && moduleDisabledReason && (
              <Banner
                status="warning"
                title={t("cacheCaddyUnavailable")}
                description={moduleDisabledReason}
              />
            )}
            <NumberInput
              startIcon={Clock}
              hasNumberSteppers
              units={t("cacheMaxAgeUnit")}
              label={t("cacheMaxAge")}
              htmlName="cacheMaxAge"
              min={MIN_CACHE_MAX_AGE}
              max={MAX_CACHE_MAX_AGE}
              isIntegerOnly
              value={maxAge}
              onChange={setMaxAge}
              description={t("cacheMaxAgeHelp")}
            />
          </VStack>
        )}
      </VStack>
    </Card>
  );
}
