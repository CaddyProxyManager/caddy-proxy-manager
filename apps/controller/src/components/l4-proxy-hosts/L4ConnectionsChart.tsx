"use client";

/** Connections per half hour, as the proxy host page charts its requests. */

import dynamic from "next/dynamic";
import { useMemo } from "react";
import type { ApexOptions } from "apexcharts";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useTranslations } from "next-intl";
import { useAppFormatter } from "@/src/components/locale/use-app-formatter";
import { useChartTheme } from "@/src/app/(dashboard)/analytics/chart-theme";
import type { L4TrafficBucket } from "@/lib/clickhouse/l4-traffic";

// Client only: v7's server entry is an async Server Component (see AnalyticsClient).
const ReactApexChart = dynamic(() => import("react-apexcharts"), { ssr: false });

export function L4ConnectionsChart({ timeline }: { timeline: readonly L4TrafficBucket[] }) {
  const t = useTranslations("l4ProxyHosts.detail");
  const format = useAppFormatter();
  const theme = useChartTheme();

  const series = useMemo(
    () => [{ name: t("chartConnections"), data: timeline.map((b) => b.connections) }],
    [timeline, t],
  );

  const options: ApexOptions = useMemo(
    () => ({
      ...theme.base,
      chart: { ...theme.base.chart, id: "l4-connections" },
      colors: [theme.series.blue],
      dataLabels: { enabled: false },
      plotOptions: { bar: { columnWidth: "80%" } },
      legend: { show: false },
      xaxis: {
        categories: timeline.map((b) =>
          format.dateTime(new Date(b.ts * 1000), { hour: "2-digit", minute: "2-digit" }),
        ),
        tickAmount: 8,
        labels: { rotate: 0, style: { colors: theme.labelColor, fontSize: "11px" } },
        axisBorder: { show: false },
        axisTicks: { show: false },
      },
      yaxis: {
        labels: {
          style: { colors: theme.labelColor },
          formatter: (value: number) => format.number(Math.round(value)),
        },
      },
      tooltip: {
        theme: theme.mode,
        y: { formatter: (value: number) => format.number(Math.round(value)) },
      },
    }),
    [theme, timeline, format],
  );

  if (timeline.every((b) => b.connections === 0)) {
    return <EmptyState title={t("chartEmpty")} isCompact />;
  }
  return <ReactApexChart type="bar" series={series} options={options} height={240} />;
}
