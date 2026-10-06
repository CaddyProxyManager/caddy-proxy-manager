"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApexOptions } from "apexcharts";
import { ArrowLeftRight, BarChart2, Gauge, History, KeyRound, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Link as AstryxLink } from "@astryxdesign/core/Link";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { SelectableCard } from "@astryxdesign/core/SelectableCard";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { type useFormatter, useTranslations } from "next-intl";
import { useAppFormatter } from "@/src/components/locale/use-app-formatter";
import { ACCENTS, type Hue } from "@/components/ui/accent";
import { CARD_TITLE_CLASS } from "@/components/ui/card-title";
import { CountryFlag } from "@/components/ui/CountryFlag";
import { useEmptyValue } from "@/components/ui/empty-value";
import { Timestamp } from "@/components/ui/Timestamp";
import { useChartTheme, type ChartTheme } from "./analytics/chart-theme";
import { useTableDensity } from "@/components/ui/TableDensity";
import Link from "next/link";
import { settingsHref } from "./settings/sections";
import { NeedsAttentionCard } from "@/components/overview/NeedsAttentionCard";
import { SetupChecklistCard } from "@/components/overview/SetupChecklistCard";
import type { AttentionList } from "@/lib/attention/types";
import type { SetupChecklist } from "@/lib/setup-checklist/steps";

// Client only: v7's server entry is an async Server Component (see AnalyticsClient).
const ReactApexChart = dynamic(() => import("react-apexcharts"), { ssr: false });

/** Keyed by name so the server can name one. */
const STAT_ICONS = {
  proxyHosts: ArrowLeftRight,
  certificates: ShieldCheck,
  accessLists: KeyRound,
} as const;

const STAT_HUES: Record<keyof typeof STAT_ICONS, Hue> = {
  proxyHosts: "purple",
  certificates: "green",
  accessLists: "yellow",
};

export type StatCard = {
  label: string;
  icon: keyof typeof STAT_ICONS;
  /** Where `total` is set, the enabled subset of it. */
  count: number;
  /** Set where disabled rows exist: a bare count would overstate what is being served. */
  total?: number;
  href: string;
};

export type RecentEvent = {
  id: number;
  action: string;
  entityType: string;
  /** Null for the system, or an account since deleted. */
  actor: string | null;
  summary: string;
  createdAt: string;
};

type TrafficSummary = {
  totalRequests: number;
  blockedPercent: number;
} | null;

// ── The shapes /api/analytics/overview returns ───────────────────────────────
// Not imported from analytics-db, which would pull ClickHouse into the client bundle.

type TimelineBucket = {
  ts: number;
  total: number;
  blocked: number;
  clientErrors: number;
  serverErrors: number;
  bytes: number;
  serverEvents: number;
};

type TrafficEvent = {
  ts: number;
  clientIp: string;
  countryCode: string | null;
  host: string;
  method: string;
  uri: string;
  status: number;
  proto: string;
  bytesSent: number;
  isBlocked: boolean;
};

export type OverviewPayload = {
  summary: {
    totalRequests: number;
    uniqueIps: number;
    blockedRequests: number;
    blockedPercent: number;
    bytesServed: number;
    loggingDisabled: boolean;
    analyticsDisabled: boolean;
  };
  statusClasses: { ok: number; clientErrors: number; serverErrors: number; blocked: number };
  wafBlocked: number;
  timeline: TimelineBucket[];
  events: TrafficEvent[];
};

const INTERVALS = ["1h", "12h", "24h", "7d", "30d"] as const;
type Interval = (typeof INTERVALS)[number];

type MetricKey =
  | "requests"
  | "serverEvents"
  | "serverErrors"
  | "clientErrors"
  | "bandwidth"
  | "blocked";

/**
 * `filter` and `series` come from the same window, so a tile's number, line and rows agree.
 * `color` is per metric, not per position, so a series keeps its colour alone or overlaid.
 * `serverEvents` is audit rows, bucketed by the server on the traffic timeline's buckets.
 */
type MetricDef = {
  key: MetricKey;
  filter: "all" | "server-errors" | "client-errors" | "largest" | "blocked";
  series:
    | keyof Pick<
        TimelineBucket,
        "total" | "blocked" | "clientErrors" | "serverErrors" | "bytes" | "serverEvents"
      >
    | null;
  format: "count" | "bytes";
  /** A series colour that is also a tile hue. */
  color?: Extract<keyof ChartTheme["series"], Hue>;
};

