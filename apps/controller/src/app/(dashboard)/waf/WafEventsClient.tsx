"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActionState, useId } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Check, HardDrive, MoreHorizontal, Search, X } from "lucide-react";

import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { DateTimeInput, type ISODateTimeString } from "@astryxdesign/core/DateTimeInput";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { IconButton } from "@astryxdesign/core/IconButton";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Field } from "@astryxdesign/core/Field";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { proportional } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { CodeEditor } from "@/components/ui/CodeEditor";
import { useSeclangIssues } from "@/components/ui/seclang-issues";
import { ModuleGated, useDisabledReason } from "@/components/caddy-modules/ModuleGate";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { useMediaQuery } from "@astryxdesign/core/hooks";

import { CountryFlag } from "@/components/ui/CountryFlag";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { FilterChip } from "@/src/components/mobile/FilterChip";
import { OptionSheet } from "@/src/components/mobile/OptionSheet";
import { UrlPowerSearch, type UrlSearchField } from "@/components/ui/UrlPowerSearch";
import { useTabRoute } from "@/components/ui/useTabRoute";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import {
  bytesToMib,
  CORAZA_MAX_BODY_LIMIT,
  CORAZA_MIN_BODY_LIMIT,
  type DroppedWafDirectiveReport,
  MAX_BODY_LIMIT_MIB,
  MIN_BODY_LIMIT_MIB,
} from "@/src/lib/waf/caddy";
import { fromZonedWallTime, toZonedWallTime } from "@/src/lib/locale/date-format";
import { Timestamp } from "@/components/ui/Timestamp";
import type { WafEvent, WafEventStats } from "@/lib/models/waf-events";
import type { WafSettings } from "@/lib/settings";
import { withRowIds } from "@/lib/forms/row-id";
import { useTimeZone, useTranslations } from "next-intl";
import { useLive } from "@/src/lib/live/useLive";
import { useEmptyValue } from "@/components/ui/empty-value";
import { ACCENTS, type Hue } from "@/components/ui/accent";
import { CARD_TITLE_CLASS } from "@/components/ui/card-title";
import { SaveButton } from "@/components/ui/FormLayout";
import { WafPresetPicker } from "@/components/proxy-hosts/waf/WafPresetPicker";
import { WafPluginPicker } from "@/components/proxy-hosts/waf/WafPluginPicker";
import { WafQuickTemplates } from "@/components/proxy-hosts/waf/WafQuickTemplates";
import { WafPresetsPanel, type WafPresetRow } from "./WafPresetsPanel";
import { WafPluginsPanel, type WafPluginRow } from "./WafPluginsPanel";
import { updateWafSettingsAction } from "../settings/actions";
import {
  WafEventInsight,
  type WafEventNetwork,
  asnLabel,
} from "@/components/security/WafEventInsight";
import type { HostOption } from "@/components/security/ExclusionDialog";
import type { WafExclusion } from "@/lib/models/waf-exclusions";
import type { WafHostMode } from "@/lib/security/waf-hosts";
import {
  DEFAULT_INBOUND_THRESHOLD,
  DEFAULT_OUTBOUND_THRESHOLD,
  MAX_ANOMALY_THRESHOLD,
  MIN_ANOMALY_THRESHOLD,
  PARANOIA_LEVELS,
  effectiveTuning,
} from "@/lib/waf/tuning";
import { WafExclusionsPanel } from "./WafExclusionsPanel";
import { MODE_KEY, WafHostModesPanel } from "./WafHostModesPanel";

type Props = {
  events: WafEvent[];
  stats: WafEventStats;
  pagination: { total: number; page: number; perPage: number };
  hostOptions: string[];
  initialRange: "all" | "24h" | "7d" | "30d" | "custom";
  initialFrom: number | null;
  initialTo: number | null;
  exclusions: WafExclusion[];
  ruleMessages: Record<number, string | null>;
  globalWafEnabled: boolean;
  hosts: HostOption[];
  hostModes: WafHostMode[];
  /** Hosts whose WAF switch this user may flip. */
  manageableHostIds: number[];
  canEditDashboard: boolean;
  globalWaf: WafSettings | null;
  presets: WafPresetRow[];
  plugins: WafPluginRow[];
  pluginUpdates: Record<number, string>;
  droppedDirectives: DroppedWafDirectiveReport[];
};

type RangeOption = Props["initialRange"];

const WAF_TABS = ["events", "exclusions", "hosts", "presets", "plugins", "settings"] as const;

const MODE_HELP_KEY = {
  Off: "globalModeHelpOff",
  DetectionOnly: "globalModeHelpDetectionOnly",
  On: "globalModeHelpBlocking",
} as const satisfies Record<WafSettings["mode"], string>;

// Wall-clock values in the list's zone, so a range typed from the times on screen selects exactly
// those events; next-intl's zone, not the browser's, so server and browser render alike.
function pickerValue(unixTs: number | null, timeZone: string): string {
  return unixTs ? toZonedWallTime(unixTs, timeZone) : "";
}

/* ── Audit data types ─────────────────────────────────────────────────────── */
interface AuditRequest {
  method?: string;
  protocol?: string;
  uri?: string;
  headers?: Record<string, string | string[]>;
  body?: string;
  args?: Record<string, string | string[]>;
  length?: number;
}
interface AuditResponse {
  protocol?: string;
  status?: number;
  headers?: Record<string, string | string[]>;
  body?: string;
}
interface AuditTransaction {
  timestamp?: string;
  id?: string;
  client_ip?: string;
  client_port?: number;
  host_port?: number;
  server_id?: string;
  request?: AuditRequest;
  response?: AuditResponse;
}
interface AuditMessageDetails {
  match?: string;
  reference?: string;
  ruleId?: number;
  file?: string;
  lineNumber?: string;
  tags?: string[];
  logdata?: string;
  severity?: string;
  msg?: string;
}
interface AuditMessage {
  message?: string;
  details?: AuditMessageDetails;
  error_message?: string;
}
interface AuditData {
  transaction?: AuditTransaction;
  messages?: AuditMessage[];
}

/** Run seven times per message of every event, so compiled once per field. */
const bracketPatterns = new Map<string, RegExp>();

function bracketPattern(field: string, flags: string): RegExp {
  const key = `${field}:${flags}`;
  let pattern = bracketPatterns.get(key);
  if (!pattern) {
    pattern = new RegExp(`\\[${field} "([^"]*)"\\]`, flags);
    bracketPatterns.set(key, pattern);
  }
  // A /g regex carries lastIndex between uses, and matchAll starts from it.
  pattern.lastIndex = 0;
  return pattern;
}

