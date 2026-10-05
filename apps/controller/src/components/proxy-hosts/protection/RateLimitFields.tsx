"use client";

import { useState } from "react";
import { Clock, Plus, Route, Trash2 } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Grid } from "@astryxdesign/core/Grid";
import { IconButton } from "@astryxdesign/core/IconButton";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
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
  type HostRateLimitZone,
  RATE_LIMIT_IPV6_PREFIX_MAX,
  RATE_LIMIT_IPV6_PREFIX_MIN,
  RATE_LIMIT_MAX_EVENTS,
  RATE_LIMIT_MAX_ZONES,
  RATE_LIMIT_METHODS,
  type RateLimitKey,
  type RateLimitMode,
} from "@/lib/proxy-hosts/rate-limit";
import { withRowId, withRowIds, type WithRowId } from "@/lib/forms/row-id";
import { Switch } from "@/src/components/ui/FormBooleanControls";

type ZoneState = {
  paths: string;
  methods: string[];
  maxEvents: number | null;
  window: string;
  key: RateLimitKey;
  header: string;
  ipv6Prefix: number | null;
};

function toState(zones: readonly HostRateLimitZone[] | undefined): WithRowId<ZoneState>[] {
  return withRowIds(
    (zones ?? []).map((zone) => ({
      paths: zone.paths.join(" "),
      methods: zone.methods ?? [],
      maxEvents: zone.maxEvents,
      window: zone.window,
      key: zone.key,
      header: zone.header ?? "",
      ipv6Prefix: zone.ipv6Prefix,
    })),
  );
}

/** The model checks every value; the editor only splits the path list. */
export function rateLimitZonesJson(zones: ZoneState[]): string {
  return JSON.stringify(
    zones.map((zone) => ({
      paths: zone.paths.split(/[\s,]+/).filter(Boolean),
      methods: zone.methods,
      maxEvents: zone.maxEvents,
      window: zone.window.trim(),
      key: zone.key,
      header: zone.key === "header" ? zone.header.trim() : null,
      ipv6Prefix: zone.key === "ip" ? zone.ipv6Prefix : null,
    })),
  );
}

/**
 * The zone list, shared by a host's card and the global zones in Settings. Its JSON goes to the
 * server in `htmlName`.
 */
export function RateLimitZonesEditor({
  zones: initialZones,
  htmlName,
  isDisabled = false,
}: {
  zones?: readonly HostRateLimitZone[];
  htmlName: string;
  isDisabled?: boolean;
}) {
  const t = useTranslations("proxyHosts");
  const tCommon = useTranslations("common");
  const [zones, setZones] = useState<WithRowId<ZoneState>[]>(() => toState(initialZones));

  const keyOptions = [
    { value: "ip", label: tCommon("clientIp") },
    { value: "ip+path", label: t("rateLimitKeyIpPath") },
    { value: "header", label: t("rateLimitKeyHeader") },
    { value: "user", label: t("rateLimitKeyUser") },
  ];
  const methodOptions = RATE_LIMIT_METHODS.map((method) => ({ value: method, label: method }));

  const addZone = () =>
    setZones((current) => [
      ...current,
      withRowId({
        paths: "",
        methods: [],
        maxEvents: 100,
        window: "1m",
        key: "ip",
        header: "",
        ipv6Prefix: 64,
      }),
    ]);
  const removeZone = (rowId: string) =>
    setZones((current) => current.filter((zone) => zone.rowId !== rowId));
  const updateZone = <K extends keyof ZoneState>(rowId: string, key: K, value: ZoneState[K]) =>
    setZones((current) =>
      current.map((zone) => (zone.rowId === rowId ? { ...zone, [key]: value } : zone)),
    );

  return (
    <VStack gap={4}>
      <input type="hidden" name={htmlName} value={rateLimitZonesJson(zones)} />
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
                isDisabled={isDisabled}
              />
            </HStack>
            <Grid columns={{ minWidth: 240, max: 2 }} gap={3}>
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
                isDisabled={isDisabled}
              />
              <MultiSelector
                label={t("rateLimitMethods")}
                description={t("rateLimitMethodsHelp")}
                size="sm"
                options={methodOptions}
                value={zone.methods}
                onChange={(next) => updateZone(zone.rowId, "methods", next)}
                triggerDisplay="labels"
                placeholder={t("rateLimitMethodsAll")}
                isDisabled={isDisabled}
              />
            </Grid>
            <Grid columns={{ minWidth: 160, max: 4 }} gap={3}>
              <NumberInput
                hasNumberSteppers
                label={tCommon("requests")}
                size="sm"
                min={1}
                max={RATE_LIMIT_MAX_EVENTS}
                isIntegerOnly
                value={zone.maxEvents}
                onChange={(next) => updateZone(zone.rowId, "maxEvents", next)}
                isDisabled={isDisabled}
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
                isDisabled={isDisabled}
              />
              <Selector
                label={t("rateLimitKey")}
                size="sm"
                options={keyOptions}
                value={zone.key}
                onChange={(next) => updateZone(zone.rowId, "key", next as RateLimitKey)}
                isDisabled={isDisabled}
              />
              {zone.key === "header" ? (
                <TextInput
                  {...NO_SPELLCHECK}
                  label={t("header")}
                  size="sm"
                  placeholder="X-Api-Key"
                  value={zone.header}
                  onChange={(next) => updateZone(zone.rowId, "header", next)}
                  status={
                    /[{}\s]/.test(zone.header)
                      ? { type: "error", message: t("rateLimitHeaderInvalid") }
                      : undefined
                  }
                  isDisabled={isDisabled}
                />
              ) : (
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
                  isDisabled={isDisabled || zone.key !== "ip"}
                />
              )}
            </Grid>
            {(zone.key === "header" || zone.key === "user") && (
              <Text type="supporting" size="sm">
                {zone.key === "header" ? t("rateLimitKeyHeaderHelp") : t("rateLimitKeyUserHelp")}
              </Text>
            )}
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
            isDisabled={isDisabled}
          />
        </HStack>
      )}
    </VStack>
  );
}

