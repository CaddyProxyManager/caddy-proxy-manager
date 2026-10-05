"use client";

/**
 * The five headline numbers, each with its change from the previous period and a sparkline of the
 * window. Presentational, so the docs site runs it on sample data.
 */

import type { ComponentType } from "react";
import { useMemo } from "react";
import type { ApexOptions } from "apexcharts";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { useFormatter, useTranslations } from "next-intl";
import { ACCENTS, type Hue } from "@/components/ui/accent";
import { CARD_TITLE_STYLE } from "@/components/ui/card-title";
import type { ExploreBucket, ExploreTotals } from "@/src/lib/clickhouse/explore";
import { useChartTheme } from "../chart-theme";
import { formatBytes, formatShare } from "./format";

/** react-apexcharts, passed in: the page loads it browser-only, the docs site directly. */
export type ApexChartComponent = ComponentType<{
  type: "area" | "line" | "bar" | "donut";
  series: ApexOptions["series"];
  options: ApexOptions;
  height: number | string;
  width?: number | string;
}>;

type Kpi = {
  id: "requests" | "bytes" | "uniqueIps" | "mitigated" | "serverErrorRate";
  hue: Hue;
  value: number;
  previous: number | null;
  /** Whether a rise is bad news, which colours the delta. */
  riseIsBad: boolean;
  spark: number[];
};

function rate(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

export function kpisFor(
  totals: ExploreTotals,
  previous: ExploreTotals | null,
  timeline: readonly ExploreBucket[],
): Kpi[] {
  return [
    {
      id: "requests",
      hue: "blue",
      value: totals.requests,
      previous: previous?.requests ?? null,
      riseIsBad: false,
      spark: timeline.map((b) => b.requests),
    },
    {
      id: "bytes",
      hue: "teal",
      value: totals.bytes,
      previous: previous?.bytes ?? null,
      riseIsBad: false,
      spark: timeline.map((b) => b.bytes),
    },
    {
      id: "uniqueIps",
      hue: "purple",
      value: totals.uniqueIps,
      previous: previous?.uniqueIps ?? null,
      riseIsBad: false,
      spark: timeline.map((b) => b.uniqueIps),
    },
    {
      id: "mitigated",
      hue: "orange",
      value: totals.mitigated,
      previous: previous?.mitigated ?? null,
      riseIsBad: true,
      spark: timeline.map((b) => b.mitigated),
    },
    {
      id: "serverErrorRate",
      hue: "red",
      value: rate(totals.serverErrors, totals.requests),
      previous: previous ? rate(previous.serverErrors, previous.requests) : null,
      riseIsBad: true,
      spark: timeline.map((b) => rate(b.serverErrors, b.requests)),
    },
  ];
}

function Sparkline({
  data,
  color,
  Chart,
}: {
  data: number[];
  color: string;
  Chart: ApexChartComponent;
}) {
  const theme = useChartTheme();
  const options = useMemo<ApexOptions>(
    () => ({
      ...theme.base,
      chart: { ...theme.base.chart, type: "area", sparkline: { enabled: true } },
      colors: [color],
      stroke: { curve: "smooth", width: 2 },
      fill: { type: "gradient", gradient: { opacityFrom: 0.35, opacityTo: 0.02 } },
      tooltip: { enabled: false },
    }),
    [theme, color],
  );
  const series = useMemo(() => [{ name: "", data }], [data]);
  return <Chart type="area" series={series} options={options} height={36} />;
}

const SPARK_COLOR: Record<Hue, keyof ReturnType<typeof useChartTheme>["series"]> = {
  blue: "blue",
  teal: "cyan",
  purple: "purple",
  orange: "orange",
  red: "red",
  cyan: "cyan",
  gray: "blue",
  green: "green",
  pink: "red",
  yellow: "orange",
};

export function KpiTiles({
  totals,
  previousTotals,
  timeline,
  Chart,
}: {
  totals: ExploreTotals;
  previousTotals: ExploreTotals | null;
  timeline: readonly ExploreBucket[];
  Chart: ApexChartComponent;
}) {
  const t = useTranslations("analytics");
  const format = useFormatter();
  const theme = useChartTheme();
  const kpis = kpisFor(totals, previousTotals, timeline);

  const valueText = (kpi: Kpi) => {
    switch (kpi.id) {
      case "bytes":
        return formatBytes(format, kpi.value);
      case "serverErrorRate":
        return format.number(kpi.value, { style: "percent", maximumFractionDigits: 2 });
      default:
        return format.number(kpi.value);
    }
  };

  const sub = (kpi: Kpi) => {
    if (kpi.id === "mitigated") {
      return t("kpi.mitigatedShare", {
        share: formatShare(format, totals.mitigated, totals.requests),
      });
    }
    if (kpi.id === "serverErrorRate") {
      return t("kpi.serverErrorCount", { count: format.number(totals.serverErrors) });
    }
    if (kpi.id === "requests" && totals.avgDurationMs !== null) {
      return t("kpi.avgDuration", { ms: format.number(totals.avgDurationMs) });
    }
    return null;
  };

  const delta = (kpi: Kpi) => {
    if (kpi.previous === null) return null;
    if (kpi.previous === 0) {
      return kpi.value === 0 ? { text: t("kpi.unchanged"), color: "gray" as const } : null;
    }
    const change = (kpi.value - kpi.previous) / kpi.previous;
    if (Math.abs(change) < 0.0005) return { text: t("kpi.unchanged"), color: "gray" as const };
    const text = t("kpi.change", {
      change: format.number(change, {
        style: "percent",
        maximumFractionDigits: 1,
        signDisplay: "always",
      }),
    });
    const bad = change > 0 === kpi.riseIsBad;
    return { text, color: bad ? ("red" as const) : ("green" as const) };
  };

  return (
    <Grid columns={{ minWidth: 150, max: 5 }} gap={3} data-testid="analytics-stats">
      {kpis.map((kpi) => {
        const change = delta(kpi);
        const detail = sub(kpi);
        return (
          <Card key={kpi.id} padding={4} height="100%" className={ACCENTS[kpi.hue].edge}>
            <VStack gap={1}>
              <Text type="body" style={CARD_TITLE_STYLE}>
                {t(`kpi.${kpi.id}`)}
              </Text>
              <Text type="display-3" hasTabularNumbers className={ACCENTS[kpi.hue].text}>
                {valueText(kpi)}
              </Text>
              <HStack gap={2} wrap="wrap">
                {change && <Token label={change.text} color={change.color} size="sm" />}
                {detail && (
                  <Text type="body" size="sm" color="secondary">
                    {detail}
                  </Text>
                )}
              </HStack>
              {kpi.spark.length > 1 && (
                <Sparkline
                  data={kpi.spark}
                  color={theme.series[SPARK_COLOR[kpi.hue]]}
                  Chart={Chart}
                />
              )}
            </VStack>
          </Card>
        );
      })}
    </Grid>
  );
}
