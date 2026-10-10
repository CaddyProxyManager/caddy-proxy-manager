"use client";

import { useState, useEffect, useMemo } from "react";
import { Globe, Home, Link, Plus, X } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Divider } from "@astryxdesign/core/Divider";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import type { GeoBlockSettings } from "@/lib/settings";
import type { GeoBlockMode } from "@/lib/models/proxy-hosts";
import { withRowId, withRowIds, type WithRowId } from "@/lib/forms/row-id";
import { regionName } from "@/lib/locale/region-names";
import { COUNTRY_CODES } from "./countries";
import { FlagIcon } from "@/src/components/ui/CountryFlag";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import { ModuleGated, useDisabledReason } from "@/components/caddy-modules/ModuleGate";
import { useLocale, useTranslations } from "next-intl";

// ─── GeoIpStatus ─────────────────────────────────────────────────────────────

type GeoIpStatusData = { enabled?: boolean; country: boolean; asn: boolean } | null;

function GeoIpStatus() {
  const t = useTranslations("proxyHosts");
  const [status, setStatus] = useState<GeoIpStatusData>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/geoip-status")
      .then((r) => r.json())
      .then((d) => setStatus(d))
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <Spinner size="sm" label={t("checkingGeoipDatabases")} />;
  }

  // A deliberate off gets its own label pointing at the toggle, not a hunt for a missing database.
  const off = status?.enabled === false;
  const allLoaded = status?.country && status?.asn;
  const noneLoaded = !status?.country && !status?.asn;

  const label = off
    ? t("geoipStatus.off")
    : allLoaded
      ? t("geoipStatus.ready")
      : noneLoaded
        ? t("geoipStatus.missing")
        : t("geoipStatus.partial");
  const tooltip = off
    ? t("geoipStatus.offHelp")
    : noneLoaded
      ? t("geoipStatus.missingHelp")
      : !status?.country
        ? t("geoipStatus.countryMissingHelp")
        : !status?.asn
          ? t("geoipStatus.asnMissingHelp")
          : t("geoipStatus.loadedHelp");

  return (
    <Tooltip content={tooltip}>
      <Badge label={label} variant={allLoaded ? "success" : noneLoaded ? "error" : "warning"} />
    </Tooltip>
  );
}

// ─── Pickers ──────────────────────────────────────────────────────────────────

const CONTINENTS = [
  { code: "AF", nameKey: "continentNames.africa", emoji: "🌍" },
  { code: "AN", nameKey: "continentNames.antarctica", emoji: "🧊" },
  { code: "AS", nameKey: "continentNames.asia", emoji: "🌏" },
  { code: "EU", nameKey: "continentNames.europe", emoji: "🌍" },
  { code: "NA", nameKey: "continentNames.northAmerica", emoji: "🌎" },
  { code: "OC", nameKey: "continentNames.oceania", emoji: "🌏" },
  { code: "SA", nameKey: "continentNames.southAmerica", emoji: "🌎" },
] as const;

/** By name and flag only: the code is what gets saved, not what anyone reads. */
function countryOptions(locale: string) {
  return COUNTRY_CODES.map((code) => ({ code, name: regionName(code, locale) }))
    .sort((a, b) => a.name.localeCompare(b.name, locale))
    .map(({ code, name }) => ({ value: code, label: name }));
}

/** The hidden input keeps the submitted comma-joined value byte-identical for the server action. */
function CodeMultiSelect({
  name,
  label,
  options,
  initialValues = [],
  searchPlaceholder,
  hasFlags = false,
}: {
  name: string;
  label: string;
  /** Values are country codes: each option leads with its flag. */
  hasFlags?: boolean;
  options: { value: string; label: string }[];
  initialValues?: string[];
  searchPlaceholder?: string;
}) {
  const t = useTranslations("proxyHosts");
  const [selected, setSelected] = useState<string[]>(() =>
    initialValues.map((c) => c.toUpperCase()).filter(Boolean),
  );

  return (
    <>
      <input type="hidden" name={name} value={selected.join(",")} />
      <MultiSelector
        label={label}
        options={options}
        value={selected}
        onChange={setSelected}
        hasSearch={Boolean(searchPlaceholder)}
        searchPlaceholder={searchPlaceholder}
        hasSelectAll
        triggerDisplay="badges"
        maxBadges={6}
        placeholder={t("noneSelected")}
        renderOption={
          hasFlags
            ? (option) => (
                <HStack as="span" gap={2} vAlign="center">
                  <FlagIcon code={option.value} />
                  <Text type="inherit" maxLines={1}>
                    {option.label ?? option.value}
                  </Text>
                </HStack>
              )
            : undefined
        }
      />
    </>
  );
}