function extractBracketField(message: string, field: string): string | null {
  const match = message.match(bracketPattern(field, ""));
  return match ? match[1] : null;
}

function extractBracketFields(message: string, field: string): string[] {
  return [...message.matchAll(bracketPattern(field, "g"))].map((match) => match[1]);
}

function normalizeAuditMessage(message: AuditMessage): AuditMessage {
  if (message.details || !message.error_message) return message;

  const ruleId = extractBracketField(message.error_message, "id");
  const msg = extractBracketField(message.error_message, "msg");
  const severity = extractBracketField(message.error_message, "severity");
  const logdata = extractBracketField(message.error_message, "data");
  const file = extractBracketField(message.error_message, "file");
  const lineNumber = extractBracketField(message.error_message, "line");
  const tags = extractBracketFields(message.error_message, "tag");

  return {
    ...message,
    message: message.message || msg || message.error_message,
    details: {
      ruleId: ruleId ? Number.parseInt(ruleId, 10) : undefined,
      severity: severity ?? undefined,
      msg: msg ?? undefined,
      match: logdata ?? undefined,
      logdata: logdata ?? undefined,
      file: file ?? undefined,
      lineNumber: lineNumber ?? undefined,
      tags: tags.length > 0 ? tags : undefined,
    },
  };
}

/* ── Severity config ──────────────────────────────────────────────────────── */
const SEVERITY_VARIANTS: Record<string, "error" | "warning" | "info"> = {
  CRITICAL: "error",
  ERROR: "error",
  HIGH: "error",
  WARNING: "warning",
  NOTICE: "info",
  INFO: "info",
};

/* ── Chips ───────────────────────────────────────────────────────────────── */
/** Coraza writes severities in capitals; they read as shouting beside the other badges. */
function severityLabel(severity: string): string {
  return severity.charAt(0).toUpperCase() + severity.slice(1).toLowerCase();
}

function SeverityChip({ severity }: { severity: string | null }) {
  const emptyValue = useEmptyValue();
  if (!severity) {
    return (
      <Text type="body" size="sm" color="secondary">
        {emptyValue}
      </Text>
    );
  }
  const upper = severity.toUpperCase();
  return <Badge variant={SEVERITY_VARIANTS[upper] ?? "neutral"} label={severityLabel(upper)} />;
}

function BlockedChip({ blocked }: { blocked: boolean }) {
  const t = useTranslations("waf");
  return blocked ? (
    <Badge variant="error" label={t("blocked")} />
  ) : (
    <Badge variant="warning" label={t("detected")} />
  );
}

/* ── Detail field row ─────────────────────────────────────────────────────── */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <VStack gap={0}>
      <Text type="label" size="sm" weight="bold" color="secondary">
        {label}
      </Text>
      {children}
    </VStack>
  );
}

/* ── Stats bar ────────────────────────────────────────────────────────────── */
function StatsBar({ stats }: { stats: WafEventStats }) {
  const t = useTranslations("waf");
  const items = [
    { label: t("statTotalEvents"), value: stats.total, hue: "blue" },
    { label: t("blocked"), value: stats.blocked, hue: "red" },
    { label: t("statCritical"), value: stats.critical, hue: "orange" },
    { label: t("statUniqueHosts"), value: stats.uniqueHosts, hue: "teal" },
    { label: t("statRuleIdsTriggered"), value: stats.ruleIdsTriggered, hue: "purple" },
  ] satisfies { label: string; value: number; hue: Hue }[];

  return (
    <Grid columns={{ minWidth: 140, max: 5 }} gap={3}>
      {items.map(({ label, value, hue }) => (
        <Card key={label} padding={3} className={ACCENTS[hue].edge}>
          <VStack gap={0}>
            <Text type="display-3" hasTabularNumbers className={ACCENTS[hue].text}>
              {value}
            </Text>
            <Text type="body" weight="medium" className={CARD_TITLE_CLASS}>
              {label}
            </Text>
          </VStack>
        </Card>
      ))}
    </Grid>
  );
}

/* ── Phone summary card ───────────────────────────────────────────────────── */
function WafStatusCard({ stats, isEnabled }: { stats: WafEventStats; isEnabled: boolean }) {
  const t = useTranslations("waf");
  const rest = [
    { label: t("statTotalEvents"), value: stats.total },
    { label: t("statCritical"), value: stats.critical },
    { label: t("statUniqueHosts"), value: stats.uniqueHosts },
    { label: t("statRuleIdsTriggered"), value: stats.ruleIdsTriggered },
  ];

  return (
    <Card padding={4}>
      <VStack gap={3}>
        <HStack justify="between" vAlign="center" gap={2}>
          <Text type="body" weight="semibold">
            {t("firewall")}
          </Text>
          <Badge
            variant={isEnabled ? "success" : "neutral"}
            label={isEnabled ? t("enabled") : t("disabled")}
          />
        </HStack>
        <VStack gap={0}>
          <Text type="display-3" color="accent" hasTabularNumbers>
            {stats.blocked}
          </Text>
          <Text type="body" size="sm" weight="medium" color="secondary">
            {t("blocked")}
          </Text>
        </VStack>
        <Grid columns={{ minWidth: 120, max: 2 }} gap={3}>
          {rest.map(({ label, value }) => (
            <VStack key={label} gap={0}>
              <Text type="body" weight="semibold" hasTabularNumbers>
                {value}
              </Text>
              <Text type="body" size="sm" color="secondary">
                {label}
              </Text>
            </VStack>
          ))}
        </Grid>
      </VStack>
    </Card>
  );
}

/* ── Audit panel ─────────────────────────────────────────────────────────── */
function HeadersGrid({ headers }: { headers?: Record<string, string | string[]> }) {
  const emptyValue = useEmptyValue();
  if (!headers || Object.keys(headers).length === 0) {
    return (
      <Text type="body" size="sm" color="secondary">
        {emptyValue}
      </Text>
    );
  }
  return (
    <MetadataList>
      {Object.entries(headers).map(([k, v]) => (
        <MetadataListItem key={k} label={k}>
          <Text type="code" size="sm">
            {Array.isArray(v) ? v.join(", ") : v}
          </Text>
        </MetadataListItem>
      ))}
    </MetadataList>
  );
}

function bodyCode(body: string) {
  try {
    return { code: JSON.stringify(JSON.parse(body), null, 2), language: "json" };
  } catch {
    return { code: body, language: "plaintext" };
  }
}

