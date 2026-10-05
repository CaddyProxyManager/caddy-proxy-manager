"use client";

import { useState } from "react";
import { Clock, Plus, Route, Trash2 } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Grid } from "@astryxdesign/core/Grid";
import { IconButton } from "@astryxdesign/core/IconButton";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { useDisabledReason } from "@/components/caddy-modules/ModuleGate";
import { NO_SPELLCHECK } from "@/components/ui/native-input-attrs";
import { isCaddyDuration } from "@/lib/caddy/duration";
import {
  type HostRateLimitConfig,
  RATE_LIMIT_IPV6_PREFIX_MAX,
  RATE_LIMIT_IPV6_PREFIX_MIN,
  RATE_LIMIT_MAX_EVENTS,
  RATE_LIMIT_MAX_ZONES,
  type RateLimitKey,
} from "@/lib/proxy-hosts/rate-limit";
import { withRowId, withRowIds, type WithRowId } from "@/lib/forms/row-id";
import { Switch } from "@/src/components/ui/FormBooleanControls";

type ZoneState = {
  paths: string;
  maxEvents: number | null;
  window: string;
  key: RateLimitKey;
  ipv6Prefix: number | null;
};

function toState(config: HostRateLimitConfig | null | undefined): WithRowId<ZoneState>[] {
  return withRowIds(
    (config?.zones ?? []).map((zone) => ({
      paths: zone.paths.join(" "),
      maxEvents: zone.maxEvents,
      window: zone.window,
      key: zone.key,
      ipv6Prefix: zone.ipv6Prefix,
    })),
  );
}

/** The model checks every value; the editor only splits the path list. */
function toJson(zones: ZoneState[]): string {
  return JSON.stringify(
    zones.map((zone) => ({
      paths: zone.paths.split(/[\s,]+/).filter(Boolean),
      maxEvents: zone.maxEvents,
      window: zone.window.trim(),
      key: zone.key,
      ipv6Prefix: zone.key === "ip" ? zone.ipv6Prefix : null,
    })),
  );
}

export function RateLimitFields({ rateLimit }: { rateLimit?: HostRateLimitConfig | null }) {
  const t = useTranslations("proxyHosts");
  const moduleDisabledReason = useDisabledReason("ratelimit");
  const [enabled, setEnabled] = useState(rateLimit?.enabled ?? false);
  const [zones, setZones] = useState<WithRowId<ZoneState>[]>(() => toState(rateLimit));
  // Still switchable when it is already on, so a save keeps it until the module is back.
  const locked = Boolean(moduleDisabledReason) && !enabled;

  const keyOptions = [
    { value: "ip", label: t("rateLimitKeyIp") },
    { value: "ip+path", label: t("rateLimitKeyIpPath") },
  ];

  const addZone = () =>
    setZones((current) => [
      ...current,
      withRowId({ paths: "", maxEvents: 100, window: "1m", key: "ip", ipv6Prefix: 64 }),
    ]);
  const removeZone = (rowId: string) =>
    setZones((current) => current.filter((zone) => zone.rowId !== rowId));
  const updateZone = <K extends keyof ZoneState>(rowId: string, key: K, value: ZoneState[K]) =>
    setZones((current) =>
      current.map((zone) => (zone.rowId === rowId ? { ...zone, [key]: value } : zone)),
    );

  return (
    <Card>
      <input type="hidden" name="rateLimitPresent" value="1" />
      <input type="hidden" name="rateLimitZonesJson" value={toJson(zones)} />
      <VStack gap={4}>
        <HStack justify="between" vAlign="center" gap={4}>
          <VStack gap={1}>
            <Text type="body" size="sm" weight="semibold">
              {t("rateLimit")}
            </Text>
            <Text type="body" size="sm" color="secondary">
              {t("rateLimitDescription")}
            </Text>
          </VStack>
          <Switch
            label={t("enableRateLimit")}
            isLabelHidden
            htmlName="rateLimitEnabled"
            value={enabled}
            onChange={setEnabled}
            isDisabled={locked}
          />
        </HStack>

        {moduleDisabledReason && (
          <Banner
            status="warning"
            title={t("rateLimitUnavailable")}
            description={moduleDisabledReason}
          />
        )}

        {/* Zones stay mounted while off, so switching it off keeps them. */}
        {zones.map((zone, index) => {
          const window = zone.window.trim();
          return (
            <VStack key={zone.rowId} gap={3}>
              {index > 0 && <Divider />}
              <HStack justify="between" vAlign="center" gap={2}>
                <Text type="body" size="sm" weight="semibold">
                  {t("rateLimitZone", { index: index + 1 })}
                </Text>
                <IconButton
                  variant="ghost"
                  size="sm"
                  label={t("removeRateLimitZoneLabel", { index: index + 1 })}
                  icon={<Trash2 />}
                  onClick={() => removeZone(zone.rowId)}
                  isDisabled={locked}
                />
              </HStack>
              <TextInput
                startIcon={Route}
                {...NO_SPELLCHECK}
                label={t("rateLimitPaths")}
                isOptional
                size="sm"
                placeholder="/login /api/*"
                value={zone.paths}
                onChange={(next) => updateZone(zone.rowId, "paths", next)}
                description={t("rateLimitPathsHelp")}
                isDisabled={locked}
              />
              <Grid columns={{ minWidth: 160, max: 4 }} gap={3}>
                <NumberInput
                  hasNumberSteppers
                  label={t("rateLimitMaxEvents")}
                  size="sm"
                  min={1}
                  max={RATE_LIMIT_MAX_EVENTS}
                  isIntegerOnly
                  value={zone.maxEvents}
                  onChange={(next) => updateZone(zone.rowId, "maxEvents", next)}
                  isDisabled={locked}
                />
                <TextInput
                  startIcon={Clock}
                  {...NO_SPELLCHECK}
                  label={t("rateLimitWindow")}
                  size="sm"
                  placeholder="1m"
                  value={zone.window}
                  onChange={(next) => updateZone(zone.rowId, "window", next)}
                  status={
                    window && !isCaddyDuration(window)
                      ? { type: "error", message: t("rateLimitWindowInvalid") }
                      : undefined
                  }
                  isDisabled={locked}
                />
                <Selector
                  label={t("rateLimitKey")}
                  size="sm"
                  options={keyOptions}
                  value={zone.key}
                  onChange={(next) => updateZone(zone.rowId, "key", next as RateLimitKey)}
                  isDisabled={locked}
                />
                <NumberInput
                  hasNumberSteppers
                  label={t("rateLimitIpv6Prefix")}
                  isOptional
                  size="sm"
                  min={RATE_LIMIT_IPV6_PREFIX_MIN}
                  max={RATE_LIMIT_IPV6_PREFIX_MAX}
                  isIntegerOnly
                  value={zone.key === "ip" ? zone.ipv6Prefix : null}
                  onChange={(next) => updateZone(zone.rowId, "ipv6Prefix", next)}
                  isDisabled={locked || zone.key !== "ip"}
                />
              </Grid>
            </VStack>
          );
        })}

        {zones.length < RATE_LIMIT_MAX_ZONES && (
          <HStack>
            <Button
              variant="ghost"
              size="sm"
              label={t("addRateLimitZone")}
              icon={<Plus />}
              onClick={addZone}
              isDisabled={locked}
            />
          </HStack>
        )}

        <Text type="body" size="xsm" color="secondary">
          {t("rateLimitHelp")}
        </Text>
      </VStack>
    </Card>
  );
}