const METRICS: MetricDef[] = [
  { key: "requests", filter: "all", series: "total", format: "count", color: "blue" },
  {
    key: "serverEvents",
    filter: "all",
    series: "serverEvents",
    format: "count",
    color: "green",
  },
  {
    key: "serverErrors",
    filter: "server-errors",
    series: "serverErrors",
    format: "count",
    color: "red",
  },
  {
    key: "clientErrors",
    filter: "client-errors",
    series: "clientErrors",
    format: "count",
    color: "orange",
  },
  {
    key: "bandwidth",
    filter: "largest",
    series: "bytes",
    format: "bytes",
    color: "purple",
  },
  { key: "blocked", filter: "blocked", series: "blocked", format: "count", color: "cyan" },
];

type PlottedMetric = MetricDef & {
  series: NonNullable<MetricDef["series"]>;
  color: NonNullable<MetricDef["color"]>;
};
const PLOTTABLE: PlottedMetric[] = METRICS.filter(
  (m): m is PlottedMetric => m.series !== null && m.color !== undefined,
);

/** Through next-intl, not `toFixed`, which always writes English's decimal separator. */
function formatBytes(format: ReturnType<typeof useFormatter>, bytes: number): string {
  const fixed = (value: number, digits: number) =>
    format.number(value, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (bytes <= 0) return "0";
  if (bytes >= 1024 ** 3) return `${fixed(bytes / 1024 ** 3, 1)} GB`;
  if (bytes >= 1024 ** 2) return `${fixed(bytes / 1024 ** 2, 1)} MB`;
  if (bytes >= 1024) return `${format.number(Math.round(bytes / 1024))} KB`;
  return `${format.number(bytes)} B`;
}

function formatBucket(
  format: ReturnType<typeof useFormatter>,
  ts: number,
  rangeSeconds: number,
): string {
  const d = new Date(ts * 1000);
  if (rangeSeconds > 7 * 86400) return format.dateTime(d, { day: "numeric", month: "short" });
  if (rangeSeconds > 86400) {
    return format.dateTime(d, { day: "numeric", month: "short", hour: "2-digit" });
  }
  return format.dateTime(d, { hour: "2-digit", minute: "2-digit" });
}

const RANGE_SECONDS: Record<Interval, number> = {
  "1h": 3600,
  "12h": 43200,
  "24h": 86400,
  "7d": 7 * 86400,
  "30d": 30 * 86400,
};

/** Preview only; keep in step with the WHERE clause in `queryTrafficEvents`. */
function matchesFilter(filter: MetricDef["filter"]): (event: TrafficEvent) => boolean {
  switch (filter) {
    case "server-errors":
      return (event) => event.status >= 500;
    case "client-errors":
      return (event) => event.status >= 400 && event.status < 500;
    case "blocked":
      return (event) => event.isBlocked;
    case "largest":
      return (event) => event.bytesSent > 0;
    default:
      return () => true;
  }
}

const AUDIT_VARIANT: Record<string, "success" | "error" | "info"> = {
  create: "success",
  add: "success",
  delete: "error",
  remove: "error",
};

/** In its chart series' hue, so a tile and its line read as one. */
function Tile({
  label,
  value,
  hue,
  isSelected,
  onSelect,
  children,
}: {
  label: string;
  value: string;
  hue: Hue;
  isSelected: boolean;
  onSelect: () => void;
  children?: ReactNode;
}) {
  return (
    <SelectableCard
      label={label}
      isSelected={isSelected}
      onChange={onSelect}
      padding={4}
      className={ACCENTS[hue].edge}
    >
      <VStack gap={1}>
        <Text type="body" weight="semibold" className={CARD_TITLE_CLASS}>
          {label}
        </Text>
        <Text type="large" weight="semibold" hasTabularNumbers className={ACCENTS[hue].text}>
          {value}
        </Text>
        {children}
      </VStack>
    </SelectableCard>
  );
}

export default function OverviewClient({
  userName,
  stats,
  trafficSummary,
  recentEvents,
  serverEventCount = 0,
  previewPayload,
  isAdmin = true,
  showAttention = isAdmin,
  previewAttention,
  previewChecklist,
}: {
  userName: string;
  stats: StatCard[];
  trafficSummary: TrafficSummary;
  recentEvents: RecentEvent[];
  /** Audit rows in the last 24 hours. */
  serverEventCount?: number;
  /** For the docs demo, which has no API; a copy of this page there would go stale silently. */
  previewPayload?: OverviewPayload;
  isAdmin?: boolean;
  /** Admins and operators; an operator's list holds only what their grants reach. */
  showAttention?: boolean;
  /** For the docs demo, as `previewPayload`. */
  previewAttention?: AttentionList;
  previewChecklist?: SetupChecklist;
}) {
  const t = useTranslations("overview");
  const tCommon = useTranslations("common");
  const density = useTableDensity();
  const format = useAppFormatter();
  const emptyValue = useEmptyValue();
  const chartTheme = useChartTheme();

  const [interval, setIntervalValue] = useState<Interval>("24h");
  // Null: no tile picked, so the chart and log show everything.
  const [metricKey, setMetricKey] = useState<MetricKey | null>(null);
  const [payload, setPayload] = useState<OverviewPayload | null>(previewPayload ?? null);
  const [isLoading, setIsLoading] = useState(isAdmin && !previewPayload);
  const [hasFailed, setHasFailed] = useState(false);

  const metric = metricKey === null ? null : (METRICS.find((m) => m.key === metricKey) ?? null);
  const filter = metric?.filter ?? "all";
  const isEventsOnly = metricKey === "serverEvents";
  // Other traffic tiles are slices of the requests, which controller changes are not part of.
  const blendsEvents = metricKey === null || metricKey === "requests";

  // Literal keys, so next-intl can type-check them against the catalog.
  const metricLabel = useCallback(
    (key: MetricKey): string => {
      switch (key) {
        case "requests":
          return tCommon("requests");
        case "serverEvents":
          return t("metricServerEvents");
        case "serverErrors":
          return t("metricServerErrors");
        case "clientErrors":
          return t("metricClientErrors");
        case "bandwidth":
          return t("metricBandwidth");
        case "blocked":
          return t("metricBlocked");
      }
    },
    [t, tCommon],
  );

  useEffect(() => {
    if (!isAdmin) return;
    if (previewPayload) {
      setPayload(previewPayload);
      setIsLoading(false);
      return;
    }
    const abort = new AbortController();
    setIsLoading(true);
    const params = new URLSearchParams({ interval, filter, limit: "40" });
    fetch(`/api/analytics/overview?${params.toString()}`, { signal: abort.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((json: OverviewPayload) => {
        setPayload(json);
        setHasFailed(false);
        setIsLoading(false);
      })
      .catch((error: unknown) => {
        // Superseded, not failed: the old window stays up so the page does not flash.
        if (error instanceof DOMException && error.name === "AbortError") return;
        setHasFailed(true);
        setIsLoading(false);
      });
    return () => abort.abort();
  }, [isAdmin, interval, filter, previewPayload]);

  const rangeSeconds = RANGE_SECONDS[interval];
  const timeline = payload?.timeline ?? [];

  // A tile with no series leaves the overlay up rather than blanking the chart.
  const plotted = useMemo<PlottedMetric[]>(() => {
    const selected = PLOTTABLE.find((m) => m.key === metricKey);
    return selected ? [selected] : PLOTTABLE;
  }, [metricKey]);
  const isOverlay = plotted.length > 1;

  const chartSeries = useMemo(
    () =>
      plotted.map((m) => ({
        name: metricLabel(m.key),
        data: timeline.map((b) => b[m.series]),
      })),
    [plotted, timeline, metricLabel],
  );

  const chartOptions: ApexOptions = useMemo(() => {
    // Counts share one axis so they compare honestly; bytes take the right-hand one. Server
    // events get a scale of their own: a few changes beside thousands of requests read as zero.
    const ownScale = (m: PlottedMetric) => m.key === "serverEvents" && isOverlay;
    const countAxis =
      chartSeries[plotted.findIndex((m) => m.format === "count" && !ownScale(m))]?.name;
    return {
      ...chartTheme.base,
      chart: {
        ...chartTheme.base.chart,
        // Five overlaid fills are mud; alone, the fill makes the shape readable at 220px.
        type: isOverlay ? "line" : "area",
        stacked: false,
        id: "overview",
      },
      colors: plotted.map((m) => chartTheme.series[m.color]),
      fill: isOverlay
        ? { type: "solid" }
        : { type: "gradient", gradient: { shadeIntensity: 1, opacityFrom: 0.45, opacityTo: 0.05 } },
      stroke: { curve: "smooth", width: 2 },
      dataLabels: { enabled: false },
      xaxis: {
        categories: timeline.map((b) => formatBucket(format, b.ts, rangeSeconds)),
        labels: { rotate: 0, style: { colors: chartTheme.labelColor, fontSize: "11px" } },
        axisBorder: { show: false },
        axisTicks: { show: false },
      },
      // One entry per series; a shared `seriesName` is what makes the counts share a scale.
      yaxis: plotted.map((m, index) => ({
        opposite: m.format === "bytes",
        seriesName: m.format === "bytes" || ownScale(m) ? chartSeries[index]?.name : countAxis,
        show: !ownScale(m) && (m.format === "bytes" || chartSeries[index]?.name === countAxis),
        labels: {
          style: { colors: chartTheme.labelColor },
          formatter: (value: number) =>
            m.format === "bytes" ? formatBytes(format, value) : format.number(Math.round(value)),
        },
      })),
      legend: {
        show: isOverlay,
        position: "bottom",
        horizontalAlign: "left",
        labels: { colors: chartTheme.labelColor },
        // Two axes would otherwise stack as separate legend blocks down a 260px chart.
        clusterGroupedSeries: false,
      },
      tooltip: {
        theme: chartTheme.mode,
        shared: true,
        intersect: false,
        // Shared tooltip, mixed units: ask which series this is.
        y: {
          formatter: (value: number, opts?: { seriesIndex: number }) =>
            plotted[opts?.seriesIndex ?? 0]?.format === "bytes"
              ? formatBytes(format, value)
              : format.number(Math.round(value)),
        },
      },
    };
  }, [chartTheme, plotted, chartSeries, isOverlay, timeline, rangeSeconds, format]);

  // Interleaved, so a config change and the 502s that followed it land next to each other.
  type LogRow =
    | ({ kind: "traffic"; id: string } & TrafficEvent)
    | {
        kind: "event";
        id: string;
        ts: number;
        action: string;
        entityType: string;
        actor: string | null;
        summary: string;
      };

  const logColumns: TableColumn<LogRow>[] = useMemo(
    () => [
      {
        key: "ts",
        header: tCommon("time"),
        // Fits a 12-hour clock with seconds, the longest locale; narrower wraps the "AM".
        width: pixel(116),
        renderCell: (row) => (
          <Text type="code" size="sm" color="secondary">
            <Timestamp value={row.ts * 1000} style="time" />
          </Text>
        ),
      },
      {
        key: "what",
        header: t("logStatus"),
        // Proportional: a width that suits a status cuts off `forward_auth_access_denied`.
        width: proportional(1),
        renderCell: (row) =>
          row.kind === "traffic" ? (
            <HStack gap={1} vAlign="center">
              <Badge
                variant={row.status >= 500 ? "error" : row.status >= 400 ? "warning" : "success"}
                label={String(row.status)}
              />
              {row.isBlocked && <StatusDot variant="error" label={t("logBlocked")} />}
            </HStack>
          ) : (
            <Badge variant={AUDIT_VARIANT[row.action] ?? "info"} label={row.action} />
          ),
      },
      {
        key: "detail",
        header: t("logDetail"),
        width: proportional(3),
        renderCell: (row) =>
          row.kind === "traffic" ? (
            <VStack gap={0} className="cpm-cell-lines">
              <Text type="code" size="sm" maxLines={1}>
                {row.method} {row.host}
                {row.uri}
              </Text>
              {/* One line: nine columns will not fit a table that also carries audit rows. */}
              <HStack gap={1} vAlign="center">
                <Text type="body" size="sm" color="secondary" maxLines={1}>
                  {formatBytes(format, row.bytesSent)} &middot; {row.proto || emptyValue} &middot;
                </Text>
                {row.countryCode && <CountryFlag code={row.countryCode} />}
                <Text type="body" size="sm" color="secondary" maxLines={1} className="min-w-0">
                  {row.clientIp}
                </Text>
              </HStack>
            </VStack>
          ) : (
            <VStack gap={0} className="cpm-cell-lines">
              <Text type="body" size="sm" maxLines={1}>
                {row.summary}
              </Text>
              <Text type="body" size="sm" color="secondary" maxLines={1}>
                {row.actor ?? t("actorSystem")} &middot; {row.entityType}
              </Text>
            </VStack>
          ),
      },
    ],
    [t, emptyValue, format, tCommon],
  );

  const logRows = useMemo<LogRow[]>(() => {
    let traffic = isEventsOnly ? [] : (payload?.events ?? []);
    // A supplied window arrives whole, so slice it here as the query otherwise would.
    if (previewPayload && !isEventsOnly) {
      traffic = traffic.filter(matchesFilter(filter));
      if (filter === "largest") {
        traffic = [...traffic].sort((a, b) => b.bytesSent - a.bytesSent);
      }
    }
    const trafficRows: LogRow[] = traffic.map((event, index) => ({
      ...event,
      kind: "traffic",
      id: `t-${event.ts}-${index}`,
    }));

    if (!blendsEvents && !isEventsOnly) return trafficRows;

    const eventRows: LogRow[] = recentEvents.map((event) => ({
      kind: "event",
      id: `e-${event.id}`,
      ts: Math.floor(new Date(event.createdAt).getTime() / 1000),
      action: event.action,
      entityType: event.entityType,
      actor: event.actor,
      summary: event.summary,
    }));
    if (isEventsOnly) return eventRows;

    // The largest-first tile never blends, so newest first is safe here.
    return [...trafficRows, ...eventRows].sort((a, b) => b.ts - a.ts);
  }, [payload, previewPayload, filter, isEventsOnly, blendsEvents, recentEvents]);

  const tileValue = (key: MetricKey): string => {
    // The range's own count once loaded, so the tile and its line agree; the 24h figure before.
    if (key === "serverEvents") {
      return format.number(
        payload ? timeline.reduce((sum, b) => sum + (b.serverEvents ?? 0), 0) : serverEventCount,
      );
    }
    if (!payload) return emptyValue;
    switch (key) {
      case "requests":
        return format.number(payload.summary.totalRequests);
      case "serverErrors":
        return format.number(payload.statusClasses.serverErrors);
      case "clientErrors":
        return format.number(payload.statusClasses.clientErrors);
      case "bandwidth":
        return formatBytes(format, payload.summary.bytesServed);
      case "blocked":
        return format.number(payload.statusClasses.blocked);
    }
  };

  // Everything below reads ClickHouse or the audit log, both admin-only.
  if (!isAdmin) {
    return (
      <VStack gap={8}>
        <Heading level={1}>{t("welcomeBack", { name: userName })}</Heading>
        {showAttention && <NeedsAttentionCard preview={previewAttention} />}
      </VStack>
    );
  }

  const loggingOff = payload?.summary.loggingDisabled || payload?.summary.analyticsDisabled;

  return (
    <VStack gap={5}>
      <HStack justify="between" vAlign="center" gap={4} wrap="wrap">
        <Heading level={1}>{t("welcomeBack", { name: userName })}</Heading>
        <SegmentedControl
          label={tCommon("timeRange")}
          size="sm"
          value={interval}
          onChange={(next) => setIntervalValue(next as Interval)}
        >
          {INTERVALS.map((iv) => (
            <SegmentedControlItem key={iv} value={iv} label={iv} />
          ))}
        </SegmentedControl>
      </HStack>

      {loggingOff && (
        <Banner
          status="warning"
          title={t("loggingOffTitle")}
          description={t("loggingOffDescription")}
          endContent={
            isAdmin ? (
              <Button
                size="sm"
                variant="secondary"
                href={settingsHref("analytics")}
                as={Link}
                label={tCommon("enable")}
              />
            ) : undefined
          }
        />
      )}
      {hasFailed && <Banner status="error" title={t("loadFailedTitle")} />}

      <NeedsAttentionCard preview={previewAttention} />
      <SetupChecklistCard preview={previewChecklist} />

      {/* The only route to these pages that skips the side navigation. */}
      <Grid columns={{ minWidth: 200, max: 3 }} gap={3}>
        {stats.map((stat) => (
          <ClickableCard
            key={stat.label}
            label={t("statCardLabel", {
              label: stat.label,
              value:
                stat.total === undefined
                  ? stat.count
                  : t("statEnabledOf", { enabled: stat.count, total: stat.total }),
            })}
            href={stat.href}
            padding={4}
            className={ACCENTS[STAT_HUES[stat.icon]].edge}
          >
            <HStack gap={3} vAlign="center">
              <Card variant={STAT_HUES[stat.icon]} padding={2}>
                <Icon icon={STAT_ICONS[stat.icon]} color={STAT_HUES[stat.icon]} />
              </Card>
              <VStack gap={0}>
                <HStack gap={1} vAlign="end">
                  <Text
                    type="display-3"
                    hasTabularNumbers
                    className={ACCENTS[STAT_HUES[stat.icon]].text}
                  >
                    {String(stat.count)}
                  </Text>
                  {stat.total !== undefined && (
                    <Text type="body" size="sm" color="secondary" hasTabularNumbers>
                      {t("statOfTotal", { total: stat.total })}
                    </Text>
                  )}
                </HStack>
                <Text type="body" className={CARD_TITLE_CLASS}>
                  {stat.label}
                </Text>
              </VStack>
            </HStack>
          </ClickableCard>
        ))}
      </Grid>

      <Grid columns={{ minWidth: 160, max: 6 }} gap={3}>
        {METRICS.map((m) => (
          <Tile
            key={m.key}
            label={metricLabel(m.key)}
            value={tileValue(m.key)}
            hue={m.color ?? "gray"}
            isSelected={m.key === metricKey}
            onSelect={() => setMetricKey((current) => (current === m.key ? null : m.key))}
          />
        ))}
      </Grid>

      {/* A row each: the chart wants width, and the log wants it more. */}
      <Card padding={5}>
        <VStack gap={3}>
          <HStack justify="between" vAlign="center" gap={2}>
            <HStack gap={2} vAlign="center">
              <Icon icon={metricKey === "bandwidth" ? Gauge : BarChart2} size="sm" color="accent" />
              <Heading level={2} accessibilityLevel={2}>
                {isOverlay ? t("metricAll") : metricLabel(plotted[0].key)}
              </Heading>
            </HStack>
            <HStack gap={3} vAlign="center">
              {isLoading && <Spinner label={t("loading")} size="sm" />}
              <AstryxLink href="/analytics">{t("viewAnalytics")}</AstryxLink>
            </HStack>
          </HStack>
          {timeline.length === 0 ? (
            <EmptyState title={t("periodEmptyTitle")} isCompact />
          ) : (
            <ReactApexChart
              type={isOverlay ? "line" : "area"}
              series={chartSeries}
              options={chartOptions}
              height={isOverlay ? 260 : 220}
            />
          )}
        </VStack>
      </Card>

      <Card padding={5}>
        <VStack gap={3}>
          <HStack justify="between" vAlign="center" gap={2}>
            <HStack gap={2} vAlign="center">
              <Icon icon={History} size="sm" color="accent" />
              <Heading level={2} accessibilityLevel={2}>
                {t("logTitle")}
              </Heading>
            </HStack>
            <Badge variant="neutral" label={metricKey ? metricLabel(metricKey) : t("metricAll")} />
          </HStack>
          {logRows.length === 0 ? (
            <EmptyState
              title={isEventsOnly ? t("activityEmptyMessage") : t("requestLogEmptyTitle")}
              isCompact
            />
          ) : (
            // No overflow-x wrapper: Table scrolls itself, and overflow-x:auto forces
            // overflow-y to auto too, which added a stray vertical scrollbar.
            <Table data={logRows} columns={logColumns} idKey="id" density={density} />
          )}
          <Text type="supporting">
            {isEventsOnly
              ? t("logSourceEvents")
              : blendsEvents
                ? t("logSourceBoth")
                : t("logSourceTraffic")}
          </Text>
        </VStack>
      </Card>

      {/* The 24h headline stays even when a longer range is selected. */}
      {trafficSummary && trafficSummary.totalRequests > 0 && (
        <Text type="body" size="sm" color="secondary">
          {t("traffic24hSummary", {
            total: format.number(trafficSummary.totalRequests),
            percent: trafficSummary.blockedPercent,
          })}
        </Text>
      )}
    </VStack>
  );
}
