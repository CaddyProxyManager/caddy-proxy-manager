"use client";

import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import dayjs from "dayjs";
import { toast } from "sonner";

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { DateTimeInput, type ISODateTimeString } from "@astryxdesign/core/DateTimeInput";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Link as AstryxLink } from "@astryxdesign/core/Link";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Switch } from "@astryxdesign/core/Switch";
import {
  Table,
  pixel,
  proportional,
  useTableRowStatus,
  type TableColumn,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Download, ListFilter, ListX } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useAppFormatter } from "@/src/components/locale/use-app-formatter";
import { useLive } from "@/src/lib/live/useLive";
import { Timestamp } from "@/components/ui/Timestamp";
import { AppDialog } from "@/components/ui/AppDialog";
import { useTableDensity } from "@/components/ui/TableDensity";
import { FilterChip } from "@/src/components/mobile/FilterChip";
import { OptionSheet } from "@/src/components/mobile/OptionSheet";
import { regionName } from "@/src/lib/locale/region-names";
import { ANALYTICS_STARTING } from "@/src/lib/analytics/starting";
import {
  ANALYTICS_RANGES,
  AUTO_REFRESH_MS,
  type AnalyticsFilter,
  type AnalyticsRange,
  type ExploreState,
  type FilterOp,
  MAX_CUSTOM_RANGE_SECONDS,
  type TopDimension,
  TOP_DIMENSION_FIELD,
  TOP_DIMENSIONS,
  autoRefreshes,
  parseExploreState,
  serializeExploreState,
  withFilter,
} from "@/src/lib/analytics/explore-state";
import type { AnalyticsReport } from "@/src/lib/analytics/explore";
import type { TopRow } from "@/src/lib/clickhouse/explore";

import { settingsHref } from "../settings/sections";
import { CountryBreakdown } from "./CountryBreakdown";
import type { MapMetric } from "./WorldMapInner";
import { FilterBar } from "./explore/FilterBar";
import { type ApexChartComponent, KpiTiles } from "./explore/KpiTiles";
import { RequestLog } from "./explore/RequestLog";
import { SavedViews } from "./explore/SavedViews";
import {
  TopListCard,
  TopListTable,
  topListCsv,
  topRowLabel,
  useTopRowLabel,
} from "./explore/TopList";
import { TrafficChart } from "./explore/TrafficChart";
import { TOP_TITLE_KEY } from "./explore/format";
import { FlagIcon } from "@/src/components/ui/CountryFlag";

// ── Dynamic imports (browser-only) ────────────────────────────────────────────

// ApexCharts v7 server-renders only via an async Server Component this client file cannot reach,
// and every dataset arrives in an effect anyway.
const ReactApexChart = dynamic(() => import("react-apexcharts"), {
  ssr: false,
}) as unknown as ApexChartComponent;

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

/** ClickHouse is not up yet after a restart: a wait, shown as a warning rather than an error. */
class AnalyticsStartingError extends Error {}

/** An answer that named its failure, so the banner can say it in the reader's language. */
class ApiCodedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const CODED_ERROR_KEYS = {
  NOT_FOUND: "requestNotFound",
  INTERNAL_ERROR: "requestServerError",
  ANALYTICS_UNKNOWN_DIMENSION: "requestUnknownDimension",
} as const;

/** An unchecked `{ error }` body lands in state, and the first `.map()` blanks the page. */
async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (body && typeof body === "object" && "code" in body && body.code === ANALYTICS_STARTING) {
      throw new AnalyticsStartingError();
    }
    const reported =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error).trim()
        : "";
    const code =
      body && typeof body === "object" && "code" in body && typeof body.code === "string"
        ? body.code
        : null;
    if (code && code in CODED_ERROR_KEYS) throw new ApiCodedError(code, reported);
    // ClickHouse errors often carry an empty message, which would leave the banner invisible.
    throw reported
      ? new Error(reported)
      : new UnexplainedStatusError(url.split("?")[0] ?? url, response.status);
  }
  return body;
}