function MatchTags({ tags }: { tags: string[] }) {
  return (
    <HStack gap={1} wrap="wrap">
      {tags.map((t) => (
        <Badge key={t} label={t} />
      ))}
    </HStack>
  );
}

function AuditPanel({ rawData }: { rawData: string | null }) {
  const t = useTranslations("waf");
  const tProxyHosts = useTranslations("proxyHosts");
  const tSettings = useTranslations("settings");
  const tCommon = useTranslations("common");
  const tNav = useTranslations("nav");
  const emptyValue = useEmptyValue();
  const [innerTab, setInnerTab] = useState("overview");

  // Once per event, so a tab switch neither re-keys the rules nor re-prints the bodies.
  const { data, msgs, raw } = useMemo(() => {
    let parsed: AuditData | null = null;
    if (rawData) {
      try {
        parsed = JSON.parse(rawData) as AuditData;
      } catch {
        /* leave null */
      }
    }
    return {
      data: parsed,
      msgs: withRowIds((parsed?.messages ?? []).map(normalizeAuditMessage)),
      raw: parsed ? JSON.stringify(parsed, null, 2) : "",
    };
  }, [rawData]);

  if (!data) {
    return <EmptyState title={t("auditDataEmptyTitle")} isCompact />;
  }

  const tx = data.transaction ?? null;
  const req = tx?.request ?? null;
  const res = tx?.response ?? null;

  return (
    <VStack gap={3}>
      <TabList value={innerTab} onChange={setInnerTab} size="sm">
        <Tab value="overview" label={tNav("overview")} />
        <Tab value="request" label={tCommon("request")} />
        <Tab value="response" label={t("response")} />
        {msgs.length > 0 && <Tab value="matches" label={t("matchesTab", { count: msgs.length })} />}
      </TabList>

      <Card variant="muted" padding={4}>
        <VStack gap={3}>
          {innerTab === "overview" && tx && (
            <>
              <MetadataList columns="multi">
                <MetadataListItem label={t("transactionId")}>
                  <Text type="code" size="sm">
                    {tx.id ?? emptyValue}
                  </Text>
                </MetadataListItem>
                <MetadataListItem label={t("timestamp")}>
                  <Text type="body" size="sm">
                    {tx.timestamp ?? emptyValue}
                  </Text>
                </MetadataListItem>
                <MetadataListItem label={tCommon("client")}>
                  <Text type="code" size="sm">
                    {tx.client_ip ?? emptyValue}:{tx.client_port ?? 0}
                  </Text>
                </MetadataListItem>
                <MetadataListItem label={t("server")}>
                  <Text type="code" size="sm">
                    {tx.server_id ?? emptyValue}:{tx.host_port ?? 0}
                  </Text>
                </MetadataListItem>
              </MetadataList>
              {msgs.length > 0 && (
                <>
                  <Divider />
                  <VStack gap={2}>
                    <Text type="label" size="sm" weight="bold" color="secondary">
                      {t("matchedRules")}
                    </Text>
                    {msgs.map((m) => (
                      <Card key={m.rowId} variant="red" padding={3}>
                        <VStack gap={2}>
                          <HStack gap={2} vAlign="center">
                            <Text type="code" size="sm" weight="semibold">
                              {t("ruleLabel", { id: m.details?.ruleId ?? emptyValue })}
                            </Text>
                            <SeverityChip severity={m.details?.severity ?? null} />
                          </HStack>
                          <Text type="body" size="sm">
                            {m.message}
                          </Text>
                          {m.details?.match && (
                            <Text type="code" size="sm" color="secondary">
                              &#8627; {m.details.match}
                            </Text>
                          )}
                          {(m.details?.tags?.length ?? 0) > 0 && (
                            <MatchTags tags={m.details!.tags!} />
                          )}
                        </VStack>
                      </Card>
                    ))}
                  </VStack>
                </>
              )}
            </>
          )}

          {innerTab === "request" && req && (
            <VStack gap={3}>
              <Card padding={2}>
                <HStack gap={2} vAlign="center" wrap="wrap" justify="between">
                  <HStack gap={2} vAlign="center">
                    <Text type="code" size="sm" weight="semibold" color="accent">
                      {req.method}
                    </Text>
                    <Text type="code" size="sm">
                      {req.uri}
                    </Text>
                  </HStack>
                  <Text type="code" size="sm" color="secondary">
                    {req.protocol}
                  </Text>
                </HStack>
              </Card>
              <DetailRow label={t("headers")}>
                <HeadersGrid headers={req.headers} />
              </DetailRow>
              {req.args && Object.keys(req.args).length > 0 && (
                <DetailRow label={t("queryArgs")}>
                  <HeadersGrid headers={req.args as Record<string, string>} />
                </DetailRow>
              )}
              {req.body && (
                <DetailRow label={t("body")}>
                  <CodeBlock {...bodyCode(req.body)} width="100%" isCollapsible />
                </DetailRow>
              )}
              <DetailRow label={t("contentLength")}>
                <Text type="code" size="sm">
                  {t("contentLengthBytes", { length: req.length ?? 0 })}
                </Text>
              </DetailRow>
            </VStack>
          )}

          {innerTab === "response" && res && (
            <VStack gap={3}>
              <Card padding={2}>
                <HStack gap={2} vAlign="center">
                  <Badge
                    variant={
                      (res.status ?? 0) >= 400
                        ? "error"
                        : (res.status ?? 0) >= 300
                          ? "warning"
                          : "success"
                    }
                    label={String(res.status || emptyValue)}
                  />
                  <Text type="code" size="sm" color="secondary">
                    {res.protocol}
                  </Text>
                </HStack>
              </Card>
              <DetailRow label={tSettings("responseHeaders")}>
                <HeadersGrid headers={res.headers} />
              </DetailRow>
              {res.body && (
                <DetailRow label={t("body")}>
                  <CodeBlock {...bodyCode(res.body)} width="100%" isCollapsible />
                </DetailRow>
              )}
            </VStack>
          )}

          {innerTab === "matches" && (
            <VStack gap={4}>
              {msgs.map((m) => (
                <VStack key={m.rowId} gap={2}>
                  <MetadataList columns="multi">
                    <MetadataListItem label={tProxyHosts("ruleId")}>
                      <Text type="code" size="sm" weight="semibold">
                        {m.details?.ruleId ?? emptyValue}
                      </Text>
                    </MetadataListItem>
                    <MetadataListItem label={t("severity")}>
                      <SeverityChip severity={m.details?.severity ?? null} />
                    </MetadataListItem>
                    <MetadataListItem label={t("message")}>
                      <Text type="body" size="sm">
                        {m.message}
                      </Text>
                    </MetadataListItem>
                    <MetadataListItem label={t("logData")}>
                      <Text type="code" size="sm">
                        {m.details?.logdata ?? emptyValue}
                      </Text>
                    </MetadataListItem>
                    <MetadataListItem label={t("file")}>
                      <Text type="code" size="sm" color="secondary">
                        {m.details?.file ?? emptyValue}:{m.details?.lineNumber ?? ""}
                      </Text>
                    </MetadataListItem>
                    <MetadataListItem label={t("reference")}>
                      <Text type="code" size="sm" color="secondary">
                        {m.details?.reference ?? emptyValue}
                      </Text>
                    </MetadataListItem>
                  </MetadataList>
                  {(m.details?.tags?.length ?? 0) > 0 && (
                    <DetailRow label={t("tags")}>
                      <MatchTags tags={m.details!.tags!} />
                    </DetailRow>
                  )}
                </VStack>
              ))}
            </VStack>
          )}
        </VStack>
      </Card>

      <Collapsible
        defaultIsOpen={false}
        trigger={
          <Text type="label" size="lg">
            {t("rawJson")}
          </Text>
        }
      >
        <CodeBlock code={raw} language="json" width="100%" isCollapsible />
      </Collapsible>
    </VStack>
  );
}

