"use client";

import type React from "react";
import { useState, useEffect, useCallback, useMemo } from "react";
import dynamic from "next/dynamic";
import dayjs, { type Dayjs } from "dayjs";
import { toast } from "sonner";
import type { ApexOptions } from "apexcharts";

import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { DateTimeInput, type ISODateTimeString } from "@astryxdesign/core/DateTimeInput";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Link as AstryxLink } from "@astryxdesign/core/Link";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Pagination } from "@astryxdesign/core/Pagination";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Spinner } from "@astryxdesign/core/Spinner";
import {
  Table,
  pixel,
  proportional,
  useTableRowStatus,
  type TableColumn,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { List, ListItem } from "@astryxdesign/core/List";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Timestamp } from "@/components/ui/Timestamp";
import { FilterChip } from "@/src/components/mobile/FilterChip";
import { OptionSheet } from "@/src/components/mobile/OptionSheet";

import { useChartTheme } from "./chart-theme";
import { settingsHref } from "../settings/sections";
import { useFormatter, useTranslations } from "next-intl";
import { useEmptyValue } from "@/components/ui/empty-value";
import { CARD_TITLE_STYLE } from "@/components/ui/card-title";
import { CountryBreakdown } from "./CountryBreakdown";
import type { MapMetric } from "./WorldMapInner";
import { useTableDensity } from "@/components/ui/TableDensity";

// ── Dynamic imports (browser-only) ────────────────────────────────────────────

// ApexCharts v7 server-renders only via an async Server Component this client file cannot reach,
// and every dataset arrives in an effect anyway.
const ReactApexChart = dynamic(() => import("react-apexcharts"), { ssr: false });

/** `loading` is called at module scope, where no hook can run. */
function MapLoading() {
  const t = useTranslations("analytics");
  return (
    <HStack justify="center" vAlign="center" height={240}>
      <Spinner label={t("loadingMap")} />
    </HStack>
  );
}

const WorldMap = dynamic(() => import("./WorldMapInner"), {
  ssr: false,
  loading: () => <MapLoading />,
}) as React.ComponentType<{
  data: import("./WorldMapInner").CountryStats[];
  selectedCountry?: string | null;
  metric?: import("./WorldMapInner").MapMetric;
  onSelectCountry?: (alpha2: string | null) => void;
}>;

// ── Types (mirrored from analytics-db - can't import server-only code) ────────

type Interval = "1h" | "12h" | "24h" | "7d" | "30d";
type DisplayInterval = Interval | "custom";

const INTERVAL_SECONDS_CLIENT: Record<Interval, number> = {
  "1h": 3600,
  "12h": 43200,
  "24h": 86400,
  "7d": 7 * 86400,
  "30d": 30 * 86400,
};

interface AnalyticsSummary {
  totalRequests: number;
  uniqueIps: number;
  blockedRequests: number;
  blockedPercent: number;
  bytesServed: number;
  loggingDisabled: boolean;
  analyticsDisabled: boolean;
}

interface TimelineBucket {
  ts: number;
  total: number;
  blocked: number;
}
interface CountryStats {
  countryCode: string;
  total: number;
  blocked: number;
  uniqueIps: number;
}
interface ProtoStats {
  proto: string;
  count: number;
  percent: number;
}
interface UAStats {
  userAgent: string;
  count: number;
  percent: number;
}

interface AnalyticsHost {
  host: string;
  configured: boolean;
}

interface BlockedEvent {
  id: number;
  ts: number;
  clientIp: string;
  countryCode: string | null;
  method: string;
  uri: string;
  status: number;
  host: string;
}
interface BlockedPage {
  events: BlockedEvent[];
  total: number;
  page: number;
  pages: number;
}

/** Astryx's Table requires an index signature on rows. */
type CountryRow = {
  countryCode: string;
  total: number;
  blocked: number;
  uniqueIps: number;
  waf: number;
  [k: string]: unknown;
};
type ProtoRow = ProtoStats & { [k: string]: unknown };
type BlockedRow = BlockedEvent & { [k: string]: unknown };