/** Renders empty rather than throwing on an odd 200. */
function asReport(value: unknown): AnalyticsReport | null {
  if (!value || typeof value !== "object") return null;
  const report = value as Partial<AnalyticsReport>;
  if (!report.totals || !Array.isArray(report.timeline) || !report.top || !report.window) {
    return null;
  }
  return {
    ...(report as AnalyticsReport),
    groups: Array.isArray(report.groups) ? report.groups : [],
    countries: Array.isArray(report.countries) ? report.countries : [],
    requests: Array.isArray(report.requests) ? report.requests : [],
  };
}

function asRows(value: unknown): TopRow[] {
  return Array.isArray(value) ? (value as TopRow[]) : [];
}

// ── Custom range ──────────────────────────────────────────────────────────────

function toInput(epoch: number | null): ISODateTimeString | undefined {
  return epoch === null
    ? undefined
    : (dayjs.unix(epoch).format("YYYY-MM-DDTHH:mm") as ISODateTimeString);
}

function CustomRange({
  state,
  onChange,
}: {
  state: ExploreState;
  onChange: (from: number, to: number) => void;
}) {
  const t = useTranslations("analytics");
  const tCommon = useTranslations("common");
  const [from, setFrom] = useState(state.from);
  const [to, setTo] = useState(state.to);
  const tooLong = from !== null && to !== null && to - from > MAX_CUSTOM_RANGE_SECONDS;
  const backwards = from !== null && to !== null && from >= to;

  const commit = (nextFrom: number | null, nextTo: number | null) => {
    setFrom(nextFrom);
    setTo(nextTo);
    if (nextFrom === null || nextTo === null || nextFrom >= nextTo) return;
    if (nextTo - nextFrom > MAX_CUSTOM_RANGE_SECONDS) return;
    onChange(nextFrom, nextTo);
  };

  return (
    <VStack gap={1}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <DateTimeInput
          label={tCommon("rangeFrom")}
          isLabelHidden
          size="sm"
          width={200}
          value={toInput(from)}
          onChange={(next) => commit(next ? dayjs(next).unix() : null, to)}
        />
        <Text type="body" size="sm" color="secondary">
          -
        </Text>
        <DateTimeInput
          label={tCommon("rangeTo")}
          isLabelHidden
          size="sm"
          width={200}
          value={toInput(to)}
          onChange={(next) => commit(from, next ? dayjs(next).unix() : null)}
        />
      </HStack>
      {(tooLong || backwards) && (
        <Text type="body" size="sm" color="secondary" role="alert">
          {tooLong ? t("customRangeTooLong", { days: 92 }) : t("customRangeBackwards")}
        </Text>
      )}
    </VStack>
  );
}

// ── View all ──────────────────────────────────────────────────────────────────