/**
 * A host's rate limiting. `hasModes` is off for the dashboard host, which never takes the global
 * zones: a tight one could keep out the administrator who has to loosen it.
 */
export function RateLimitFields({
  rateLimit,
  hasModes = true,
}: {
  rateLimit?: HostRateLimitConfig | null;
  hasModes?: boolean;
}) {
  const t = useTranslations("proxyHosts");
  const tSettings = useTranslations("settings");
  const moduleDisabledReason = useDisabledReason("ratelimit");
  const [enabled, setEnabled] = useState(rateLimit?.enabled ?? false);
  const [mode, setMode] = useState<RateLimitMode>(
    hasModes ? (rateLimit?.mode ?? "inherit") : "override",
  );
  // Still switchable when it is already on, so a save keeps it until the module is back.
  const locked = Boolean(moduleDisabledReason) && !enabled;
  const ownZones = mode !== "inherit";

  return (
    <Card>
      <input type="hidden" name="rateLimitPresent" value="1" />
      <input type="hidden" name="rateLimitMode" value={mode} />
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
          {ownZones && (
            <Switch
              label={t("enableRateLimit")}
              isLabelHidden
              htmlName="rateLimitEnabled"
              value={enabled}
              onChange={setEnabled}
              isDisabled={locked}
            />
          )}
        </HStack>

        {moduleDisabledReason && (
          <Banner
            status="warning"
            title={tSettings("rateLimit.unavailable")}
            description={moduleDisabledReason}
          />
        )}

        {hasModes && (
          <Selector
            label={t("rateLimitMode")}
            description={t(`rateLimitModeHelp.${mode}`)}
            size="sm"
            width={360}
            options={[
              { value: "inherit", label: t("rateLimitModes.inherit") },
              { value: "merge", label: t("rateLimitModes.merge") },
              { value: "override", label: t("rateLimitModes.override") },
            ]}
            value={mode}
            onChange={(next) => setMode((next as RateLimitMode) ?? "inherit")}
          />
        )}

        {/* Mounted whatever the mode, so a switch to inherit and back keeps the zones. */}
        <div hidden={!ownZones}>
          <RateLimitZonesEditor
            zones={rateLimit?.zones}
            htmlName="rateLimitZonesJson"
            isDisabled={locked}
          />
        </div>

        <Text type="body" size="xsm" color="secondary">
          {t("rateLimitHelp")}
        </Text>
      </VStack>
    </Card>
  );
}
