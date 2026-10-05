"use client";

/** Served and 5xx answers per half hour, stacked, with the 5xx share as a line on its own axis. */

import dynamic from "next/dynamic";
import { useMemo } from "react";
import type { ApexOptions } from "apexcharts";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useTranslations } from "next-intl";
import { useAppFormatter } from "@/src/components/locale/use-app-formatter";
import { useChartTheme } from "@/src/app/(dashboard)/analytics/chart-theme";
import type { HostTrafficBucket } from "@/lib/clickhouse/host-traffic";

// Client only: v7's server entry is an async Server Component (see AnalyticsClient).
const ReactApexChart = dynamic(() => import("react-apexcharts"), { ssr: false });

export function HostTrafficChart({ timeline }: { timeline: readonly HostTrafficBucket[] }) {
  const t = useTranslations("proxyHosts.detail");
  const format = useAppFormatter();
  const theme = useChartTheme();

  const series = useMemo(
    () => [
      { name: t("chartServed"), type: "column", data: timeline.map((b) => b.served) },
      { name: t("serverErrors"), type: "column", data: timeline.map((b) => b.serverErrors) },
      {
        name: t("chartErrorShare"),
        type: "line",
        data: timeline.map((b) => (b.requests > 0 ? b.serverErrors / b.requests : 0)),
      },
    ],
    [timeline, t],
  );

  const options: ApexOptions = useMemo(
    () => ({
      ...theme.base,
      chart: { ...theme.base.chart, id: "host-traffic", stacked: true },
      colors: [theme.series.green, theme.series.red, theme.series.orange],
      stroke: { width: [0, 0, 2], curve: "smooth" },
      dataLabels: { enabled: false },
      plotOptions: { bar: { columnWidth: "80%" } },
      legend: {
        position: "bottom",
        horizontalAlign: "left",
        labels: { colors: theme.labelColor },
      },
      xaxis: {
        categories: timeline.map((b) =>
          format.dateTime(new Date(b.ts * 1000), { hour: "2-digit", minute: "2-digit" }),
        ),
        tickAmount: 8,
        labels: { rotate: 0, style: { colors: theme.labelColor, fontSize: "11px" } },
        axisBorder: { show: false },
        axisTicks: { show: false },
      },
      yaxis: [
        {
          seriesName: t("chartServed"),
          labels: {
            style: { colors: theme.labelColor },
            formatter: (value: number) => format.number(Math.round(value)),
          },
        },
        { seriesName: t("chartServed"), show: false },
        {
          seriesName: t("chartErrorShare"),
          opposite: true,
          min: 0,
          max: 1,
          tickAmount: 4,
          labels: {
            style: { colors: theme.labelColor },
            formatter: (value: number) =>
              format.number(value, { style: "percent", maximumFractionDigits: 0 }),
          },
        },
      ],
      tooltip: {
        theme: theme.mode,
        shared: true,
        intersect: false,
        y: {
          formatter: (value: number, opts?: { seriesIndex: number }) =>
            opts?.seriesIndex === 2
              ? format.number(value, { style: "percent", maximumFractionDigits: 1 })
              : format.number(Math.round(value)),
        },
      },
    }),
    [theme, timeline, format, t],
  );

  if (timeline.every((b) => b.requests === 0)) {
    return <EmptyState title={t("chartEmpty")} isCompact />;
  }
  return <ReactApexChart type="line" series={series} options={options} height={240} />;
}