function ViewAllDialog({
  dimension,
  query,
  total,
  onClose,
  onFilter,
}: {
  dimension: TopDimension;
  query: string;
  total: number;
  onClose: () => void;
  onFilter: (dimension: TopDimension, value: string, op: FilterOp) => void;
}) {
  const t = useTranslations("analytics");
  const tCommon = useTranslations("common");
  const label = useTopRowLabel(dimension);
  const [rows, setRows] = useState<TopRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams(query);
    params.set("dimension", dimension);
    fetchJson(`/api/analytics/top?${params.toString()}`, controller.signal)
      .then((body) => setRows(asRows(body)))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.warn("[analytics] could not load the full list:", error);
        setFailed(true);
      });
    return () => controller.abort();
  }, [dimension, query]);

  const title = t(`top.${TOP_TITLE_KEY[dimension]}`);
  return (
    <AppDialog
      open
      onClose={onClose}
      title={title}
      maxWidth="lg"
      actions={
        <HStack gap={2}>
          <Button
            variant="secondary"
            icon={<Download />}
            label={tCommon("download")}
            isDisabled={!rows || rows.length === 0}
            onClick={() => rows && topListCsv(t, dimension, rows, label)}
          />
          <Button variant="primary" label={tCommon("close")} onClick={onClose} />
        </HStack>
      }
    >
      {failed ? (
        <Banner status="error" title={t("viewAllLoadError")} />
      ) : rows === null ? (
        <HStack justify="center" padding={6}>
          <Spinner label={t("loadingAnalytics")} />
        </HStack>
      ) : rows.length === 0 ? (
        <EmptyState title={tCommon("noData")} isCompact />
      ) : (
        <TopListTable
          dimension={dimension}
          rows={rows}
          total={total}
          onFilter={(d, value, op) => {
            onClose();
            onFilter(d, value, op);
          }}
        />
      )}
    </AppDialog>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type DisplayRange = AnalyticsRange | "custom";

type CountryRow = TopRow & { [k: string]: unknown };

export default function AnalyticsClient() {
  const t = useTranslations("analytics");
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const format = useAppFormatter();
  const locale = useLocale();
  const density = useTableDensity();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isNarrow = useMediaQuery("(max-width: 767px)");

  // The URL is the state: parsed, then re-serialised, so an odd link settles to one spelling.
  const urlQuery = searchParams.toString();
  const state = useMemo(() => parseExploreState(new URLSearchParams(urlQuery)), [urlQuery]);
  const query = useMemo(() => serializeExploreState(state).toString(), [state]);

  const navigate = useCallback(
    (next: ExploreState | string) => {
      const nextQuery =
        typeof next === "string"
          ? serializeExploreState(parseExploreState(new URLSearchParams(next))).toString()
          : serializeExploreState(next).toString();
      // A filter or grouping changes the page in place; jumping to the top would lose the reader.
      router.push(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
    },
    [router, pathname],
  );

  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [hosts, setHosts] = useState<string[]>([]);
  const [viewAll, setViewAll] = useState<TopDimension | null>(null);
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null);
  const [mapMetric, setMapMetric] = useState<MapMetric>("total");
  const [rangeSheetOpen, setRangeSheetOpen] = useState(false);
  const shownQuery = useRef<string | null>(null);

  useEffect(() => {
    fetchJson("/api/analytics/hosts")
      .then((body) =>
        setHosts(
          Array.isArray(body)
            ? body
                .map((entry) => (entry as { host?: unknown }).host)
                .filter((host): host is string => typeof host === "string")
            : [],
        ),
      )
      .catch(() => setHosts([]));
  }, []);

  const load = useCallback(
    (signal: AbortSignal) => {
      // A refresh of the same view keeps the old numbers up rather than flashing a spinner.
      const quiet = shownQuery.current === query;
      if (!quiet) setLoading(true);
      fetchJson(`/api/analytics/explore${query ? `?${query}` : ""}`, signal)
        .then((body) => {
          setLoadError(null);
          setStarting(false);
          setReport(asReport(body));
          setLoadedAt(Date.now());
          shownQuery.current = query;
        })
        .catch((err: unknown) => {
          if (signal.aborted) return;
          // Reset to empty rather than leaving stale data next to a banner.
          setReport(null);
          if (err instanceof AnalyticsStartingError) {
            setStarting(true);
            setLoadError(null);
            return;
          }
          setStarting(false);
          setLoadError(
            err instanceof UnexplainedStatusError
              ? t("requestFailedWithStatus", { path: err.path, status: err.status })
              : err instanceof ApiCodedError
                ? t(CODED_ERROR_KEYS[err.code as keyof typeof CODED_ERROR_KEYS])
                : err instanceof Error && err.message
                  ? err.message
                  : t("loadErrorTitle"),
          );
          if (!quiet) toast.error(t("loadErrorTitle"));
        })
        .finally(() => {
          if (!signal.aborted) setLoading(false);
        });
    },
    [query, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const refreshes = autoRefreshes(state);
  // The server says when rows landed; the timer below only covers a stream that is down.
  const liveReload = useRef<AbortController | null>(null);
  const streaming = useLive(
    "analytics",
    () => {
      if (document.visibilityState !== "visible") return;
      liveReload.current?.abort();
      liveReload.current = new AbortController();
      load(liveReload.current.signal);
    },
    refreshes,
  );
  useEffect(() => () => liveReload.current?.abort(), []);

  useEffect(() => {
    if (!refreshes || streaming) return;
    let controller: AbortController | null = null;
    const timer = setInterval(() => {
      // A hidden tab skips its refreshes; the first one after it is shown again catches up.
      if (document.visibilityState !== "visible") return;
      controller?.abort();
      controller = new AbortController();
      load(controller.signal);
    }, AUTO_REFRESH_MS);
    return () => {
      clearInterval(timer);
      controller?.abort();
    };
  }, [refreshes, streaming, load]);

  const addFilter = useCallback(
    (dimension: TopDimension, value: string, op: FilterOp) => {
      navigate(withFilter(state, { field: TOP_DIMENSION_FIELD[dimension], op, value }));
    },
    [navigate, state],
  );

  const setFilters = (filters: AnalyticsFilter[]) => navigate({ ...state, filters });

  const changeRange = (range: DisplayRange) => {
    if (range === "custom") {
      const window = report?.window ?? {
        from: Math.floor(Date.now() / 1000) - 86400,
        to: Math.floor(Date.now() / 1000),
      };
      navigate({ ...state, range: "custom", from: window.from, to: window.to });
      return;
    }
    navigate({ ...state, range, from: null, to: null });
  };

  const exportTopList = useCallback(
    (dimension: TopDimension) => {
      const params = new URLSearchParams(query);
      params.set("dimension", dimension);
      fetchJson(`/api/analytics/top?${params.toString()}`)
        .then((body) => {
          topListCsv(t, dimension, asRows(body), (row) => topRowLabel(t, locale, dimension, row));
        })
        .catch(() => toast.error(t("viewAllLoadError")));
    },
    [query, t, locale],
  );

  const ranges: DisplayRange[] = [...ANALYTICS_RANGES, "custom"];
  const rangeLabel = (range: DisplayRange) => (range === "custom" ? t("intervalCustom") : range);
  const rangeSeconds = report ? report.window.to - report.window.from : 86400;

  const hostFilters = state.filters.filter((f) => f.field === "host" && f.op === "is");
  const breakdownQuery = report
    ? `?from=${report.window.from}&to=${report.window.to}${
        hostFilters.length > 0
          ? `&hosts=${hostFilters.map((f) => encodeURIComponent(f.value)).join(",")}`
          : ""
      }`
    : "?interval=24h";

  const metricOptions: { value: MapMetric; label: string }[] = [
    { value: "total", label: tCommon("requests") },
    { value: "blocked", label: t("metricMitigated") },
    { value: "uniqueIps", label: t("uniqueIps") },
  ];

  const countryRows: CountryRow[] = (report?.countries ?? [])
    .slice(0, 10)
    .map((row) => ({ ...row }));
  const countryStatus = useTableRowStatus<CountryRow>({
    getStatus: (row) =>
      row.key === selectedCountry ? { color: "accent", label: t("selected") } : null,
  });
  const countryColumns: TableColumn<CountryRow>[] = [
    {
      key: "key",
      header: t("country"),
      width: proportional(1),
      // A button, not a clickable row, so keyboard users can reach it.
      renderCell: (row) => (
        <Button
          variant="ghost"
          size="sm"
          label={
            row.key === selectedCountry
              ? t("closeCountryBreakdown", { code: row.key })
              : t("openCountryBreakdown", { code: row.key })
          }
          onClick={() => setSelectedCountry((cur) => (cur === row.key ? null : row.key))}
        >
          <HStack gap={2} vAlign="center">
            <FlagIcon code={row.key} />
            <Text type="inherit" size="sm" maxLines={1}>
              {row.key === "XX" ? t("unplacedCountry") : regionName(row.key, locale)}
            </Text>
          </HStack>
        </Button>
      ),
    },
    {
      key: "requests",
      header: tCommon("requests"),
      align: "end",
      width: pixel(100),
      renderCell: (row) => (
        <Text type="body" size="sm" hasTabularNumbers>
          {format.number(row.requests)}
        </Text>
      ),
    },
    {
      key: "mitigated",
      header: t("metricMitigated"),
      align: "end",
      width: pixel(100),
      renderCell: (row) => (
        <Text
          type="body"
          size="sm"
          color={row.mitigated > 0 ? "primary" : "secondary"}
          hasTabularNumbers
        >
          {format.number(row.mitigated)}
        </Text>
      ),
    },
    {
      key: "actions",
      header: <VisuallyHidden>{tCommon("actions")}</VisuallyHidden>,
      align: "end",
      width: pixel(76),
      renderCell: (row) => {
        const name = row.key === "XX" ? t("unplacedCountry") : regionName(row.key, locale);
        return (
          <HStack gap={1} justify="end">
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              icon={<ListFilter />}
              label={t("filterTo", { value: name })}
              tooltip={t("filterToShort")}
              onClick={() => addFilter("country", row.key, "is")}
            />
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              icon={<ListX />}
              label={t("filterOut", { value: name })}
              tooltip={t("filterOutShort")}
              onClick={() => addFilter("country", row.key, "not")}
            />
          </HStack>
        );
      },
    },
  ];

  const mapData = (report?.countries ?? []).map((row) => ({
    countryCode: row.key,
    total: row.requests,
    blocked: row.mitigated,
    uniqueIps: row.uniqueIps,
  }));

  return (
    <VStack gap={6}>
      <HStack justify="between" vAlign="center" gap={4} wrap="wrap">
        <VStack gap={0}>
          <Text type="label" size="sm" color="secondary" className="cpm-desktop-only">
            {t("trafficIntelligence")}
          </Text>
          <Heading level={1}>{tNav("analytics")}</Heading>
        </VStack>
        <HStack gap={3} vAlign="center" wrap="wrap">
          <div className="cpm-desktop-only">
            <SegmentedControl
              label={t("timeInterval")}
              size="sm"
              value={state.range}
              onChange={(next) => changeRange(next as DisplayRange)}
            >
              {ranges.map((range) => (
                <SegmentedControlItem key={range} value={range} label={rangeLabel(range)} />
              ))}
            </SegmentedControl>
          </div>
          {/* Five segments do not fit a phone: the range is a pill that opens a sheet. */}
          <FilterChip
            className="cpm-mobile-flex"
            label={rangeLabel(state.range)}
            aria-label={t("timeInterval")}
            onClick={() => setRangeSheetOpen(true)}
          />
          <OptionSheet
            title={t("timeInterval")}
            isOpen={rangeSheetOpen}
            onOpenChange={setRangeSheetOpen}
            value={state.range}
            options={ranges.map((range) => ({ value: range, label: rangeLabel(range) }))}
            onChange={changeRange}
          />
          {state.range === "custom" && (
            <CustomRange
              // Keyed, so a view opened from the menu replaces what was being typed.
              key={`${state.from}-${state.to}`}
              state={state}
              onChange={(from, to) => navigate({ ...state, range: "custom", from, to })}
            />
          )}
          <Switch
            size="sm"
            label={t("compare")}
            value={state.compare}
            onChange={(compare) => navigate({ ...state, compare })}
          />
          <SavedViews query={query} onOpen={(next) => navigate(next)} />
        </HStack>
      </HStack>

      <FilterBar filters={state.filters} onChange={setFilters} suggestions={{ host: hosts }} />

      <HStack gap={2} vAlign="center" wrap="wrap">
        {report && (
          <Text type="body" size="sm" color="secondary">
            {t.rich("windowSummary", {
              from: () => <Timestamp value={report.window.from * 1000} />,
              to: () => <Timestamp value={report.window.to * 1000} />,
            })}
          </Text>
        )}
        {refreshes && loadedAt !== null && (
          <Text type="body" size="sm" color="secondary">
            {streaming ? t("liveUpdating") : t("autoRefreshing")}
          </Text>
        )}
      </HStack>

      {starting && (
        <div data-testid="analytics-starting">
          <Banner
            status="warning"
            title={t("startingTitle")}
            description={t("startingDescription")}
          />
        </div>
      )}

      {loadError && (
        <div data-testid="analytics-load-error">
          <Banner status="error" title={t("loadErrorTitle")} description={loadError} />
        </div>
      )}

      {report?.analyticsDisabled && (
        <Banner
          status="info"
          title={t("analyticsDisabledTitle")}
          description={
            <Text type="body" size="sm">
              {t.rich("analyticsDisabledDescription", {
                link: (chunks) => (
                  <AstryxLink href={settingsHref("analytics")}>{chunks}</AstryxLink>
                ),
              })}
            </Text>
          }
        />
      )}

      {report?.loggingDisabled && !report.analyticsDisabled && (
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

      {loading && !report && (
        <HStack justify="center" padding={10}>
          <Spinner size="lg" label={t("loadingAnalytics")} />
        </HStack>
      )}

      {report && (
        <>
          <KpiTiles
            totals={report.totals}
            previousTotals={report.previousTotals}
            timeline={report.timeline}
            Chart={ReactApexChart}
          />

          <TrafficChart
            timeline={report.timeline}
            previousTimeline={report.previousTimeline}
            groups={report.groups}
            group={state.group}
            onGroupChange={(group) => navigate({ ...state, group })}
            rangeSeconds={rangeSeconds}
            Chart={ReactApexChart}
          />

          <Grid columns={{ minWidth: 320, max: 2 }} gap={3}>
            <Card padding={5}>
              {/* Full height, so the map grows to match the country table beside it. */}
              <VStack gap={2} minHeight={280} height="100%">
                <HStack gap={3} vAlign="center" justify="between" wrap="wrap">
                  <Text as="h2" type="body" size="sm" weight="semibold">
                    {t("trafficByCountry")}
                  </Text>
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
                </HStack>
                <WorldMap
                  data={mapData}
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
            <Card padding={4} data-testid="analytics-top-country">
              <VStack gap={3}>
                <HStack justify="between" vAlign="center" gap={2}>
                  <Text as="h2" type="body" size="sm" weight="semibold">
                    {t("topCountries")}
                  </Text>
                  <HStack gap={1} vAlign="center">
                    <Button
                      variant="ghost"
                      size="sm"
                      isIconOnly
                      icon={<Download />}
                      label={t("csv.exportList", { list: t("top.countries") })}
                      tooltip={t("csv.exportListShort")}
                      isDisabled={countryRows.length === 0}
                      onClick={() => exportTopList("country")}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      label={t("viewAll")}
                      isDisabled={countryRows.length === 0}
                      onClick={() => setViewAll("country")}
                    />
                  </HStack>
                </HStack>
                {countryRows.length === 0 ? (
                  <EmptyState title={t("geoDataEmptyTitle")} isCompact />
                ) : (
                  <Table
                    density={density}
                    data={countryRows}
                    columns={
                      isNarrow
                        ? countryColumns.filter((c) => c.key !== "mitigated")
                        : countryColumns
                    }
                    idKey="key"
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
              query={breakdownQuery}
              totalRequests={report.totals.requests}
              onClose={() => setSelectedCountry(null)}
            />
          )}

          <Grid columns={{ minWidth: 340, max: 2 }} gap={3}>
            {TOP_DIMENSIONS.filter((dimension) => dimension !== "country").map((dimension) => (
              <TopListCard
                key={dimension}
                dimension={dimension}
                rows={report.top[dimension] ?? []}
                total={report.totals.requests}
                onFilter={addFilter}
                onViewAll={setViewAll}
                onExport={exportTopList}
              />
            ))}
          </Grid>

          <RequestLog
            requests={report.requests}
            mitigatedOnly={state.mitigatedOnly}
            onMitigatedOnlyChange={(mitigatedOnly) => navigate({ ...state, mitigatedOnly })}
          />
        </>
      )}

      {viewAll && (
        <ViewAllDialog
          dimension={viewAll}
          query={query}
          total={report?.totals.requests ?? 0}
          onClose={() => setViewAll(null)}
          onFilter={addFilter}
        />
      )}
    </VStack>
  );
}