// ─── TagInput ────────────────────────────────────────────────────────────────

type TagInputProps = {
  name: string;
  label: string;
  initialValues?: string[];
  placeholder?: string;
  helperText?: string;
  validate?: (value: string) => boolean;
  uppercase?: boolean;
};

function TagInput({
  name,
  label,
  initialValues = [],
  placeholder,
  helperText,
  validate,
  uppercase = false,
}: TagInputProps) {
  const t = useTranslations("proxyHosts");
  const [tags, setTags] = useState<string[]>(initialValues);
  const [draft, setDraft] = useState("");

  function commit(raw: string) {
    const value = uppercase ? raw.trim().toUpperCase() : raw.trim();
    if (!value) return;
    if (validate && !validate(value)) return;
    setTags((prev) => (prev.includes(value) ? prev : [...prev, value]));
    setDraft("");
  }

  return (
    <VStack gap={2}>
      <input type="hidden" name={name} value={tags.join(",")} />

      {tags.length > 0 && (
        <HStack gap={2} wrap="wrap">
          {tags.map((tag) => (
            <Token
              key={tag}
              size="sm"
              label={tag}
              onRemove={() => setTags((prev) => prev.filter((existing) => existing !== tag))}
            />
          ))}
        </HStack>
      )}

      <HStack gap={2} vAlign="end">
        <TextInput
          label={label}
          size="sm"
          value={draft}
          onChange={setDraft}
          placeholder={placeholder}
          description={helperText}
          onEnter={() => commit(draft)}
          // The design system fires onEnter without preventing default, so Enter would also submit
          // the form and re-apply Caddy on every tag added.
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
          onBlur={() => commit(draft)}
        />
        <IconButton
          variant="ghost"
          size="sm"
          label={t("addToLabel", { label })}
          icon={<Plus />}
          onClick={() => commit(draft)}
        />
      </HStack>
    </VStack>
  );
}

// ─── ResponseHeadersEditor ────────────────────────────────────────────────────

type HeaderRow = { key: string; value: string };

function ResponseHeadersEditor({ initialHeaders }: { initialHeaders: Record<string, string> }) {
  const t = useTranslations("proxyHosts");
  const [rows, setRows] = useState<WithRowId<HeaderRow>[]>(() =>
    withRowIds(Object.entries(initialHeaders).map(([key, value]) => ({ key, value }))),
  );

  return (
    <VStack gap={2}>
      <HStack justify="between" vAlign="center">
        <Text type="body" size="sm" weight="semibold">
          {t("customResponseHeaders")}
        </Text>
        <IconButton
          variant="ghost"
          size="sm"
          label={t("addResponseHeader")}
          icon={<Plus />}
          onClick={() => setRows((prev) => [...prev, withRowId({ key: "", value: "" })])}
        />
      </HStack>

      {rows.length === 0 ? (
        <Text type="supporting">{t("responseHeadersEmptyDescription")}</Text>
      ) : (
        <VStack gap={2}>
          {rows.map((row, i) => (
            <HStack key={row.rowId} gap={2} vAlign="end">
              <input type="hidden" name="geoblockResponseHeadersKeys[]" value={row.key} />
              <input type="hidden" name="geoblockResponseHeadersValues[]" value={row.value} />
              <TextInput
                label={t("header")}
                isLabelHidden={i > 0}
                size="sm"
                placeholder={t("header")}
                value={row.key}
                onChange={(next) =>
                  setRows((prev) =>
                    prev.map((r) => (r.rowId === row.rowId ? { ...r, key: next } : r)),
                  )
                }
              />
              <TextInput
                label={t("value")}
                isLabelHidden={i > 0}
                size="sm"
                placeholder={t("value")}
                value={row.value}
                onChange={(next) =>
                  setRows((prev) =>
                    prev.map((r) => (r.rowId === row.rowId ? { ...r, value: next } : r)),
                  )
                }
              />
              <IconButton
                variant="ghost"
                size="sm"
                label={t("removeHeaderLabel", { index: i + 1 })}
                icon={<X />}
                onClick={() => setRows((prev) => prev.filter((r) => r.rowId !== row.rowId))}
              />
            </HStack>
          ))}
        </VStack>
      )}
    </VStack>
  );
}