interface TopWafRule {
  ruleId: number;
  count: number;
  message: string | null;
  hosts: { host: string; count: number }[];
}
type WafRuleRow = TopWafRule & { [k: string]: unknown };
interface WafStats {
  total: number;
  topRules: TopWafRule[];
  byCountry: { countryCode: string; count: number }[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function countryFlag(code: string): string {
  if (code?.length !== 2) return "🌐";
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

/** `unknown` is passed in because it comes from the catalog. */
function parseUA(ua: string, unknown: string): string {
  if (!ua) return unknown;
  if (/Googlebot/i.test(ua)) return "Googlebot";
  if (/bingbot/i.test(ua)) return "Bingbot";
  if (/DuckDuckBot/i.test(ua)) return "DuckDuckBot";
  if (/curl/i.test(ua)) return "curl";
  if (/python-requests|Python\//i.test(ua)) return "Python";
  if (/Go-http-client/i.test(ua)) return "Go";
  if (/wget/i.test(ua)) return "wget";
  if (/Edg\//i.test(ua)) return "Edge";
  if (/OPR\//i.test(ua)) return "Opera";
  if (/SamsungBrowser/i.test(ua)) return "Samsung Browser";
  if (/Chrome\//i.test(ua)) return "Chrome";
  if (/Firefox\//i.test(ua)) return "Firefox";
  if (/Safari\//i.test(ua)) return "Safari";
  return ua.substring(0, 32);
}

/** Through next-intl, not `toFixed`, which writes English's decimal separator in every locale. */
function formatBytes(format: ReturnType<typeof useFormatter>, bytes: number): string {
  const fixed = (value: number, digits: number) =>
    format.number(value, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (bytes < 1024) return `${format.number(bytes)} B`;
  if (bytes < 1024 * 1024) return `${fixed(bytes / 1024, 1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${fixed(bytes / 1024 / 1024, 1)} MB`;
  return `${fixed(bytes / 1024 / 1024 / 1024, 2)} GB`;
}

function formatTs(
  format: ReturnType<typeof useFormatter>,
  ts: number,
  rangeSeconds: number,
): string {
  const d = new Date(ts * 1000);
  if (rangeSeconds <= 86400) return format.dateTime(d, { hour: "2-digit", minute: "2-digit" });
  if (rangeSeconds <= 7 * 86400) {
    return format.dateTime(d, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  }
  return format.dateTime(d, { month: "short", day: "numeric" });
}

// ── Local DateTimePicker ───────────────────────────────────────────────────────

function DateTimePicker({
  value,
  onChange,
  placeholder,
}: {
  value: Dayjs | null;
  onChange: (v: Dayjs | null) => void;
  placeholder?: string;
}) {
  const t = useTranslations("analytics");
  return (
    <DateTimeInput
      label={placeholder ?? t("pickDateTime")}
      isLabelHidden
      value={
        (value ? value.format("YYYY-MM-DDTHH:mm") : undefined) as ISODateTimeString | undefined
      }
      onChange={(next) => onChange(next ? dayjs(next) : null)}
      size="sm"
      width={200}
    />
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

type StatTone = "error" | "warning";

const STAT_TONE_VAR: Record<StatTone, string> = {
  error: "var(--color-error)",
  warning: "var(--color-warning)",
};

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: StatTone;
}) {
  return (
    <Card padding={5} height="100%">
      <VStack gap={1}>
        <Text type="body" style={CARD_TITLE_STYLE}>
          {label}
        </Text>
        <Text type="display-3" hasTabularNumbers>
          <span style={tone ? { color: STAT_TONE_VAR[tone] } : undefined}>{value}</span>
        </Text>
        {sub && (
          <Text type="body" size="sm" color="secondary">
            {sub}
          </Text>
        )}
      </VStack>
    </Card>
  );
}

// ── Hosts multi-select combobox ───────────────────────────────────────────────

const INCLUDE_UNCONFIGURED_KEY = "analytics:includeUnconfiguredHosts";

function HostsCombobox({
  allHosts,
  selectedHosts,
  onChange,
}: {
  allHosts: AnalyticsHost[];
  selectedHosts: string[];
  onChange: (v: string[]) => void;
}) {
  const t = useTranslations("analytics");
  const [includeUnconfigured, setIncludeUnconfigured] = useState(false);

  useEffect(() => {
    try {
      setIncludeUnconfigured(localStorage.getItem(INCLUDE_UNCONFIGURED_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  function setFilter(v: boolean) {
    setIncludeUnconfigured(v);
    try {
      localStorage.setItem(INCLUDE_UNCONFIGURED_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  const hasUnconfigured = allHosts.some((h) => !h.configured);
  const visibleHosts = (includeUnconfigured ? allHosts : allHosts.filter((h) => h.configured)).map(
    (h) => h.host,
  );

  return (
    <VStack gap={2}>
      <MultiSelector
        label={t("hosts")}
        isLabelHidden
        options={visibleHosts.map((h) => ({ value: h, label: h }))}
        value={selectedHosts}
        onChange={onChange}
        hasSearch
        searchPlaceholder={t("searchHostsPlaceholder")}
        hasSelectAll
        triggerDisplay="badges"
        maxBadges={2}
        placeholder={t("allHosts")}
        width={240}
      />
      {hasUnconfigured && (
        <CheckboxInput
          label={t("includeUnconfiguredHostsLabel")}
          description={t("unconfiguredHostsHelp")}
          value={includeUnconfigured}
          onChange={setFilter}
        />
      )}
    </VStack>
  );
}

// ── Data fetching ─────────────────────────────────────────────────────────────

/** Carries the parts so the page can word it from the catalog. */
class UnexplainedStatusError extends Error {
  path: string;
  status: number;

  constructor(path: string, status: number) {
    super(`${path} failed with status ${status}`);
    this.path = path;
    this.status = status;
  }
}

/** An unchecked `{ error }` body lands in array state, and the first `.map()` blanks the page. */
async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const reported =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error).trim()
        : "";
    // ClickHouse errors often carry an empty message, which would leave the banner invisible.
    throw reported
      ? new Error(reported)
      : new UnexplainedStatusError(url.split("?")[0], response.status);
  }
  return body;
}

/** Renders empty rather than throwing on an odd 200. */
function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AnalyticsClient() {
  const t = useTranslations("analytics");
  const density = useTableDensity();
  const format = useFormatter();
  const emptyValue = useEmptyValue();
  const [interval, setIntervalVal] = useState<DisplayInterval>("1h");
  const [selectedHosts, setSelectedHosts] = useState<string[]>([]);
  const [allHosts, setAllHosts] = useState<AnalyticsHost[]>([]);

  const [customFrom, setCustomFrom] = useState<Dayjs | null>(null);
  const [customTo, setCustomTo] = useState<Dayjs | null>(null);

  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [timeline, setTimeline] = useState<TimelineBucket[]>([]);
  const [countries, setCountries] = useState<CountryStats[]>([]);
  const [protocols, setProtocols] = useState<ProtoStats[]>([]);
  const [userAgents, setUserAgents] = useState<UAStats[]>([]);
  const [blocked, setBlocked] = useState<BlockedPage | null>(null);
  const [wafStats, setWafStats] = useState<WafStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null);
  const [mapMetric, setMapMetric] = useState<MapMetric>("total");
  const isNarrow = useMediaQuery("(max-width: 767px)");
  const [intervalSheetOpen, setIntervalSheetOpen] = useState(false);
  const [metricSheetOpen, setMetricSheetOpen] = useState(false);

  const rangeSeconds = useMemo(() => {
    if (interval === "custom" && customFrom && customTo) {
      const diff = customTo.unix() - customFrom.unix();
      return diff > 0 ? diff : 3600;
    }
    return INTERVAL_SECONDS_CLIENT[interval as Interval] ?? 3600;
  }, [interval, customFrom, customTo]);

  const buildParams = useCallback(
    (extra = "") => {
      const h =
        selectedHosts.length > 0 ? `hosts=${selectedHosts.map(encodeURIComponent).join(",")}` : "";
      const sep = h ? `&${h}` : "";
      if (interval === "custom" && customFrom && customTo) {
        return `?from=${customFrom.unix()}&to=${customTo.unix()}${sep}${extra}`;
      }
      return `?interval=${interval}${sep}${extra}`;
    },
    [interval, selectedHosts, customFrom, customTo],
  );

  useEffect(() => {
    fetchJson("/api/analytics/hosts")
      .then((h) => setAllHosts(asArray<AnalyticsHost>(h)))
      .catch(() => setAllHosts([]));
  }, []);

  useEffect(() => {
    if (interval === "custom") {
      if (!customFrom || !customTo || customFrom.unix() >= customTo.unix()) return;
    }
    setLoading(true);
    const params = buildParams();
    Promise.all([
      fetchJson(`/api/analytics/summary${params}`),
      fetchJson(`/api/analytics/timeline${params}`),
      fetchJson(`/api/analytics/countries${params}`),
      fetchJson(`/api/analytics/protocols${params}`),
      fetchJson(`/api/analytics/user-agents${params}`),
      fetchJson(`/api/analytics/blocked${params}&page=1`),
      fetchJson(`/api/analytics/waf-stats${params}`),
    ])
      .then(([s, t, c, p, u, b, w]) => {
        setLoadError(null);
        setSummary(s as AnalyticsSummary);
        setTimeline(asArray<TimelineBucket>(t));
        setCountries(asArray<CountryStats>(c));
        setProtocols(asArray<ProtoStats>(p));
        setUserAgents(asArray<UAStats>(u));
        setBlocked(b as BlockedPage);
        setWafStats(w as WafStats);
      })
      .catch((err: unknown) => {
        // Reset to empty rather than leaving stale data next to an error banner.
        setLoadError(
          err instanceof UnexplainedStatusError
            ? t("requestFailedWithStatus", { path: err.path, status: err.status })
            : err instanceof Error
              ? err.message
              : t("loadErrorToast"),
        );
        setSummary(null);
        setTimeline([]);
        setCountries([]);
        setProtocols([]);
        setUserAgents([]);
        setBlocked(null);
        setWafStats(null);
        toast.error(t("loadErrorToast"));
      })
      .finally(() => setLoading(false));
  }, [buildParams, interval, customFrom, customTo, t]);

  const fetchBlockedPage = useCallback(
    (page: number) => {
      fetchJson(`/api/analytics/blocked${buildParams(`&page=${page}`)}`)
        .then((b) => setBlocked(b as BlockedPage))
        .catch(() => toast.error(t("blockedRequestsLoadError")));
    },
    [buildParams, t],
  );

  // ── Chart configs ─────────────────────────────────────────────────────────

  const chartTheme = useChartTheme();

  // Memoized: react-apexcharts deep-compares options and series, so a fresh object walked the
  // whole timeline on every unrelated state change.
  const timelineOptions = useMemo<ApexOptions>(
    () => ({
      ...chartTheme.base,
      chart: { ...chartTheme.base.chart, type: "area", stacked: false, id: "timeline" },
      colors: [chartTheme.series.blue, chartTheme.series.red],
      fill: {
        type: "gradient",
        gradient: { shadeIntensity: 1, opacityFrom: 0.45, opacityTo: 0.05 },
      },
      stroke: { curve: "smooth", width: 2 },
      dataLabels: { enabled: false },
      xaxis: {
        categories: timeline.map((b) => formatTs(format, b.ts, rangeSeconds)),
        labels: { rotate: 0, style: { colors: chartTheme.labelColor, fontSize: "11px" } },
        axisBorder: { show: false },
        axisTicks: { show: false },
      },
      yaxis: { labels: { style: { colors: chartTheme.labelColor } } },
      legend: { labels: { colors: chartTheme.labelColor } },
      tooltip: { theme: chartTheme.mode, shared: true, intersect: false },
    }),
    [chartTheme, timeline, rangeSeconds, format],
  );
  const timelineSeries = useMemo(
    () => [
      { name: t("seriesAllowed"), data: timeline.map((b) => b.total - b.blocked) },
      { name: t("metricBlocked"), data: timeline.map((b) => b.blocked) },
    ],
    [timeline, t],
  );

  const donutOptions = useMemo<ApexOptions>(
    () => ({
      ...chartTheme.base,
      chart: { ...chartTheme.base.chart, type: "donut", id: "protocols" },
      colors: [
        chartTheme.series.blue,
        chartTheme.series.purple,
        chartTheme.series.cyan,
        chartTheme.series.orange,
      ],
      labels: protocols.map((p) => p.proto),
      legend: { position: "bottom", labels: { colors: chartTheme.labelColor } },
      dataLabels: { style: { colors: [chartTheme.onSeries] } },
      plotOptions: { pie: { donut: { size: "65%" } } },
    }),
    [chartTheme, protocols],
  );
  const donutSeries = useMemo(() => protocols.map((p) => p.count), [protocols]);

  const barOptions = useMemo<ApexOptions>(
    () => ({
      ...chartTheme.base,
      chart: { ...chartTheme.base.chart, type: "bar", id: "ua" },
      colors: [chartTheme.series.purple],
      plotOptions: { bar: { horizontal: true, borderRadius: 4 } },
      dataLabels: { enabled: false },
      xaxis: {
        categories: userAgents.map((u) => parseUA(u.userAgent, t("unknownUserAgent"))),
        labels: { style: { colors: chartTheme.labelColor, fontSize: "12px" } },
      },
      yaxis: { labels: { style: { colors: chartTheme.labelColor, fontSize: "12px" } } },
    }),
    [chartTheme, userAgents, t],
  );
  const barSeries = useMemo(
    () => [{ name: t("metricRequests"), data: userAgents.map((u) => u.count) }],
    [userAgents, t],
  );

  const wafBarOptions = useMemo<ApexOptions>(
    () => ({
      ...chartTheme.base,
      chart: { ...chartTheme.base.chart, type: "bar", id: "waf-rules" },
      colors: [chartTheme.series.orange],
      plotOptions: { bar: { horizontal: true, borderRadius: 4 } },
      dataLabels: { enabled: false },
      xaxis: {
        categories: (wafStats?.topRules ?? []).map((r) => `#${r.ruleId}`),
        labels: { style: { colors: chartTheme.labelColor, fontSize: "12px" } },
      },
      yaxis: { labels: { style: { colors: chartTheme.labelColor, fontSize: "12px" } } },
    }),
    [chartTheme, wafStats],
  );
  const wafBarSeries = useMemo(
    () => [{ name: t("hits"), data: (wafStats?.topRules ?? []).map((r) => r.count) }],
    [wafStats, t],
  );

  const wafByCountry = new Map((wafStats?.byCountry ?? []).map((r) => [r.countryCode, r.count]));

  const INTERVALS: DisplayInterval[] = ["1h", "12h", "24h", "7d", "30d", "custom"];
  const intervalLabel = (iv: DisplayInterval) => (iv === "custom" ? t("intervalCustom") : iv);

  const changeInterval = (iv: DisplayInterval) => {
    if (iv === "custom" && !customFrom) {
      setCustomFrom(dayjs().subtract(24, "hour"));
      setCustomTo(dayjs());
    }
    setIntervalVal(iv);
  };

  const metricOptions: { value: MapMetric; label: string }[] = [
    { value: "total", label: t("metricRequests") },
    { value: "blocked", label: t("metricBlocked") },
    { value: "uniqueIps", label: t("uniqueIps") },
  ];

  // ── Table shapes ──────────────────────────────────────────────────────────

  const countryRows: CountryRow[] = countries.slice(0, 10).map((c) => ({
    countryCode: c.countryCode,
    total: c.total,
    blocked: c.blocked,
    uniqueIps: c.uniqueIps,
    waf: wafByCountry.get(c.countryCode) ?? 0,
  }));

  // Not a tinted background: colour alone is invisible to assistive tech.
  const countryStatus = useTableRowStatus<CountryRow>({
    getStatus: (row) =>
      row.countryCode === selectedCountry ? { color: "accent", label: t("selected") } : null,
  });

  const countryColumns: TableColumn<CountryRow>[] = [
    {
      key: "countryCode",
      header: t("country"),
      width: proportional(1),
      // A button, not a clickable row, so keyboard users can reach it.
      renderCell: (row) => (
        <Button
          variant="ghost"
          size="sm"
          label={
            row.countryCode === selectedCountry
              ? t("closeCountryBreakdown", { code: row.countryCode })
              : t("openCountryBreakdown", { code: row.countryCode })
          }
          onClick={() =>
            setSelectedCountry((cur) => (cur === row.countryCode ? null : row.countryCode))
          }
        >
          <HStack gap={2} vAlign="center">
            <span aria-hidden="true">{countryFlag(row.countryCode)}</span>
            <Text type="inherit" size="sm">
              {row.countryCode}
            </Text>
          </HStack>
        </Button>
      ),
    },
    {
      key: "total",
      header: t("total"),
      align: "end",
      width: pixel(90),
      renderCell: (row) => (
        <Text type="body" size="sm" hasTabularNumbers>
          {format.number(row.total)}
        </Text>
      ),
    },
    {
      key: "uniqueIps",
      header: t("uniqueIps"),
      align: "end",
      width: pixel(104),
      renderCell: (row) => (
        <Text type="body" size="sm" hasTabularNumbers>
          {format.number(row.uniqueIps)}
        </Text>
      ),
    },
    {
      key: "waf",
      header: t("waf"),
      align: "end",
      width: pixel(80),
      renderCell: (row) => (
        <Text type="body" size="sm" color={row.waf > 0 ? "primary" : "secondary"} hasTabularNumbers>
          {row.waf > 0 ? format.number(row.waf) : emptyValue}
        </Text>
      ),
    },
    {
      key: "blocked",
      header: t("metricBlocked"),
      align: "end",
      width: pixel(90),
      renderCell: (row) => (
        <Text
          type="body"
          size="sm"
          color={row.blocked > 0 ? "primary" : "secondary"}
          hasTabularNumbers
        >
          {format.number(row.blocked)}
        </Text>
      ),
    },
  ];

  const protocolRows: ProtoRow[] = protocols.map((p) => ({ ...p }));

  const protocolColumns: TableColumn<ProtoRow>[] = [
    {
      key: "proto",
      header: t("protocol"),
      width: proportional(1),
      renderCell: (row) => (
        <Text type="body" size="sm">
          {row.proto}
        </Text>
      ),
    },
    {
      key: "count",
      header: t("metricRequests"),
      align: "end",
      width: pixel(110),
      renderCell: (row) => (
        <Text type="body" size="sm" hasTabularNumbers>
          {format.number(row.count)}
        </Text>
      ),
    },
    {
      key: "percent",
      header: t("share"),
      align: "end",
      width: pixel(80),
      renderCell: (row) => (
        <Text type="body" size="sm" color="secondary" hasTabularNumbers>
          {row.percent}%
        </Text>
      ),
    },
  ];

  const blockedRows: BlockedRow[] = (blocked?.events ?? []).map((ev) => ({ ...ev }));

  const blockedColumns: TableColumn<BlockedRow>[] = [
    {
      key: "ts",
      header: t("time"),
      width: pixel(190),
      renderCell: (row) => (
        <Text type="body" size="sm" color="secondary">
          <Timestamp value={row.ts * 1000} />
        </Text>
      ),
    },
    {
      key: "clientIp",
      header: t("ip"),
      width: pixel(130),
      renderCell: (row) => (
        <Text type="code" size="sm">
          {row.clientIp}
        </Text>
      ),
    },
    {
      key: "countryCode",
      header: t("country"),
      width: pixel(100),
      renderCell: (row) => (
        <Text type="body" size="sm">
          {row.countryCode ? `${countryFlag(row.countryCode)} ${row.countryCode}` : emptyValue}
        </Text>
      ),
    },
    {
      key: "host",
      header: t("host"),
      width: pixel(160),
      renderCell: (row) => (
        <Text type="body" size="sm" maxLines={1}>
          {row.host || emptyValue}
        </Text>
      ),
    },
    {
      key: "method",
      header: t("method"),
      width: pixel(90),
      renderCell: (row) => (
        <Text type="code" size="sm">
          {row.method}
        </Text>
      ),
    },
    {
      key: "uri",
      header: t("uri"),
      width: proportional(1),
      renderCell: (row) => (
        <Tooltip content={row.uri}>
          <Text type="code" size="sm" maxLines={1}>
            {row.uri}
          </Text>
        </Tooltip>
      ),
    },
    {
      key: "status",
      header: t("status"),
      width: pixel(80),
      align: "end",
      renderCell: (row) => <Badge variant="error" label={String(row.status)} />,
    },
  ];

  const wafRuleRows: WafRuleRow[] = (wafStats?.topRules ?? []).map((r) => ({ ...r }));

  const wafRuleColumns: TableColumn<WafRuleRow>[] = [
    {
      key: "ruleId",
      header: t("rule"),
      width: pixel(90),
      renderCell: (row) => (
        <Text type="code" size="sm">
          #{row.ruleId}
        </Text>
      ),
    },
    {
      key: "message",
      header: t("description"),
      width: proportional(1),
      renderCell: (row) =>
        row.message ? (
          <Tooltip content={row.message}>
            <Text type="body" size="sm" color="secondary" maxLines={1}>
              {row.message}
            </Text>
          </Tooltip>
        ) : (
          <Text type="body" size="sm" color="secondary">
            {emptyValue}
          </Text>
        ),
    },
    {
      key: "count",
      header: t("hits"),
      width: pixel(80),
      align: "end",
      renderCell: (row) => (
        <Text type="body" size="sm" weight="semibold" hasTabularNumbers>
          {format.number(row.count)}
        </Text>
      ),
    },
    {
      key: "hosts",
      header: t("triggeredBy"),
      width: proportional(1),
      renderCell: (row) => (
        <HStack gap={1} wrap="wrap">
          {row.hosts.map((h) => (
            <Badge key={h.host} label={`${h.host} ×${h.count}`} />
          ))}
        </HStack>
      ),
    },
  ];

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <VStack gap={8}>
      <HStack justify="between" vAlign="center" gap={4} wrap="wrap">
        <VStack gap={0}>
          <Text type="label" size="xsm" color="secondary" className="cpm-desktop-only">
            {t("trafficIntelligence")}
          </Text>
          <Heading level={1}>{t("analytics")}</Heading>
        </VStack>
        <HStack gap={3} vAlign="center" wrap="wrap">
          <div className="cpm-desktop-only">
            <SegmentedControl
              label={t("timeInterval")}
              size="sm"
              value={interval}
              onChange={(next) => changeInterval(next as DisplayInterval)}
            >
              {INTERVALS.map((iv) => (
                <SegmentedControlItem key={iv} value={iv} label={intervalLabel(iv)} />
              ))}
            </SegmentedControl>
          </div>
          {/* Six segments do not fit a phone: the interval is a pill that opens a sheet. */}
          <div className="cpm-chip-row cpm-mobile-flex">
            <FilterChip
              label={intervalLabel(interval)}
              aria-label={t("timeInterval")}
              onClick={() => setIntervalSheetOpen(true)}
            />
          </div>
          <OptionSheet
            title={t("timeInterval")}
            isOpen={intervalSheetOpen}
            onOpenChange={setIntervalSheetOpen}
            value={interval}
            options={INTERVALS.map((iv) => ({ value: iv, label: intervalLabel(iv) }))}
            onChange={changeInterval}
          />

          {interval === "custom" && (
            <HStack gap={2} vAlign="center" wrap="wrap">
              <DateTimePicker value={customFrom} onChange={setCustomFrom} placeholder={t("from")} />
              <Text type="body" size="xsm" color="secondary">
                -
              </Text>
              <DateTimePicker value={customTo} onChange={setCustomTo} placeholder={t("to")} />
            </HStack>
          )}

          <HostsCombobox
            allHosts={allHosts}
            selectedHosts={selectedHosts}
            onChange={setSelectedHosts}
          />
        </HStack>
      </HStack>

      {loadError && (
        <div data-testid="analytics-load-error">
          <Banner status="error" title={t("loadErrorTitle")} description={loadError} />
        </div>
      )}

      {summary?.analyticsDisabled && (
        <Banner
          status="info"
          title={t("analyticsDisabledTitle")}
          description={t("analyticsDisabledDescription")}
        />
      )}

      {summary?.loggingDisabled && !summary?.analyticsDisabled && (
        <Banner
          status="warning"
          title={t("accessLoggingDisabledTitle")}
          description={
            <Text type="body" size="sm">
              {t.rich("accessLoggingDisabledDescription", {
                link: (chunks) => (
                  <AstryxLink href={settingsHref("analytics")}>{chunks}</AstryxLink>
                ),
              })}
            </Text>
          }
        />
      )}

      {loading && (
        <HStack justify="center" padding={10}>
          <Spinner size="lg" label={t("loadingAnalytics")} />
        </HStack>
      )}

      {!loading && summary && (
        <>
          {/* One card on a phone, where five tiles are a screen of their own. */}
          <div className="cpm-mobile-only">
            <Card padding={4}>
              <VStack gap={3}>
                <VStack gap={0}>
                  <Text type="body" style={CARD_TITLE_STYLE}>
                    {t("totalRequests")}
                  </Text>
                  <Text type="display-3" hasTabularNumbers>
                    {format.number(summary.totalRequests)}
                  </Text>
                </VStack>
                <Grid columns={{ minWidth: 80, max: 3 }} gap={2}>
                  {[
                    {
                      label: t("blockedRequests"),
                      value: format.number(summary.blockedRequests),
                      tone: summary.blockedRequests > 0 ? ("error" as const) : undefined,
                    },
                    { label: t("uniqueIps"), value: format.number(summary.uniqueIps) },
                    { label: t("blockRate"), value: `${summary.blockedPercent}%` },
                  ].map((stat) => (
                    <VStack key={stat.label} gap={0}>
                      <Text type="label" size="3xs" color="secondary">
                        {stat.label}
                      </Text>
                      <Text type="body" weight="semibold" hasTabularNumbers>
                        <span style={stat.tone ? { color: STAT_TONE_VAR[stat.tone] } : undefined}>
                          {stat.value}
                        </span>
                      </Text>
                    </VStack>
                  ))}
                </Grid>
                <Text type="body" size="sm" color="secondary">
                  {t("wafEventsCount", { count: format.number(wafStats?.total ?? 0) })}
                </Text>
              </VStack>
            </Card>
          </div>
          <Grid
            columns={{ minWidth: 150, max: 5 }}
            gap={3}
            data-testid="analytics-stats"
            className="cpm-desktop-only"
          >
            <StatCard label={t("totalRequests")} value={format.number(summary.totalRequests)} />
            <StatCard label={t("uniqueIps")} value={format.number(summary.uniqueIps)} />
            <StatCard
              label={t("blockedRequests")}
              value={format.number(summary.blockedRequests)}
              sub={
                (wafStats?.total ?? 0) > 0
                  ? t("blockedFromWaf", { count: format.number(wafStats!.total) })
                  : undefined
              }
              tone={summary.blockedRequests > 0 ? "error" : undefined}
            />
            <StatCard
              label={t("blockRate")}
              value={`${summary.blockedPercent}%`}
              sub={t("bytesServed", { bytes: formatBytes(format, summary.bytesServed) })}
              tone={summary.blockedPercent > 10 ? "warning" : undefined}
            />
            <StatCard
              label={t("wafEvents")}
              value={format.number(wafStats?.total ?? 0)}
              sub={
                wafStats && wafStats.topRules.length > 0
                  ? t("rulesTriggered", { count: wafStats.topRules.length })
                  : t("noWafEvents")
              }
              tone={(wafStats?.total ?? 0) > 0 ? "warning" : undefined}
            />
          </Grid>

          <Card padding={5}>
            <VStack gap={4}>
              <Text type="body" size="sm" weight="semibold">
                {t("requestsOverTime")}
              </Text>
              {timeline.length === 0 ? (
                <EmptyState title={t("periodEmptyTitle")} isCompact />
              ) : (
                <div style={{ overflowX: "auto", width: "100%" }}>
                  <ReactApexChart
                    type="area"
                    series={timelineSeries}
                    options={timelineOptions}
                    height={220}
                  />
                </div>
              )}
            </VStack>
          </Card>

          <Grid columns={{ minWidth: 320, max: 2 }} gap={3}>
            <Card padding={5}>
              {/* Full height, so the map grows to match the country table beside it. */}
              <VStack gap={2} minHeight={280} height="100%">
                <HStack gap={3} vAlign="center" justify="between" wrap="wrap">
                  <Text type="body" size="sm" weight="semibold">
                    {t("trafficByCountry")}
                  </Text>
                  {/* The ramp normalises per metric, so Blocked lights up the most-blocked. */}
                  <div className="cpm-desktop-only">
                    <SegmentedControl
                      label={t("mapMetric")}
                      size="sm"
                      value={mapMetric}
                      onChange={(value) => setMapMetric(value as MapMetric)}
                    >
                      {metricOptions.map((option) => (
                        <SegmentedControlItem
                          key={option.value}
                          value={option.value}
                          label={option.label}
                        />
                      ))}
                    </SegmentedControl>
                  </div>
                  <div className="cpm-mobile-flex">
                    <FilterChip
                      label={metricOptions.find((o) => o.value === mapMetric)?.label ?? mapMetric}
                      aria-label={t("mapMetric")}
                      onClick={() => setMetricSheetOpen(true)}
                    />
                  </div>
                  <OptionSheet
                    title={t("mapMetric")}
                    isOpen={metricSheetOpen}
                    onOpenChange={setMetricSheetOpen}
                    value={mapMetric}
                    options={metricOptions}
                    onChange={setMapMetric}
                  />
                </HStack>
                <WorldMap
                  data={countries}
                  selectedCountry={selectedCountry}
                  metric={mapMetric}
                  onSelectCountry={(code) =>
                    setSelectedCountry((current) =>
                      code === null || code === current ? null : code,
                    )
                  }
                />
              </VStack>
            </Card>
            <Card padding={4}>
              <VStack gap={3}>
                <Text type="body" size="sm" weight="semibold">
                  {t("topCountries")}
                </Text>
                {countries.length === 0 ? (
                  <EmptyState title={t("geoDataEmptyTitle")} isCompact />
                ) : (
                  <Table
                    density={density}
                    data={countryRows}
                    // Five fixed columns are wider than the card on a phone.
                    columns={
                      isNarrow
                        ? countryColumns.filter((c) => c.key !== "uniqueIps" && c.key !== "waf")
                        : countryColumns
                    }
                    idKey="countryCode"
                    hasHover
                    plugins={{ rowStatus: countryStatus }}
                  />
                )}
              </VStack>
            </Card>
          </Grid>

          {selectedCountry && (
            <CountryBreakdown
              code={selectedCountry}
              query={buildParams()}
              totalRequests={summary?.totalRequests ?? 0}
              onClose={() => setSelectedCountry(null)}
            />
          )}

          <Grid columns={{ minWidth: 320, max: 2 }} gap={3}>
            <Card padding={5}>
              <VStack gap={4}>
                <Text type="body" size="sm" weight="semibold">
                  {t("httpProtocols")}
                </Text>
                {protocols.length === 0 ? (
                  <EmptyState title={t("noData")} isCompact />
                ) : (
                  <>
                    <div style={{ overflowX: "auto", width: "100%" }}>
                      <ReactApexChart
                        type="donut"
                        series={donutSeries}
                        options={donutOptions}
                        height={220}
                      />
                    </div>
                    <Table
                      density={density}
                      data={protocolRows}
                      columns={protocolColumns}
                      idKey="proto"
                    />
                  </>
                )}
              </VStack>
            </Card>
            <Card padding={5}>
              <VStack gap={4}>
                <Text type="body" size="sm" weight="semibold">
                  {t("topUserAgents")}
                </Text>
                {userAgents.length === 0 ? (
                  <EmptyState title={t("noData")} isCompact />
                ) : (
                  <div style={{ overflowX: "auto", width: "100%" }}>
                    <ReactApexChart
                      type="bar"
                      series={barSeries}
                      options={barOptions}
                      height={260}
                    />
                  </div>
                )}
              </VStack>
            </Card>
          </Grid>

          <Card padding={5}>
            <VStack gap={4}>
              <Text type="body" size="sm" weight="semibold">
                {t("recentBlockedRequests")}
              </Text>
              {!blocked || blocked.events.length === 0 ? (
                <EmptyState title={t("blockedRequestsEmptyTitle")} isCompact />
              ) : (
                <>
                  <div className="cpm-desktop-only">
                    <Table
                      density={density}
                      data={blockedRows}
                      columns={blockedColumns}
                      idKey="id"
                      hasHover
                    />
                  </div>
                  <div className="cpm-mobile-only">
                    <List>
                      {blockedRows.map((row) => (
                        <ListItem
                          key={row.id}
                          label={row.clientIp}
                          description={`${row.method} ${row.uri}`}
                          endContent={
                            row.countryCode ? <Badge label={row.countryCode} /> : undefined
                          }
                        />
                      ))}
                    </List>
                  </div>
                  {blocked.pages > 1 && (
                    <HStack justify="center">
                      <Pagination
                        page={blocked.page}
                        pageSize={blocked.events.length || 1}
                        totalItems={blocked.total}
                        onChange={fetchBlockedPage}
                      />
                    </HStack>
                  )}
                </>
              )}
            </VStack>
          </Card>

          {wafStats && wafStats.total > 0 && (
            <Card padding={5}>
              <VStack gap={4}>
                <Text type="body" size="sm" weight="semibold">
                  {t("topWafRulesTriggered")}
                </Text>
                <div style={{ overflowX: "auto", width: "100%" }}>
                  <ReactApexChart
                    type="bar"
                    series={wafBarSeries}
                    options={wafBarOptions}
                    height={Math.max(120, wafStats.topRules.length * 32)}
                  />
                </div>
                <Table
                  density={density}
                  data={wafRuleRows}
                  columns={wafRuleColumns}
                  idKey="ruleId"
                />
              </VStack>
            </Card>
          )}
        </>
      )}
    </VStack>
  );
}
