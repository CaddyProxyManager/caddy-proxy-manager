"use client";

/**
 * Requests over the window, optionally split by outcome, status class or host, with the previous
 * period drawn behind as a dashed line. Presentational.
 */

import { useCallback, useMemo } from "react";
import type { ApexOptions } from "apexcharts";
import type { TrafficOutcome } from "@cpm/shared";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Download } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { GROUP_BYS, type GroupBy, OTHER_SERIES_KEY } from "@/src/lib/analytics/explore-state";
import type { ExploreBucket, ExploreSeries } from "@/src/lib/clickhouse/explore";
import { toSafeChartLabel } from "@/src/lib/analytics/chart-labels";
import { type ChartTheme, useChartTheme } from "../chart-theme";
import { csvFileName, downloadCsv, toCsv } from "./csv";
import { formatBucket, OUTCOME_KEY } from "./format";
import type { ApexChartComponent } from "./KpiTiles";

type SeriesColor = keyof ChartTheme["series"];

const OUTCOME_COLOR: Record<TrafficOutcome, SeriesColor> = {
  served: "green",
  waf: "red",
  geo: "orange",
  access: "teal",
  auth: "purple",
  rate_limit: "cyan",
  crowdsec: "pink",
  blocked: "brown",
};

const STATUS_COLOR: Record<string, SeriesColor> = {
  "1xx": "indigo",
  "2xx": "green",
  "3xx": "blue",
  "4xx": "orange",
  "5xx": "red",
};

const HOST_COLORS: SeriesColor[] = ["blue", "purple", "teal", "orange", "pink", "brown"];

const GROUP_KEY = {
  none: "groupNone",
  outcome: "groupOutcome",
  status: "groupStatus",
  host: "groupHost",
} as const satisfies Record<GroupBy, string>;

export function TrafficChart({
  timeline,
  previousTimeline,
  groups,
  group,
  onGroupChange,
  rangeSeconds,
  Chart,
}: {
  timeline: readonly ExploreBucket[];
  previousTimeline: readonly ExploreBucket[] | null;
  groups: readonly ExploreSeries[];
  group: GroupBy;
  onGroupChange: (group: GroupBy) => void;
  rangeSeconds: number;
  Chart: ApexChartComponent;
}) {
  const t = useTranslations("analytics");
  const format = useFormatter();
  const theme = useChartTheme();

  const describe = useCallback(
    (key: string, index: number) => {
      if (key === OTHER_SERIES_KEY) {
        return { label: t("otherHosts"), color: theme.labelColor };
      }
      if (group === "outcome") {
        const outcome = key as TrafficOutcome;
        return {
          label: outcome in OUTCOME_KEY ? t(`outcomes.${OUTCOME_KEY[outcome]}`) : key,
          color: theme.series[OUTCOME_COLOR[outcome] ?? "blue"],
        };
      }
      return {
        label: toSafeChartLabel(key || t("unknownValue")),
        color:
          group === "status"
            ? theme.series[STATUS_COLOR[key] ?? "blue"]
            : theme.series[HOST_COLORS[index % HOST_COLORS.length] ?? "blue"],
      };
    },
    [t, theme, group],
  );

  const grouped = group !== "none" && groups.length > 0;
  const ghost = previousTimeline && previousTimeline.length > 0 ? previousTimeline : null;

  const series = useMemo(() => {
    const out: { name: string; type: "area" | "bar" | "line"; data: number[] }[] = grouped
      ? groups.map((g, i) => ({ name: describe(g.key, i).label, type: "bar", data: g.counts }))
      : [{ name: t("seriesRequests"), type: "area", data: timeline.map((b) => b.requests) }];
    if (ghost) {
      out.push({
        name: t("seriesPrevious"),
        type: "line",
        data: timeline.map((_, i) => ghost[i]?.requests ?? 0),
      });
    }
    return out;
  }, [grouped, groups, timeline, ghost, t, describe]);

  const options = useMemo<ApexOptions>(() => {
    const colors = grouped ? groups.map((g, i) => describe(g.key, i).color) : [theme.series.blue];
    if (ghost) colors.push(theme.labelColor);
    return {
      ...theme.base,
      chart: { ...theme.base.chart, stacked: grouped, id: "analytics-timeline" },
      colors,
      fill: grouped
        ? { opacity: 1 }
        : { type: ["gradient", "solid"], gradient: { opacityFrom: 0.4, opacityTo: 0.05 } },
      stroke: {
        curve: "smooth",
        width: series.map((s) => (s.type === "bar" ? 0 : 2)),
        dashArray: series.map((s) => (s.type === "line" ? 5 : 0)),
      },
      plotOptions: { bar: { columnWidth: "70%" } },
      dataLabels: { enabled: false },
      xaxis: {
        categories: timeline.map((b) => formatBucket(format, b.ts, rangeSeconds)),
        labels: { rotate: 0, hideOverlappingLabels: true, style: { colors: theme.labelColor } },
        axisBorder: { show: false },
        axisTicks: { show: false },
      },
      yaxis: { labels: { style: { colors: theme.labelColor } } },
      legend: { labels: { colors: theme.labelColor } },
      tooltip: { theme: theme.mode, shared: true, intersect: false },
    };
  }, [theme, timeline, groups, grouped, ghost, series, rangeSeconds, format, describe]);

  const exportCsv = () => {
    const header = [t("csv.bucketStart"), ...series.map((s) => s.name)];
    const rows = timeline.map((bucket, i) => [
      new Date(bucket.ts * 1000).toISOString(),
      ...series.map((s) => s.data[i] ?? 0),
    ]);
    downloadCsv(csvFileName("analytics", "timeline", group), toCsv(header, rows));
  };

  return (
    <Card padding={5}>
      <VStack gap={4}>
        <HStack justify="between" vAlign="center" gap={3} wrap="wrap">
          <Text as="h2" type="body" size="sm" weight="semibold">
            {t("requestsOverTime")}
          </Text>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <SegmentedControl
              label={t("groupBy")}
              size="sm"
              value={group}
              onChange={(next) => onGroupChange(next as GroupBy)}
            >
              {GROUP_BYS.map((option) => (
                <SegmentedControlItem key={option} value={option} label={t(GROUP_KEY[option])} />
              ))}
            </SegmentedControl>
            <Button
              variant="ghost"
              size="sm"
              icon={<Download />}
              label={t("csv.exportChart")}
              isIconOnly
              tooltip={t("csv.exportChart")}
              onClick={exportCsv}
              isDisabled={timeline.length === 0}
            />
          </HStack>
        </HStack>
        {timeline.length === 0 ? (
          <EmptyState title={t("periodEmptyTitle")} isCompact />
        ) : (
          <Chart type={grouped ? "bar" : "area"} series={series} options={options} height={260} />
        )}
      </VStack>
    </Card>
  );
}