/* ── Event detail panel ──────────────────────────────────────────────────── */
function EventDetailPanel({
  event,
  onClose,
  hosts,
}: {
  event: WafEvent;
  onClose: () => void;
  hosts: HostOption[];
}) {
  const t = useTranslations("waf");
  const tProxyHosts = useTranslations("proxyHosts");
  const tCommon = useTranslations("common");
  const emptyValue = useEmptyValue();
  const tAnalytics = useTranslations("analytics");
  const router = useRouter();
  const [network, setNetwork] = useState<WafEventNetwork | null>(null);

  return (
    // Beside the list, not a modal: triage reads several events in a row without dismissing each.
    <Card padding={4}>
      <VStack gap={4}>
        <HStack gap={2} vAlign="center" justify="between">
          <HStack gap={2} vAlign="center">
            <Text type="label" weight="bold">
              {t("wafEvent")}
            </Text>
            <BlockedChip blocked={event.blocked} />
            <SeverityChip severity={event.severity} />
          </HStack>
          <IconButton
            variant="ghost"
            size="sm"
            label={tCommon("close")}
            tooltip={tCommon("close")}
            icon={<X />}
            onClick={onClose}
          />
        </HStack>

        <Card variant="muted" padding={4}>
          <MetadataList columns="multi">
            <MetadataListItem label={tCommon("time")}>
              <Text type="body" size="sm">
                <Timestamp value={event.ts * 1000} />
              </Text>
            </MetadataListItem>
            <MetadataListItem label={t("host")}>
              <Text type="code" size="sm">
                {event.host || emptyValue}
              </Text>
            </MetadataListItem>
            <MetadataListItem label={tCommon("clientIp")}>
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Text type="code" size="sm">
                  {event.clientIp}
                </Text>
                {event.countryCode && <CountryFlag code={event.countryCode} />}
              </HStack>
            </MetadataListItem>
            <MetadataListItem label={tCommon("method")}>
              <Text type="code" size="sm" weight="semibold" color="accent">
                {event.method}
              </Text>
            </MetadataListItem>
            <MetadataListItem label={t("uri")}>
              <Text type="code" size="sm" color="secondary">
                {event.uri || emptyValue}
              </Text>
            </MetadataListItem>
            {network?.asn && (
              <MetadataListItem label={tAnalytics("filterFields.asn")}>
                <Text type="code" size="sm">
                  {asnLabel(network.asn)}
                </Text>
              </MetadataListItem>
            )}
            {network?.userAgent && (
              <MetadataListItem label={tAnalytics("filterFields.ua")}>
                <Text type="code" size="sm">
                  {network.userAgent}
                </Text>
              </MetadataListItem>
            )}
            <MetadataListItem label={tProxyHosts("ruleId")}>
              <Text type="code" size="sm" weight="semibold">
                {event.ruleId ?? emptyValue}
              </Text>
            </MetadataListItem>
            <MetadataListItem label={t("ruleMessage")}>
              <Text type="body" size="sm">
                {event.ruleMessage ?? emptyValue}
              </Text>
            </MetadataListItem>
          </MetadataList>
        </Card>

        <WafEventInsight
          eventKey={event.key}
          hosts={hosts}
          showRawRecord={false}
          onMetadata={setNetwork}
          onChanged={() => router.refresh()}
        />

        <Divider />

        <VStack gap={2}>
          <Text type="label" size="sm" weight="bold" color="secondary">
            {t("auditData")}
          </Text>
          <AuditPanel rawData={event.rawData} />
        </VStack>
      </VStack>
    </Card>
  );
}

/* ── Main client component ───────────────────────────────────────────────── */
/** Stored as bytes, asked in whole MiB. Unset inherits the default. */
function bodyLimitMib(bytes: number | undefined): number | null {
  const mib = bytesToMib(bytes);
  return mib ? Number(mib) : null;
}

/** Stored lines the config leaves out: a left-out deny rule silently stops blocking. */
function DroppedDirectivesBanner({ dropped }: { dropped: DroppedWafDirectiveReport[] }) {
  const t = useTranslations("waf");
  const tErrors = useTranslations("errors");
  if (dropped.length === 0) return null;
  // As strings, or the catalog formats 1073741824 with separators.
  const bounds = { min: String(CORAZA_MIN_BODY_LIMIT), max: String(CORAZA_MAX_BODY_LIMIT) };
  const source = ({ origin, host }: DroppedWafDirectiveReport) => {
    if (origin === "global" || !host) return t("droppedDirectiveGlobal");
    const params = { name: host.name, domains: host.domains.join(", ") };
    return origin === "host"
      ? t("droppedDirectiveHost", params)
      : t("droppedDirectiveHostFromGlobal", params);
  };
  return (
    <Banner
      status="warning"
      title={t("droppedDirectivesTitle", { count: dropped.length })}
      description={t("droppedDirectivesDescription")}
    >
      <List hasDividers>
        {dropped.map((entry) => (
          <ListItem
            key={JSON.stringify([entry.origin, entry.host?.name, entry.line, entry.reason])}
            label={source(entry)}
            description={
              <VStack gap={1}>
                <Text type="code" size="sm">
                  {entry.line}
                </Text>
                <Text type="body" size="sm" color="secondary">
                  {tErrors(entry.reason, { ...bounds, ...entry.params })}
                </Text>
              </VStack>
            }
          />
        ))}
      </List>
    </Banner>
  );
}