// ─── RulesPanel ───────────────────────────────────────────────────────────────

type RulesPanelProps = {
  prefix: "block" | "allow";
  initial: GeoBlockSettings | null;
  resetKey?: number;
};

function RulesPanel({ prefix, initial, resetKey = 0 }: RulesPanelProps) {
  const t = useTranslations("proxyHosts");
  const locale = useLocale();
  const countryOptionsForLocale = useMemo(() => countryOptions(locale), [locale]);
  const cap = prefix === "block" ? "Block" : "Allow";
  const countries =
    prefix === "block" ? (initial?.block_countries ?? []) : (initial?.allow_countries ?? []);
  const continents =
    prefix === "block" ? (initial?.block_continents ?? []) : (initial?.allow_continents ?? []);
  const asns = prefix === "block" ? (initial?.block_asns ?? []) : (initial?.allow_asns ?? []);
  const cidrs = prefix === "block" ? (initial?.block_cidrs ?? []) : (initial?.allow_cidrs ?? []);
  const ips = prefix === "block" ? (initial?.block_ips ?? []) : (initial?.allow_ips ?? []);
  const continentOptions = CONTINENTS.map((c) => ({
    value: c.code,
    label: t("continentOption", { emoji: c.emoji, name: t(c.nameKey), code: c.code }),
  }));

  return (
    <VStack gap={6}>
      <CodeMultiSelect
        key={`${prefix}-countries-${resetKey}`}
        name={`geoblock${cap}Countries`}
        label={t("countries")}
        options={countryOptionsForLocale}
        initialValues={countries}
        searchPlaceholder={t("searchCountries")}
        hasFlags
      />

      <Divider />

      <CodeMultiSelect
        key={`${prefix}-continents-${resetKey}`}
        name={`geoblock${cap}Continents`}
        label={t("continents")}
        options={continentOptions}
        initialValues={continents}
      />

      <Divider />

      <TagInput
        key={`${prefix}-asns-${resetKey}`}
        name={`geoblock${cap}Asns`}
        label={t("asns")}
        initialValues={asns.map(String)}
        placeholder="13335, 15169…"
        helperText={t("asnsHelp")}
        validate={(v) => /^\d+$/.test(v)}
      />

      <Grid columns={2} gap={4}>
        <TagInput
          key={`${prefix}-cidrs-${resetKey}`}
          name={`geoblock${cap}Cidrs`}
          label={t("cidrs")}
          initialValues={cidrs}
          placeholder="10.0.0.0/8…"
          helperText={t("pressEnterToAdd")}
        />
        <TagInput
          key={`${prefix}-ips-${resetKey}`}
          name={`geoblock${cap}Ips`}
          label={t("ipAddresses")}
          initialValues={ips}
          placeholder="1.2.3.4…"
          helperText={t("pressEnterToAdd")}
        />
      </Grid>
    </VStack>
  );
}

// ─── GeoBlockFields ───────────────────────────────────────────────────────────

type GeoBlockFieldsProps = {
  initialValues?: {
    geoblock: GeoBlockSettings | null;
    geoblock_mode: GeoBlockMode;
  };
  showModeSelector?: boolean;
};

const RFC1918_CIDRS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
const BLOCK_ALL_CIDR = "0.0.0.0/0";

