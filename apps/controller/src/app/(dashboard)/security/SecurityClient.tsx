"use client";

/**
 * Security events: the rule set, what the gates stopped and from where, and the WAF events behind
 * it. The URL is the state, read the analytics page's way; the server renders each state.
 */

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import type { ApexOptions } from "apexcharts";
import { Ban, Filter, ShieldOff } from "lucide-react";
import type { TrafficOutcome } from "@cpm/shared";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { DateTimeInput, type ISODateTimeString } from "@astryxdesign/core/DateTimeInput";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useTimeZone, useTranslations } from "next-intl";
import { useAppFormatter } from "@/src/components/locale/use-app-formatter";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Timestamp } from "@/components/ui/Timestamp";
import { useEmptyValue } from "@/components/ui/empty-value";
import { BlockSourceDialog, type BlockDraft } from "@/components/security/BlockSourceDialog";
import {
  ExclusionDialog,
  type ExclusionDraft,
  type HostOption,
} from "@/components/security/ExclusionDialog";
import { WafEventInsight } from "@/components/security/WafEventInsight";
import {
  ANALYTICS_RANGES,
  type AnalyticsFilter,
  type ExploreState,
  parseExploreState,
  serializeExploreState,
  withFilter,
} from "@/src/lib/analytics/explore-state";
import { fromZonedWallTime, toZonedWallTime } from "@/src/lib/locale/date-format";
import type { SecurityReport, SecurityRule } from "@/src/lib/security/report";
import type { SecuritySource } from "@/src/lib/clickhouse/security";
import type { WafEvent } from "@/src/lib/models/waf-events";
import type { WafEventReview } from "@/src/lib/security/waf-event";
import { useChartTheme } from "../analytics/chart-theme";
import { FilterBar } from "../analytics/explore/FilterBar";
import type { ApexChartComponent } from "../analytics/explore/KpiTiles";
import { OUTCOME_COLOR } from "../analytics/explore/TrafficChart";
import { countryFlag, formatBucket, formatShare, OUTCOME_KEY } from "../analytics/explore/format";
import { settingsHref } from "../settings/sections";
import { MODE_KEY } from "../waf/WafHostModesPanel";

// ApexCharts renders in the browser only, as on the analytics page.
const ReactApexChart = dynamic(() => import("react-apexcharts"), {
  ssr: false,
}) as unknown as ApexChartComponent;

type EventRow = WafEvent & { review: WafEventReview | null };
type SourceRow = SecuritySource & { blocked: boolean };

function useOutcomeName() {
  const t = useTranslations("analytics");
  const tSecurity = useTranslations("security");
  return useCallback(
    (key: string) =>
      key === "detected"
        ? tSecurity("seriesDetected")
        : key in OUTCOME_KEY
          ? t(`outcomes.${OUTCOME_KEY[key as TrafficOutcome]}`)
          : key,
    [t, tSecurity],
  );
}