export default function WafEventsClient({
  events,
  stats,
  pagination,
  hostOptions,
  initialRange,
  initialFrom,
  initialTo,
  exclusions,
  ruleMessages,
  globalWafEnabled,
  hosts,
  hostModes,
  manageableHostIds,
  canEditDashboard,
  globalWaf,
  presets,
  plugins,
  pluginUpdates,
  droppedDirectives,
}: Props) {
  const t = useTranslations("waf");
  const tNav = useTranslations("nav");
  const tProxyHosts = useTranslations("proxyHosts");
  const tCommon = useTranslations("common");
  // Always set by the provider (see app/providers.tsx); UTC only satisfies the type.
  const timeZone = useTimeZone() ?? "UTC";
  const emptyValue = useEmptyValue();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // ?tab= opens one directly, as settings search does for the tuning and per-host tabs.
  const [tab, setTab] = useTabRoute("/waf", WAF_TABS, "events");
  // New events re-render the page's server data; spaced, since each one is a full page read.
  useLive(
    "waf",
    () => {
      if (document.visibilityState === "visible") router.refresh();
    },
    true,
    3000,
  );
  const [range, setRange] = useState<RangeOption>(initialRange);
  const [customFrom, setCustomFrom] = useState(pickerValue(initialFrom, timeZone));
  const [customTo, setCustomTo] = useState(pickerValue(initialTo, timeZone));
  const [selected, setSelected] = useState<WafEvent | null>(null);
  const isNarrow = useMediaQuery("(max-width: 767px)");
  const [rangeSheetOpen, setRangeSheetOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const detailRef = useRef<HTMLDivElement>(null);
  const searchWrapRef = useRef<HTMLDivElement>(null);

  // Mounted but hidden all along, so autofocus never fires.
  useEffect(() => {
    if (searchOpen) searchWrapRef.current?.querySelector("input")?.focus();
  }, [searchOpen]);
  const [wafState, wafFormAction] = useActionState(updateWafSettingsAction, null);
  const [wafMode, setWafMode] = useState<WafSettings["mode"]>(
    globalWaf?.enabled ? globalWaf.mode : "Off",
  );
  const tuning = effectiveTuning(globalWaf);
  const [paranoiaLevel, setParanoiaLevel] = useState(String(tuning.paranoiaLevel));
  const [logNextLevel, setLogNextLevel] = useState(Boolean(globalWaf?.log_next_paranoia_level));
  const [inboundThreshold, setInboundThreshold] = useState<number | null>(tuning.inboundThreshold);
  const [outboundThreshold, setOutboundThreshold] = useState<number | null>(
    tuning.outboundThreshold,
  );
  const [wafLoadOwaspCrs, setWafLoadOwaspCrs] = useState(globalWaf?.load_owasp_crs ?? true);
  const [wafStrictDirectives, setWafStrictDirectives] = useState(
    globalWaf?.strict_directives ?? false,
  );
  const [wafCustomDirectives, setWafCustomDirectives] = useState(
    globalWaf?.custom_directives ?? "",
  );
  const wafDirectiveIssues = useSeclangIssues(wafCustomDirectives, {
    crsLoaded: wafLoadOwaspCrs,
    strictDirectives: wafStrictDirectives,
  });
  const [wafPresetIds, setWafPresetIds] = useState<number[]>(globalWaf?.preset_ids ?? []);
  const [wafPluginIds, setWafPluginIds] = useState<number[]>(globalWaf?.plugin_ids ?? []);
  const [wafBodyLimitMb, setWafBodyLimitMb] = useState(bodyLimitMib(globalWaf?.request_body_limit));
  const [wafInMemoryLimitMb, setWafInMemoryLimitMb] = useState(
    bodyLimitMib(globalWaf?.request_body_in_memory_limit),
  );
  const [wafLimitAction, setWafLimitAction] = useState<string>(
    globalWaf?.request_body_limit_action ?? "",
  );
  // Without the Coraza module these settings would be stored and never reach Caddy.
  const wafModuleDisabledReason = useDisabledReason("waf");

  const filterFields: UrlSearchField[] = [
    { param: "search", label: t("filterText"), kind: "text" },
    {
      param: "host",
      label: t("host"),
      kind: "enum",
      values: hostOptions.map((host) => ({ value: host, label: host })),
    },
    { param: "ip", label: tCommon("clientIp"), kind: "exact" },
    { param: "rule", label: tProxyHosts("ruleId"), kind: "exact" },
    {
      param: "action",
      label: t("action"),
      kind: "enum",
      values: [
        { value: "blocked", label: t("blocked") },
        { value: "detected", label: t("detected") },
      ],
    },
    {
      param: "severity",
      label: t("severity"),
      kind: "enum",
      values: Object.keys(SEVERITY_VARIANTS).map((value) => ({
        value,
        label: severityLabel(value),
      })),
    },
  ];
  const hasFilters = filterFields.some((field) => searchParams.has(field.param));

  const rangeOptions: { value: RangeOption; label: string }[] = [
    { value: "all", label: t("rangeAllTime") },
    { value: "24h", label: "24h" },
    { value: "7d", label: "7d" },
    { value: "30d", label: "30d" },
    { value: "custom", label: t("rangeCustom") },
  ];

  const limitActionId = useId();
  const modeId = useId();
  const paranoiaId = useId();
  // Per-option help: one line covering all three left "Default" unexplained.
  const bodyLimitActions = [
    { value: "", label: t("bodyLimitActionDefault"), help: t("overLimitActionHelpDefault") },
    {
      value: "Reject",
      label: tProxyHosts("reject"),
      help: tProxyHosts("overLimitActionHelpReject"),
    },
    {
      value: "ProcessPartial",
      label: tProxyHosts("partial"),
      help: tProxyHosts("overLimitActionHelpPartial"),
    },
  ];

  useEffect(() => {
    setRange(initialRange);
    setCustomFrom(pickerValue(initialFrom, timeZone));
    setCustomTo(pickerValue(initialTo, timeZone));
  }, [initialRange, initialFrom, initialTo, timeZone]);
  const pushRange = useCallback(
    (nextRange: RangeOption, nextFrom?: string, nextTo?: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("page");

      if (nextRange === "all") {
        params.delete("range");
        params.delete("from");
        params.delete("to");
        router.push(`${pathname}?${params.toString()}`);
        return;
      }

      params.set("range", nextRange);
      if (nextRange === "custom") {
        const fromTs = fromZonedWallTime(nextFrom ?? "", timeZone);
        const toTs = fromZonedWallTime(nextTo ?? "", timeZone);
        if (fromTs == null || toTs == null || fromTs >= toTs) {
          toast.error(t("invalidTimeRangeError"));
          return;
        }
        params.set("from", String(fromTs));
        params.set("to", String(toTs));
      } else {
        params.delete("from");
        params.delete("to");
      }

      router.push(`${pathname}?${params.toString()}`);
    },
    [pathname, router, searchParams, t, timeZone],
  );

  const activateCustom = useCallback(() => {
    setRange("custom");
    if (!customFrom || !customTo) {
      const now = new Date();
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      setCustomFrom(pickerValue(Math.floor(dayAgo.getTime() / 1000), timeZone));
      setCustomTo(pickerValue(Math.floor(now.getTime() / 1000), timeZone));
    }
  }, [customFrom, customTo, timeZone]);

  const handleRangeChange = useCallback(
    (next: string) => {
      const value = next as RangeOption;
      if (value === "custom") {
        activateCustom();
        return;
      }
      setRange(value);
      pushRange(value);
    },
    [activateCustom, pushRange],
  );

  const mobileCard = (event: WafEvent) => (
    <Card>
      <VStack gap={2}>
        <HStack justify="between" vAlign="center" gap={2}>
          <HStack gap={2} vAlign="center">
            <BlockedChip blocked={event.blocked} />
            <SeverityChip severity={event.severity} />
          </HStack>
          <Text type="body" size="sm" color="secondary">
            <Timestamp value={event.ts * 1000} />
          </Text>
        </HStack>
        <Text type="code" size="sm" color="secondary">
          {event.host || emptyValue}
        </Text>
        {event.ruleId && (
          <Text type="body" size="sm" color="secondary">
            {t("ruleNumber", { id: event.ruleId })}
          </Text>
        )}
      </VStack>
    </Card>
  );

  const columns: Column<WafEvent>[] = [
    {
      id: "ts",
      label: tCommon("time"),
      width: 220,
      render: (r) => (
        <Text type="code" size="sm" color="secondary">
          <Timestamp value={r.ts * 1000} />
        </Text>
      ),
    },
    {
      id: "blocked",
      label: t("action"),
      width: 104,
      render: (r) => <BlockedChip blocked={r.blocked} />,
    },
    {
      id: "severity",
      label: t("severity"),
      width: 104,
      render: (r) => <SeverityChip severity={r.severity} />,
    },
    {
      id: "host",
      label: t("host"),
      // Mins in the same ratio as the shares, so neither one alone widens the table.
      width: proportional(1, { minWidth: 100 }),
      render: (r) =>
        r.host ? (
          <Tooltip content={r.host}>
            <Text type="code" size="sm" maxLines={1}>
              {r.host}
            </Text>
          </Tooltip>
        ) : (
          <Text type="body" size="sm" color="secondary">
            {emptyValue}
          </Text>
        ),
    },
    {
      id: "clientIp",
      label: tCommon("clientIp"),
      // A full eight-group IPv6 address beside its flag.
      width: 380,
      render: (r) => (
        <HStack gap={1} vAlign="center">
          <Text type="code" size="sm">
            {r.clientIp}
          </Text>
          {r.countryCode && <CountryFlag code={r.countryCode} />}
        </HStack>
      ),
    },
    {
      id: "method",
      label: tCommon("request"),
      width: proportional(1.5, { minWidth: 150 }),
      // One line, so a squeezed column ellipsizes the path rather than stacking the method.
      render: (r) => (
        <Tooltip content={r.uri ?? ""}>
          <Text type="code" size="sm" color="secondary" maxLines={1} hasTruncateTooltip={false}>
            <Text type="code" size="sm" weight="bold" color={r.method ? "accent" : "secondary"}>
              {r.method || emptyValue}
            </Text>{" "}
            {r.uri || emptyValue}
          </Text>
        </Tooltip>
      ),
    },
    {
      id: "ruleId",
      label: tProxyHosts("ruleId"),
      width: 80,
      render: (r) => (
        <Text type="code" size="sm" color="secondary">
          {r.ruleId ?? emptyValue}
        </Text>
      ),
    },
  ];

  const changeTab = (next: string) => {
    setTab(next as (typeof WAF_TABS)[number]);
    if (next !== "events") setSelected(null);
  };

  const views = [
    { value: "events", label: tCommon("events") },
    { value: "exclusions", label: t("exclusions") },
    { value: "hosts", label: tNav("hosts") },
    { value: "presets", label: t("presets") },
    { value: "plugins", label: t("plugins") },
    { value: "settings", label: tNav("settings") },
  ];

  const detailPanel = selected && (
    <EventDetailPanel event={selected} onClose={() => setSelected(null)} hosts={hosts} />
  );

  // On a phone the event replaces a list that may be scrolled well down.
  const selectedId = selected?.id;
  useEffect(() => {
    if (isNarrow && selectedId != null) detailRef.current?.scrollIntoView({ block: "start" });
  }, [isNarrow, selectedId]);

  return (
    <VStack gap={4}>
      <HStack justify="between" vAlign="center" gap={2}>
        <Heading level={1}>{t("waf")}</Heading>
        <HStack gap={1} vAlign="center" className="cpm-mobile-flex">
          {tab === "events" && (
            <IconButton
              variant="ghost"
              label={t("searchWafEvents")}
              icon={<Search />}
              onClick={() => setSearchOpen((open) => !open)}
            />
          )}
          <DropdownMenu
            hasChevron={false}
            presentation="adaptive"
            alignment="end"
            button={{
              variant: "ghost",
              icon: <MoreHorizontal />,
              label: tCommon("views"),
              isIconOnly: true,
            }}
            items={views.map((view) => ({
              id: view.value,
              label: view.label,
              endContent: view.value === tab ? <Check size={16} aria-hidden="true" /> : undefined,
              onClick: () => changeTab(view.value),
            }))}
          />
        </HStack>
      </HStack>

      <DroppedDirectivesBanner dropped={droppedDirectives} />

      <TabList value={tab} onChange={changeTab} hasDivider className="cpm-desktop-only">
        <Tab value="events" label={tCommon("events")} />
        <Tab value="exclusions" label={t("exclusions")} />
        <Tab value="hosts" label={tNav("hosts")} />
        <Tab value="presets" label={t("presets")} />
        <Tab value="plugins" label={t("plugins")} />
        <Tab value="settings" label={tNav("settings")} />
      </TabList>

      {tab === "events" && (
        <VStack gap={6}>
          <div className="cpm-desktop-only">
            <StatsBar stats={stats} />
          </div>
          <div className="cpm-mobile-only">
            <WafStatusCard stats={stats} isEnabled={globalWafEnabled} />
          </div>
          <VStack gap={3}>
            {/* Top-aligned: the search bar's bottom margin would pull a centred range down. */}
            <HStack justify="between" vAlign="start" gap={3} wrap="wrap">
              <div className="cpm-desktop-only">
                <SegmentedControl
                  label={tCommon("timeRange")}
                  size="md"
                  value={range}
                  onChange={handleRangeChange}
                >
                  {rangeOptions.map((o) => (
                    <SegmentedControlItem key={o.value} value={o.value} label={o.label} />
                  ))}
                </SegmentedControl>
              </div>
              <FilterChip
                className="cpm-mobile-flex"
                label={rangeOptions.find((o) => o.value === range)?.label ?? range}
                aria-label={tCommon("timeRange")}
                isActive={range !== "all"}
                onClick={() => setRangeSheetOpen(true)}
              />
              {/* Shown on a phone while a search is applied, so the filter never hides. The auto
                  margin keeps it right-aligned when it wraps. */}
              <div
                ref={searchWrapRef}
                className={`ms-auto max-w-160 grow basis-60 ${
                  searchOpen || hasFilters ? "" : "cpm-desktop-only"
                }`}
              >
                <UrlPowerSearch
                  name="WafEvents"
                  label={t("searchWafEvents")}
                  placeholder={t("eventsSearchPlaceholder")}
                  resultCount={pagination.total}
                  fields={filterFields}
                  width="100%"
                />
              </div>
            </HStack>
            <OptionSheet
              title={tCommon("timeRange")}
              isOpen={rangeSheetOpen}
              onOpenChange={setRangeSheetOpen}
              value={range}
              options={rangeOptions}
              onChange={handleRangeChange}
            />
            {range === "custom" && (
              <HStack gap={2} vAlign="end" wrap="wrap">
                <DateTimeInput
                  label={tCommon("rangeFrom")}
                  size="sm"
                  value={(customFrom || undefined) as ISODateTimeString | undefined}
                  onChange={(v) => setCustomFrom(v ?? "")}
                />
                <DateTimeInput
                  label={tCommon("rangeTo")}
                  size="sm"
                  value={(customTo || undefined) as ISODateTimeString | undefined}
                  onChange={(v) => setCustomTo(v ?? "")}
                />
                <Button
                  size="sm"
                  label={tCommon("apply")}
                  onClick={() => pushRange("custom", customFrom, customTo)}
                />
              </HStack>
            )}
          </VStack>
          {isNarrow && selected ? (
            <VStack gap={3} ref={detailRef}>
              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<ArrowLeft />}
                  label={tCommon("back")}
                  onClick={() => setSelected(null)}
                />
              </div>
              {detailPanel}
            </VStack>
          ) : (
            <HStack gap={4} vAlign="start" wrap="wrap">
              <div className="min-w-0 grow basis-130">
                <DataTable
                  columns={columns}
                  data={events}
                  keyField="id"
                  emptyMessage={t("eventsEmptyDescription")}
                  pagination={pagination}
                  onRowClick={(row) => setSelected((prev) => (prev?.id === row.id ? null : row))}
                  rowStatus={(row) =>
                    row.id === selected?.id ? { color: "accent", label: t("selected") } : null
                  }
                  mobileCard={mobileCard}
                />
              </div>

              {/* The basis: below ~900px the panel wraps instead of squeezing the table. */}
              {selected && <div className="min-w-0 max-w-115 grow basis-95">{detailPanel}</div>}
            </HStack>
          )}
        </VStack>
      )}

      {tab === "exclusions" && (
        <WafExclusionsPanel
          exclusions={exclusions}
          hosts={hosts}
          ruleMessages={ruleMessages}
          wafEnabled={globalWafEnabled}
        />
      )}

      {tab === "hosts" && (
        <WafHostModesPanel
          hosts={hostModes}
          manageableHostIds={manageableHostIds}
          canEditDashboard={canEditDashboard}
        />
      )}

      {tab === "presets" && (
        <WafPresetsPanel presets={presets} strictDirectives={wafStrictDirectives} />
      )}

      {tab === "plugins" && <WafPluginsPanel plugins={plugins} storedUpdates={pluginUpdates} />}

      {tab === "settings" && (
        <VStack gap={6}>
          <VStack gap={1}>
            <Heading level={2}>{t("wafSettings")}</Heading>
            <Text type="body" size="sm" color="secondary">
              {t("globalSettingsDescription")}
            </Text>
          </VStack>
          <form action={wafFormAction}>
            <VStack gap={4}>
              <input type="hidden" name="wafEngineMode" value={wafMode} />
              <input type="hidden" name="wafParanoiaLevel" value={paranoiaLevel} />
              <input
                type="hidden"
                name="wafLogNextParanoiaLevel"
                value={logNextLevel ? "on" : ""}
              />
              <input type="hidden" name="wafLoadOwaspCrs" value={wafLoadOwaspCrs ? "on" : ""} />
              <input
                type="hidden"
                name="wafStrictDirectives"
                value={wafStrictDirectives ? "on" : ""}
              />
              <input type="hidden" name="wafPresetIds" value={JSON.stringify(wafPresetIds)} />
              <input type="hidden" name="wafPluginIds" value={JSON.stringify(wafPluginIds)} />
              {wafState?.message && (
                <Banner status={wafState.success ? "success" : "error"} title={wafState.message} />
              )}
              {wafModuleDisabledReason && (
                <Banner
                  status="warning"
                  title={t("moduleDisabledTitle")}
                  description={wafModuleDisabledReason}
                />
              )}
              {/* Disabled controls emit no pointer events, so the reason attaches by wrapping. */}
              <Field
                label={t("globalMode")}
                inputID={modeId}
                isGroupLabel
                description={t(MODE_HELP_KEY[wafMode])}
              >
                {/* Disabled controls emit no pointer events, so the reason attaches by wrapping. */}
                <ModuleGated feature="waf">
                  <HStack>
                    <SegmentedControl
                      label={t("globalMode")}
                      value={wafMode}
                      onChange={(next) => setWafMode(next as WafSettings["mode"])}
                      isDisabled={Boolean(wafModuleDisabledReason)}
                    >
                      {(["Off", "DetectionOnly", "On"] as const).map((mode) => (
                        <SegmentedControlItem key={mode} value={mode} label={t(MODE_KEY[mode])} />
                      ))}
                    </SegmentedControl>
                  </HStack>
                </ModuleGated>
              </Field>
              <Switch
                label={tProxyHosts("owaspCrsLabel")}
                description={t("owaspCrsHelp")}
                value={wafLoadOwaspCrs}
                onChange={setWafLoadOwaspCrs}
              />
              <Switch
                label={t("strictDirectivesLabel")}
                description={t("strictDirectivesHelp")}
                value={wafStrictDirectives}
                onChange={setWafStrictDirectives}
              />
              {wafLoadOwaspCrs && (
                <VStack gap={4}>
                  <Field
                    label={t("paranoiaLevel")}
                    inputID={paranoiaId}
                    isGroupLabel
                    description={t("paranoiaLevelHelp")}
                  >
                    <HStack>
                      <SegmentedControl
                        label={t("paranoiaLevel")}
                        value={paranoiaLevel}
                        onChange={setParanoiaLevel}
                      >
                        {PARANOIA_LEVELS.map((level) => (
                          <SegmentedControlItem
                            key={level}
                            value={String(level)}
                            label={String(level)}
                          />
                        ))}
                      </SegmentedControl>
                    </HStack>
                  </Field>
                  <Switch
                    label={t("logNextParanoiaLevel")}
                    description={t("logNextParanoiaLevelHelp")}
                    value={logNextLevel}
                    onChange={setLogNextLevel}
                    isDisabled={paranoiaLevel === "4"}
                  />
                  <HStack gap={3} vAlign="start" wrap="wrap">
                    <NumberInput
                      hasNumberSteppers
                      label={t("inboundThreshold")}
                      htmlName="wafInboundThreshold"
                      value={inboundThreshold}
                      onChange={setInboundThreshold}
                      min={MIN_ANOMALY_THRESHOLD}
                      max={MAX_ANOMALY_THRESHOLD}
                      step={1}
                      isIntegerOnly
                      placeholder={String(DEFAULT_INBOUND_THRESHOLD)}
                      description={t("inboundThresholdHelp")}
                    />
                    <NumberInput
                      hasNumberSteppers
                      label={t("outboundThreshold")}
                      htmlName="wafOutboundThreshold"
                      value={outboundThreshold}
                      onChange={setOutboundThreshold}
                      min={MIN_ANOMALY_THRESHOLD}
                      max={MAX_ANOMALY_THRESHOLD}
                      step={1}
                      isIntegerOnly
                      placeholder={String(DEFAULT_OUTBOUND_THRESHOLD)}
                      description={t("outboundThresholdHelp")}
                    />
                  </HStack>
                </VStack>
              )}
              <HStack gap={3} vAlign="start" wrap="wrap">
                <NumberInput
                  startIcon={HardDrive}
                  hasNumberSteppers
                  units={tCommon("unitMib")}
                  label={t("maxBodySizeMib")}
                  htmlName="wafRequestBodyLimitMb"
                  value={wafBodyLimitMb}
                  onChange={setWafBodyLimitMb}
                  min={MIN_BODY_LIMIT_MIB}
                  max={MAX_BODY_LIMIT_MIB}
                  step={1}
                  isIntegerOnly
                  hasClear
                  placeholder={t("corazaDefault")}
                  description={t("bodySizeLimitHelp")}
                />
                <NumberInput
                  startIcon={HardDrive}
                  hasNumberSteppers
                  units={tCommon("unitMib")}
                  label={tProxyHosts("bufferedInMemoryMib")}
                  htmlName="wafRequestBodyInMemoryLimitMb"
                  value={wafInMemoryLimitMb}
                  onChange={setWafInMemoryLimitMb}
                  min={MIN_BODY_LIMIT_MIB}
                  max={MAX_BODY_LIMIT_MIB}
                  step={1}
                  isIntegerOnly
                  hasClear
                  placeholder={t("corazaDefault")}
                  description={t("memoryBodyLimitHelp")}
                />
              </HStack>
              <input type="hidden" name="wafRequestBodyLimitAction" value={wafLimitAction} />
              {/* SegmentedControl's own label is only an aria-label; Field draws the visible one. */}
              <Field
                label={tProxyHosts("overLimitAction")}
                inputID={limitActionId}
                isGroupLabel
                description={bodyLimitActions.find((o) => o.value === wafLimitAction)?.help}
              >
                {/* Keeps Field's column from stretching the control across the page. */}
                <HStack>
                  <SegmentedControl
                    label={tProxyHosts("overLimitAction")}
                    value={wafLimitAction}
                    onChange={setWafLimitAction}
                  >
                    {bodyLimitActions.map((o) => (
                      <SegmentedControlItem key={o.value} value={o.value} label={o.label} />
                    ))}
                  </SegmentedControl>
                </HStack>
              </Field>
              <WafPresetPicker
                value={wafPresetIds}
                onChange={setWafPresetIds}
                description={t("presetsGlobalHelp")}
                isReadOnly={Boolean(wafModuleDisabledReason)}
              />
              <WafPluginPicker
                value={wafPluginIds}
                onChange={setWafPluginIds}
                crsLoaded={wafLoadOwaspCrs}
                description={t("pluginsGlobalHelp")}
                isReadOnly={Boolean(wafModuleDisabledReason)}
              />
              <CodeEditor
                label={tProxyHosts("customSeclangDirectives")}
                language="seclang"
                htmlName="wafCustomDirectives"
                height="sm"
                value={wafCustomDirectives}
                onChange={setWafCustomDirectives}
                issues={wafDirectiveIssues}
                // Not isDisabled: a disabled field posts nothing, which erases the directives.
                isReadOnly={Boolean(wafModuleDisabledReason)}
                placeholder={`SecRule REQUEST_URI "@contains /secret" "id:9001,deny,status:403,log,msg:'Blocked path'"`}
                description={t("customDirectivesHelp")}
              />
              <WafQuickTemplates onInsert={setWafCustomDirectives} />
              <Banner status="info" title={t("exclusionsTabHelp")} />
              <SaveButton label={tCommon("save")} />
            </VStack>
          </form>
        </VStack>
      )}
    </VStack>
  );
}