export function GeoBlockFields({ initialValues, showModeSelector = true }: GeoBlockFieldsProps) {
  const t = useTranslations("proxyHosts");
  const tSettings = useTranslations("settings");
  const rawInitial = initialValues?.geoblock ?? null;
  // Rules without the caddy-blocker plugin would never be emitted, so the switch is locked.
  const moduleDisabledReason = useDisabledReason("geoblock");
  const [enabled, setEnabled] = useState(rawInitial?.enabled ?? false);
  const [mode, setMode] = useState<GeoBlockMode>(initialValues?.geoblock_mode ?? "merge");
  const [resetKey, setResetKey] = useState(0);
  const [initial, setInitial] = useState<GeoBlockSettings | null>(rawInitial);
  const [activeTab, setActiveTab] = useState("block");

  // A host may leave these blank to inherit; the global settings always hold a value.
  const inherits = showModeSelector;
  const statusDefault = inherits ? null : 403;
  const bodyDefault = inherits ? "" : "Forbidden";
  const [responseStatus, setResponseStatus] = useState<number | null>(
    rawInitial?.response_status ?? statusDefault,
  );
  const [responseBody, setResponseBody] = useState(rawInitial?.response_body ?? bodyDefault);
  const [redirectUrl, setRedirectUrl] = useState(rawInitial?.redirect_url ?? "");
  const [failClosed, setFailClosed] = useState(rawInitial?.fail_closed ?? false);

  // useState seeds are read once, so fresh props after a save would not show without this (#241).
  // Bumping resetKey remounts the tag inputs, which hold their own copies.
  useEffect(() => {
    setEnabled(rawInitial?.enabled ?? false);
    setMode(initialValues?.geoblock_mode ?? "merge");
    setInitial(rawInitial);
    setResponseStatus(rawInitial?.response_status ?? statusDefault);
    setResponseBody(rawInitial?.response_body ?? bodyDefault);
    setRedirectUrl(rawInitial?.redirect_url ?? "");
    setFailClosed(rawInitial?.fail_closed ?? false);
    setResetKey((k) => k + 1);
  }, [rawInitial, initialValues?.geoblock_mode, statusDefault, bodyDefault]);

  const headers = useMemo(() => initial?.response_headers ?? {}, [initial]);

  function applyLanOnlyPreset() {
    setEnabled(true);
    setInitial((prev) => ({
      enabled: true,
      block_countries: prev?.block_countries ?? [],
      block_continents: prev?.block_continents ?? [],
      block_asns: prev?.block_asns ?? [],
      block_cidrs: [BLOCK_ALL_CIDR],
      block_ips: prev?.block_ips ?? [],
      allow_countries: prev?.allow_countries ?? [],
      allow_continents: prev?.allow_continents ?? [],
      allow_asns: prev?.allow_asns ?? [],
      allow_cidrs: RFC1918_CIDRS,
      allow_ips: prev?.allow_ips ?? [],
      trusted_proxies: prev?.trusted_proxies ?? [],
      fail_closed: prev?.fail_closed ?? false,
      response_status: prev?.response_status ?? 403,
      response_body: prev?.response_body ?? "Forbidden",
      response_headers: prev?.response_headers ?? {},
      redirect_url: prev?.redirect_url ?? "",
    }));
    setResetKey((k) => k + 1);
  }

  return (
    <Card>
      <input type="hidden" name="geoblockPresent" value="1" />
      <input type="hidden" name="geoblockMode" value={mode} />

      <VStack gap={4}>
        <HStack justify="between" vAlign="start" gap={2}>
          <HStack gap={3} vAlign="start">
            <Icon icon={Globe} size="md" color="error" />
            <VStack gap={1}>
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Text type="body" size="sm" weight="bold">
                  {t("geoBlocking")}
                </Text>
                <GeoIpStatus />
              </HStack>
              <Text type="body" size="sm" color="secondary">
                {t("geoblockDescription")}
              </Text>
            </VStack>
          </HStack>
          {/* A disabled control emits no pointer events, so ModuleGated carries the tooltip. */}
          <ModuleGated feature="geoblock">
            <Switch
              label={t("enableGeoBlocking")}
              isLabelHidden
              htmlName="geoblockEnabled"
              value={enabled}
              onChange={setEnabled}
              isDisabled={Boolean(moduleDisabledReason)}
            />
          </ModuleGated>
        </HStack>

        {moduleDisabledReason && <Text type="supporting">{moduleDisabledReason}</Text>}

        {/* Deliberately NOT gated on moduleDisabledReason: `geoblockPresent` always submits and a
            missing rule input parses as empty, so unmounting these would erase every stored rule
            on the next unrelated save. */}
        {enabled && (
          <VStack gap={4}>
            {showModeSelector && (
              <>
                <SegmentedControl
                  label={t("globalRuleHandling")}
                  value={mode}
                  onChange={(next) => setMode(next as GeoBlockMode)}
                >
                  <SegmentedControlItem value="merge" label={t("mergeWithGlobal")} />
                  <SegmentedControlItem value="override" label={t("overrideGlobal")} />
                </SegmentedControl>
                <Divider />
              </>
            )}
            {!showModeSelector && <Divider />}

            <HStack gap={2} vAlign="center">
              <Text type="body" size="sm" color="secondary">
                {t("presets")}
              </Text>
              <Button
                size="sm"
                variant="secondary"
                label={t("lanOnlyRfc1918")}
                icon={<Home />}
                onClick={applyLanOnlyPreset}
              />
            </HStack>

            <TabList value={activeTab} onChange={setActiveTab} layout="fill">
              <Tab value="block" label={t("blockRules")} />
              <Tab value="allow" label={t("allowRules")} />
            </TabList>

            {/* Hidden, not unmounted: each panel carries its side's hidden inputs, and dropping
                them would submit empty values and wipe the other tab's configuration. */}
            <VStack gap={4}>
              <div hidden={activeTab !== "block"}>
                <RulesPanel prefix="block" initial={initial} resetKey={resetKey} />
              </div>
              <div hidden={activeTab !== "allow"}>
                <VStack gap={3}>
                  <Text type="supporting">{t("geoblockAllowPrecedenceHelp")}</Text>
                  <RulesPanel prefix="allow" initial={initial} resetKey={resetKey} />
                </VStack>
              </div>
            </VStack>

            <Collapsible
              trigger={
                <Text type="label" size="lg">
                  {t("trustedProxiesBlockResponse")}
                </Text>
              }
            >
              <VStack gap={4}>
                <TagInput
                  key={`trusted-proxies-${resetKey}`}
                  name="geoblockTrustedProxies"
                  label={t("trustedProxies")}
                  initialValues={initial?.trusted_proxies ?? []}
                  placeholder={t("trustedProxiesPlaceholder")}
                  helperText={t("trustedProxiesHelp")}
                />

                <Switch
                  label={t("geoblockFailClosedLabel")}
                  description={t("geoblockFailClosedHelp")}
                  htmlName="geoblockFailClosed"
                  value={failClosed}
                  onChange={setFailClosed}
                />

                <Divider />

                <Grid columns={3} gap={4}>
                  <NumberInput
                    hasNumberSteppers
                    label={tSettings("statusCode")}
                    htmlName="geoblockResponseStatus"
                    min={100}
                    max={599}
                    isIntegerOnly
                    value={responseStatus}
                    onChange={setResponseStatus}
                    placeholder={inherits ? "403" : undefined}
                    description={
                      inherits ? t("geoblockStatusCodeInheritHelp") : t("geoblockStatusCodeHelp")
                    }
                  />
                  <TextInput
                    label={tSettings("responseBody")}
                    htmlName="geoblockResponseBody"
                    value={responseBody}
                    onChange={setResponseBody}
                    placeholder={inherits ? "Forbidden" : undefined}
                    description={
                      inherits
                        ? t("geoblockResponseBodyInheritHelp")
                        : t("geoblockResponseBodyHelp")
                    }
                  />
                  <TextInput
                    startIcon={Link}
                    label={t("redirectUrl")}
                    htmlName="geoblockRedirectUrl"
                    value={redirectUrl}
                    onChange={setRedirectUrl}
                    placeholder="https://example.com/blocked"
                    description={t("geoblockRedirectHelp")}
                  />
                </Grid>

                <ResponseHeadersEditor key={`headers-${resetKey}`} initialHeaders={headers} />
              </VStack>
            </Collapsible>
          </VStack>
        )}
      </VStack>
    </Card>
  );
}