function SecurityChart({ report, onShowPeak }: { report: SecurityReport; onShowPeak: () => void }) {
  const t = useTranslations("security");
  const format = useAppFormatter();
  const theme = useChartTheme();
  const outcomeName = useOutcomeName();
  const rangeSeconds = report.window.to - report.window.from;

  const series = useMemo(
    () => report.series.map((s) => ({ name: outcomeName(s.key), data: s.counts })),
    [report.series, outcomeName],
  );
  const options = useMemo<ApexOptions>(
    () => ({
      ...theme.base,
      chart: { ...theme.base.chart, stacked: true, id: "security-timeline" },
      colors: report.series.map((s) =>
        s.key === "detected"
          ? theme.labelColor
          : theme.series[OUTCOME_COLOR[s.key as TrafficOutcome] ?? "red"],
      ),
      fill: { opacity: 1 },
      plotOptions: { bar: { columnWidth: "70%" } },
      dataLabels: { enabled: false },
      xaxis: {
        categories: report.buckets.map((ts) => formatBucket(format, ts, rangeSeconds)),
        labels: { rotate: 0, hideOverlappingLabels: true, style: { colors: theme.labelColor } },
        axisBorder: { show: false },
        axisTicks: { show: false },
      },
      yaxis: { labels: { style: { colors: theme.labelColor } } },
      legend: { labels: { colors: theme.labelColor } },
      tooltip: { theme: theme.mode, shared: true, intersect: false },
    }),
    [theme, report.series, report.buckets, format, rangeSeconds],
  );
  const peak = report.peak;

  return (
    <Card padding={5}>
      <VStack gap={4}>
        <Text as="h2" type="body" size="sm" weight="semibold">
          {t("mitigatedOverTime")}
        </Text>
        {series.every((s) => s.data.every((n) => n === 0)) ? (
          <EmptyState title={t("chartEmpty")} isCompact />
        ) : (
          <ReactApexChart type="bar" series={series} options={options} height={240} />
        )}
        {peak && (
          <VStack gap={1}>
            <Text type="body" size="sm" weight="semibold">
              {t("peakTitle", {
                count: peak.count,
                time: format.dateTime(new Date(peak.ts * 1000), {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })}
            </Text>
            {peak.ip && (
              <Text type="body" size="sm" color="secondary">
                {t("peakIp", { ip: peak.ip })}
              </Text>
            )}
            {peak.host && (
              <Text type="body" size="sm" color="secondary">
                {t("peakHost", { host: peak.host })}
              </Text>
            )}
            {peak.ruleId !== null && (
              <Text type="body" size="sm" color="secondary">
                {t("peakRule", { id: String(peak.ruleId), message: peak.ruleMessage ?? "" })}
              </Text>
            )}
            <HStack>
              <Button
                variant="secondary"
                size="sm"
                label={t("showTheseEvents")}
                onClick={onShowPeak}
              />
            </HStack>
          </VStack>
        )}
      </VStack>
    </Card>
  );
}

function RuleSetCard({ report }: { report: SecurityReport }) {
  const t = useTranslations("security");
  const tWaf = useTranslations("waf");
  const rules = report.ruleSet;
  return (
    <Card padding={4}>
      <VStack gap={3}>
        <Text as="h2" type="body" size="sm" weight="semibold">
          {t("ruleSet")}
        </Text>
        <MetadataList>
          <MetadataListItem label={t("globalMode")}>
            <Badge label={tWaf(MODE_KEY[rules.globalMode])} />
          </MetadataListItem>
          <MetadataListItem label={t("coreRuleSet")}>
            <Text type="body" size="sm">
              {rules.crsLoaded ? t("crsVersion", { version: rules.crsVersion }) : t("crsOff")}
            </Text>
          </MetadataListItem>
          {rules.crsLoaded && (
            <MetadataListItem label={t("paranoia")}>
              <Text type="body" size="sm">
                {rules.detectionParanoiaLevel > rules.paranoiaLevel
                  ? t("paranoiaWithDetection", {
                      level: rules.paranoiaLevel,
                      detection: rules.detectionParanoiaLevel,
                    })
                  : t("paranoiaLevel", { level: rules.paranoiaLevel })}
              </Text>
            </MetadataListItem>
          )}
          {rules.crsLoaded && (
            <MetadataListItem label={t("thresholds")}>
              <Text type="body" size="sm">
                {t("thresholdValues", {
                  inbound: rules.inboundThreshold,
                  outbound: rules.outboundThreshold,
                })}
              </Text>
            </MetadataListItem>
          )}
          <MetadataListItem label={t("hostsByMode")}>
            <Text type="body" size="sm">
              {t("hostModeCounts", {
                blocking: rules.hosts.On,
                detecting: rules.hosts.DetectionOnly,
                off: rules.hosts.Off,
              })}
            </Text>
          </MetadataListItem>
          <MetadataListItem label={t("exclusions")}>
            <Link href="/waf">{t("exclusionCount", { count: rules.exclusions })}</Link>
          </MetadataListItem>
          <MetadataListItem label={t("blockedSources")}>
            <Link href="/security/blocked-sources">
              {t("blockedSourceCount", { count: rules.blockedSources })}
            </Link>
          </MetadataListItem>
        </MetadataList>
      </VStack>
    </Card>
  );
}

function MitigatedCard({ report }: { report: SecurityReport }) {
  const t = useTranslations("security");
  const format = useAppFormatter();
  const outcomeName = useOutcomeName();
  const { totals } = report;
  const change =
    totals.previousMitigated > 0
      ? (totals.mitigated - totals.previousMitigated) / totals.previousMitigated
      : null;
  return (
    <Card padding={4}>
      <VStack gap={3}>
        <Text as="h2" type="body" size="sm" weight="semibold">
          {t("mitigated")}
        </Text>
        <HStack gap={2} vAlign="end" wrap="wrap">
          <Text type="display-3" hasTabularNumbers>
            {format.number(totals.mitigated)}
          </Text>
          {totals.requests > 0 && (
            <Text type="body" size="sm" color="secondary">
              {t("shareOfRequests", {
                share: formatShare(format, totals.mitigated, totals.requests),
              })}
            </Text>
          )}
        </HStack>
        <Text type="body" size="xsm" color="secondary">
          {change === null
            ? t("noPreviousPeriod")
            : t("changeFromPrevious", {
                change: format.number(change, {
                  style: "percent",
                  maximumFractionDigits: 0,
                  signDisplay: "exceptZero",
                }),
              })}
        </Text>
        <MetadataList>
          {totals.byOutcome.map((row) => (
            <MetadataListItem key={row.outcome} label={outcomeName(row.outcome)}>
              <Text type="body" size="sm" hasTabularNumbers>
                {t("outcomeCount", { count: row.count, previous: row.previous })}
              </Text>
            </MetadataListItem>
          ))}
        </MetadataList>
      </VStack>
    </Card>
  );
}

function SourcesCard({ report }: { report: SecurityReport }) {
  const t = useTranslations("security");
  const format = useAppFormatter();
  const emptyValue = useEmptyValue();
  return (
    <Card padding={4}>
      <VStack gap={3}>
        <Text as="h2" type="body" size="sm" weight="semibold">
          {t("sources")}
        </Text>
        <Text type="display-3" hasTabularNumbers>
          {format.number(report.totals.sources)}
        </Text>
        <MetadataList>
          <MetadataListItem label={t("mostTargetedHost")}>
            <Text type="code" size="sm">
              {report.totals.topHost
                ? t("hostCount", {
                    host: report.totals.topHost.host,
                    count: report.totals.topHost.count,
                  })
                : emptyValue}
            </Text>
          </MetadataListItem>
        </MetadataList>
      </VStack>
    </Card>
  );
}

export default function SecurityClient({
  report,
  hosts,
}: {
  report: SecurityReport;
  hosts: HostOption[];
}) {
  const t = useTranslations("security");
  const tWaf = useTranslations("waf");
  const format = useAppFormatter();
  const timeZone = useTimeZone() ?? "UTC";
  const emptyValue = useEmptyValue();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlQuery = searchParams.toString();
  const state = useMemo(() => parseExploreState(new URLSearchParams(urlQuery)), [urlQuery]);
  const [customFrom, setCustomFrom] = useState(
    state.from ? toZonedWallTime(state.from, timeZone) : "",
  );
  const [customTo, setCustomTo] = useState(state.to ? toZonedWallTime(state.to, timeZone) : "");
  const [showCustom, setShowCustom] = useState(state.range === "custom");
  const [exclusion, setExclusion] = useState<ExclusionDraft | null>(null);
  const [block, setBlock] = useState<BlockDraft | null>(null);

  // A new state starts the event list over at its first page.
  const navigate = useCallback(
    (next: ExploreState) => {
      const query = serializeExploreState(next).toString();
      router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [router, pathname],
  );
  const addFilter = (filter: AnalyticsFilter) => navigate(withFilter(state, filter));

  const rangeValue = showCustom ? "custom" : state.range;
  const noAnalytics = report.source === "none" || report.source === "unavailable";

  const ruleColumns: Column<SecurityRule>[] = [
    {
      id: "rule",
      label: tWaf("ruleId"),
      render: (row) => (
        <VStack gap={0}>
          <Text type="code" size="sm" weight="semibold">
            {row.ruleId}
          </Text>
          <Text type="body" size="xsm" color="secondary" maxLines={1}>
            {row.message ?? tWaf("noRuleDescription")}
          </Text>
        </VStack>
      ),
    },
    {
      id: "events",
      label: t("events"),
      width: 100,
      align: "right",
      render: (row) => (
        <Text type="body" size="sm" hasTabularNumbers>
          {format.number(row.events)}
        </Text>
      ),
    },
    {
      id: "sources",
      label: t("sources"),
      width: 100,
      align: "right",
      render: (row) => (
        <Text type="body" size="sm" hasTabularNumbers>
          {format.number(row.sources)}
        </Text>
      ),
    },
    {
      id: "actions",
      label: tWaf("actions"),
      width: 200,
      align: "right",
      render: (row) => (
        <HStack gap={1} justify="end">
          <Button
            variant="ghost"
            size="sm"
            icon={<Filter />}
            label={t("filterRule", { id: String(row.ruleId) })}
            isIconOnly
            tooltip={t("filterRule", { id: String(row.ruleId) })}
            onClick={() => addFilter({ field: "rule", op: "is", value: String(row.ruleId) })}
          />
          {row.excluded ? (
            <Badge label={t("excludedEverywhere")} />
          ) : (
            <Button
              variant="secondary"
              size="sm"
              icon={<ShieldOff />}
              label={t("addExclusion")}
              onClick={() =>
                setExclusion({
                  ruleId: row.ruleId,
                  proxyHostId: null,
                  path: "",
                  target: "",
                  reason: "",
                })
              }
            />
          )}
        </HStack>
      ),
    },
  ];

  const sourceColumns: Column<SourceRow>[] = [
    {
      id: "ip",
      label: t("source"),
      render: (row) => (
        <VStack gap={0}>
          <HStack gap={1} vAlign="center">
            <Text type="code" size="sm">
              {row.ip}
            </Text>
            <Button
              variant="ghost"
              size="sm"
              icon={<Filter />}
              label={t("filterSource", { ip: row.ip })}
              isIconOnly
              tooltip={t("filterSource", { ip: row.ip })}
              onClick={() => addFilter({ field: "ip", op: "is", value: row.ip })}
            />
          </HStack>
          <Text type="body" size="xsm" color="secondary" maxLines={1}>
            {[
              row.countryCode ? `${countryFlag(row.countryCode)} ${row.countryCode}` : null,
              row.asn ? `AS${row.asn}${row.asnOrg ? ` ${row.asnOrg}` : ""}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || emptyValue}
          </Text>
        </VStack>
      ),
    },
    {
      id: "rules",
      label: t("rulesHit"),
      render: (row) =>
        row.rules.length === 0 ? (
          <Text type="body" size="xsm" color="secondary">
            {emptyValue}
          </Text>
        ) : (
          <HStack gap={1} wrap="wrap">
            {row.rules.map((rule) => (
              <Badge key={rule} label={String(rule)} />
            ))}
          </HStack>
        ),
    },
    {
      id: "requests",
      label: t("requests"),
      width: 100,
      align: "right",
      render: (row) => (
        <Text type="body" size="sm" hasTabularNumbers>
          {format.number(row.requests)}
        </Text>
      ),
    },
    {
      id: "lastSeen",
      label: t("lastSeen"),
      width: 180,
      render: (row) => (
        <Text type="body" size="xsm" color="secondary">
          <Timestamp value={row.lastSeen * 1000} />
        </Text>
      ),
    },
    {
      id: "block",
      label: tWaf("actions"),
      width: 120,
      align: "right",
      render: (row) =>
        row.blocked ? (
          <Badge variant="error" label={t("alreadyBlocked")} />
        ) : (
          <Button
            variant="secondary"
            size="sm"
            icon={<Ban />}
            label={t("block")}
            onClick={() => setBlock({ kind: "ip", value: row.ip, reason: "" })}
          />
        ),
    },
  ];

  const eventColumns: Column<EventRow>[] = [
    {
      id: "ts",
      label: tWaf("time"),
      width: 200,
      render: (row) => (
        <Text type="code" size="xsm" color="secondary">
          <Timestamp value={row.ts * 1000} />
        </Text>
      ),
    },
    {
      id: "action",
      label: tWaf("action"),
      width: 130,
      render: (row) =>
        row.blocked ? (
          <Badge variant="error" label={tWaf("blocked")} />
        ) : (
          <Badge variant="warning" label={tWaf("detected")} />
        ),
    },
    {
      id: "host",
      label: tWaf("host"),
      render: (row) => (
        <Text type="code" size="xsm" maxLines={1}>
          {row.host || emptyValue}
        </Text>
      ),
    },
    {
      id: "clientIp",
      label: tWaf("clientIp"),
      width: 170,
      render: (row) => (
        <Text type="code" size="xsm">
          {row.clientIp}
        </Text>
      ),
    },
    {
      id: "request",
      label: tWaf("request"),
      render: (row) => (
        <Text type="code" size="xsm" color="secondary" maxLines={1}>
          {`${row.method} ${row.uri}`}
        </Text>
      ),
    },
    {
      id: "rule",
      label: tWaf("ruleId"),
      width: 110,
      render: (row) => (
        <Text type="code" size="xsm">
          {row.ruleId ?? emptyValue}
        </Text>
      ),
    },
    {
      id: "review",
      label: t("review"),
      width: 140,
      render: (row) =>
        row.review ? (
          <Badge
            variant={row.review.verdict === "intended" ? "success" : "warning"}
            label={
              row.review.verdict === "intended"
                ? tWaf("reviewedIntended")
                : tWaf("reviewedFalsePositive")
            }
          />
        ) : null,
    },
  ];

  const showPeak = () => {
    const peak = report.peak;
    if (!peak) return;
    navigate({ ...state, range: "custom", from: peak.ts, to: peak.ts + peak.bucketSeconds });
  };

  return (
    <VStack gap={6}>
      <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
        <VStack gap={1}>
          <Heading level={1}>{t("title")}</Heading>
          <Text type="body" size="sm" color="secondary">
            {t("description")}
          </Text>
        </VStack>
        <Button
          variant="secondary"
          icon={<Ban />}
          label={t("blockedSources")}
          onClick={() => router.push("/security/blocked-sources")}
        />
      </HStack>

      <VStack gap={3}>
        <HStack>
          <SegmentedControl
            label={t("range")}
            value={rangeValue}
            onChange={(next) => {
              if (next === "custom") {
                setShowCustom(true);
                return;
              }
              setShowCustom(false);
              navigate({ ...state, range: next as ExploreState["range"], from: null, to: null });
            }}
          >
            {ANALYTICS_RANGES.map((range) => (
              <SegmentedControlItem key={range} value={range} label={range} />
            ))}
            <SegmentedControlItem value="custom" label={t("rangeCustom")} />
          </SegmentedControl>
        </HStack>
        <FilterBar
          filters={state.filters}
          onChange={(filters) => navigate({ ...state, filters })}
        />
        {showCustom && (
          <HStack gap={2} vAlign="end" wrap="wrap">
            <DateTimeInput
              label={t("rangeFrom")}
              size="sm"
              value={(customFrom || undefined) as ISODateTimeString | undefined}
              onChange={(v) => setCustomFrom(v ?? "")}
            />
            <DateTimeInput
              label={t("rangeTo")}
              size="sm"
              value={(customTo || undefined) as ISODateTimeString | undefined}
              onChange={(v) => setCustomTo(v ?? "")}
            />
            <Button
              size="sm"
              label={t("applyRange")}
              onClick={() => {
                const from = fromZonedWallTime(customFrom, timeZone);
                const to = fromZonedWallTime(customTo, timeZone);
                if (from == null || to == null || from >= to) {
                  toast.error(t("invalidRange"));
                  return;
                }
                navigate({ ...state, range: "custom", from, to });
              }}
            />
          </HStack>
        )}
      </VStack>

      {report.source === "none" && (
        <Banner
          status="info"
          title={t("analyticsOffTitle")}
          description={t("analyticsOffDescription")}
          endContent={
            <Button
              variant="secondary"
              size="sm"
              label={t("openAnalyticsSettings")}
              onClick={() => router.push(settingsHref("analytics"))}
            />
          }
        />
      )}
      {report.source === "unavailable" && (
        <Banner
          status="warning"
          title={t("analyticsUnavailableTitle")}
          description={t("analyticsUnavailableDescription")}
        />
      )}
      {report.source === "waf" && (
        <Banner status="info" title={t("wafOnlyTitle")} description={t("wafOnlyDescription")} />
      )}

      <Grid columns={{ minWidth: 260, max: 3 }} gap={4}>
        <RuleSetCard report={report} />
        {!noAnalytics && <MitigatedCard report={report} />}
        {!noAnalytics && <SourcesCard report={report} />}
      </Grid>

      {!noAnalytics && (
        <>
          <SecurityChart report={report} onShowPeak={showPeak} />

          <VStack gap={4}>
            <Card padding={4}>
              <VStack gap={3}>
                <Text as="h2" type="body" size="sm" weight="semibold">
                  {t("topRules")}
                </Text>
                <DataTable
                  columns={ruleColumns}
                  data={report.topRules}
                  keyField="ruleId"
                  emptyMessage={t("topRulesEmpty")}
                  emptyHeadingLevel={3}
                />
              </VStack>
            </Card>
            <Card padding={4}>
              <VStack gap={3}>
                <Text as="h2" type="body" size="sm" weight="semibold">
                  {t("topSources")}
                </Text>
                <DataTable
                  columns={sourceColumns}
                  data={report.topSources}
                  keyField="ip"
                  emptyMessage={t("topSourcesEmpty")}
                  emptyHeadingLevel={3}
                />
              </VStack>
            </Card>
          </VStack>

          <VStack gap={3}>
            <Heading level={2}>{t("eventList")}</Heading>
            <DataTable
              columns={eventColumns}
              data={report.events.items}
              keyField="key"
              emptyMessage={t("eventListEmpty")}
              pagination={{
                total: report.events.total,
                page: report.events.page,
                perPage: report.events.perPage,
              }}
              expandOnRowClick
              expandedRow={(row) => (
                <WafEventInsight
                  eventKey={row.key}
                  hosts={hosts}
                  onChanged={() => router.refresh()}
                />
              )}
            />
          </VStack>
        </>
      )}

      <ExclusionDialog
        draft={exclusion}
        hosts={hosts}
        onClose={() => setExclusion(null)}
        onSaved={(message) => {
          setExclusion(null);
          toast.success(message);
          router.refresh();
        }}
      />
      <BlockSourceDialog
        draft={block}
        onClose={() => setBlock(null)}
        onSaved={(message) => {
          setBlock(null);
          toast.success(message);
          router.refresh();
        }}
      />
    </VStack>
  );
}
