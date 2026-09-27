import { useMemo, useState } from "react";
import ReactApexChart from "react-apexcharts";
import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useChartTheme } from "@cpm/controller/src/app/(dashboard)/analytics/chart-theme";
import {
  CountryBreakdownView,
  type CountryBreakdownData,
} from "@cpm/controller/src/app/(dashboard)/analytics/CountryBreakdown";
import { FilterChip } from "@cpm/controller/src/components/mobile/FilterChip";
import { OptionSheet } from "@cpm/controller/src/components/mobile/OptionSheet";
import { useFormatter, useTranslations } from "next-intl";
import { DemoSurface } from "../DemoSurface";

type Range = "24h" | "7d" | "30d";

const RANGES: Range[] = ["24h", "7d", "30d"];

/** Shaped like real traffic: a working-hours curve, a quiet night, a flat trickle of blocks. */
const SERIES: Record<Range, { labels: string[]; ok: number[]; blocked: number[] }> = {
  "24h": {
    labels: ["00", "03", "06", "09", "12", "15", "18", "21"],
    ok: [180, 120, 340, 1420, 1680, 1510, 990, 420],
    blocked: [4, 2, 11, 18, 9, 7, 26, 12],
  },
  "7d": {
    labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    ok: [8600, 9100, 8800, 9400, 7900, 2600, 2100],
    blocked: [61, 74, 58, 92, 66, 21, 18],
  },
  "30d": {
    labels: ["W1", "W2", "W3", "W4"],
    ok: [48200, 51900, 47400, 53100],
    blocked: [380, 412, 355, 447],
  },
};

const PROTOCOLS = [
  { label: "HTTP/2", value: 62 },
  { label: "HTTP/3", value: 29 },
  { label: "HTTP/1.1", value: 9 },
];

type Metric = "requests" | "blocked" | "uniqueIps";

const COUNTRIES = [
  { code: "GB", name: "United Kingdom", requests: 21400, blocked: 38, uniqueIps: 612 },
  { code: "DE", name: "Germany", requests: 12800, blocked: 22, uniqueIps: 419 },
  { code: "US", name: "United States", requests: 9600, blocked: 141, uniqueIps: 388 },
  { code: "NL", name: "Netherlands", requests: 4100, blocked: 9, uniqueIps: 97 },
  { code: "SG", name: "Singapore", requests: 1900, blocked: 204, uniqueIps: 41 },
];

const TOTAL_REQUESTS = COUNTRIES.reduce((sum, c) => sum + c.requests, 0);

/** Derived from the country's totals, each part summing to them, like /api/analytics/country. */
function breakdownFor(country: (typeof COUNTRIES)[number]): CountryBreakdownData {
  const r = country.requests;
  const part = (share: number) => Math.round(r * share);
  return {
    countryCode: country.code,
    total: r,
    blocked: country.blocked,
    uniqueIps: country.uniqueIps,
    hosts: [
      { host: "app.example.com", count: part(0.58) },
      { host: "grafana.example.com", count: part(0.27) },
      { host: "cloud.example.com", count: r - part(0.58) - part(0.27) },
    ],
    statusClasses: {
      ok: part(0.87),
      redirects: part(0.06),
      clientErrors: part(0.06),
      serverErrors: r - part(0.87) - part(0.06) - part(0.06),
    },
    userAgents: [
      { userAgent: "Chrome 141", count: part(0.49) },
      { userAgent: "Safari 19", count: part(0.26) },
      { userAgent: "curl/8.9", count: part(0.07) },
    ],
  };
}

const USER_AGENTS = [
  { name: "Chrome 141", requests: 18200 },
  { name: "Safari 19", requests: 9700 },
  { name: "Firefox 146", requests: 5100 },
  { name: "curl/8.9", requests: 2400 },
  { name: "Unknown scanner", requests: 890 },
];

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <VStack gap={3}>
        <Text type="label" size="xsm" weight="semibold" color="secondary">
          {title}
        </Text>
        {children}
      </VStack>
    </Card>
  );
}

function Bar({
  label,
  value,
  max,
  badge,
}: {
  label: string;
  value: number;
  max: number;
  badge?: string;
}) {
  const format = useFormatter();
  return (
    <VStack gap={1}>
      <HStack justify="between" vAlign="center" gap={2}>
        <HStack gap={2} vAlign="center">
          {badge && <Badge label={badge} />}
          <Text type="body" size="sm">
            {label}
          </Text>
        </HStack>
        <Text type="code" size="xsm" color="secondary">
          {format.number(value)}
        </Text>
      </HStack>
      <div
        style={{
          height: 6,
          borderRadius: "var(--radius-full)",
          background: "var(--color-background-muted)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${Math.round((value / max) * 100)}%`,
            background: "var(--color-data-categorical-blue)",
          }}
        />
      </div>
    </VStack>
  );
}

function AnalyticsDemoContent() {
  const t = useTranslations("analytics");
  const [range, setRange] = useState<Range>("7d");
  const [metric, setMetric] = useState<Metric>("requests");
  const [selected, setSelected] = useState<string | null>(null);
  // Phone-only, as on the page: both choices open as sheets instead of segments.
  const [rangeSheetOpen, setRangeSheetOpen] = useState(false);
  const [metricSheetOpen, setMetricSheetOpen] = useState(false);
  const theme = useChartTheme();
  const metricOptions: { value: Metric; label: string }[] = [
    { value: "requests", label: t("metricRequests") },
    { value: "blocked", label: t("metricBlocked") },
    { value: "uniqueIps", label: t("uniqueIps") },
  ];
  const data = SERIES[range];

  const options = useMemo(
    () => ({
      ...theme.base,
      chart: { ...theme.base.chart, type: "area" as const, stacked: false },
      colors: [theme.series.blue, theme.series.red],
      dataLabels: { enabled: false },
      stroke: { curve: "smooth" as const, width: 2 },
      fill: { type: "gradient", gradient: { opacityFrom: 0.35, opacityTo: 0.02 } },
      xaxis: { categories: data.labels, labels: { style: { colors: theme.labelColor } } },
      yaxis: { labels: { style: { colors: theme.labelColor } } },
      legend: { labels: { colors: theme.labelColor } },
    }),
    [theme, data.labels],
  );

  // Like the map's switch: one ranking, re-sorted by the chosen count.
  const ranked = [...COUNTRIES].sort((a, b) => b[metric] - a[metric]);
  const maxCountry = Math.max(...COUNTRIES.map((c) => c[metric]));
  const selectedCountry = COUNTRIES.find((c) => c.code === selected) ?? null;
  const maxAgent = Math.max(...USER_AGENTS.map((a) => a.requests));

  return (
    <VStack gap={4}>
      <div className="cpm-desktop-only">
        <SegmentedControl
          label={t("timeInterval")}
          size="sm"
          value={range}
          onChange={(next) => setRange(next as Range)}
        >
          {RANGES.map((option) => (
            <SegmentedControlItem key={option} value={option} label={option} />
          ))}
        </SegmentedControl>
      </div>
      {/* The segments do not fit a phone: the interval is a pill that opens a sheet. */}
      <div className="cpm-chip-row cpm-mobile-flex">
        <FilterChip
          label={range}
          aria-label={t("timeInterval")}
          onClick={() => setRangeSheetOpen(true)}
        />
      </div>
      <OptionSheet
        title={t("timeInterval")}
        isOpen={rangeSheetOpen}
        onOpenChange={setRangeSheetOpen}
        value={range}
        options={RANGES.map((option) => ({ value: option, label: option }))}
        onChange={setRange}
      />

      <Panel title="Requests">
        <ReactApexChart
          type="area"
          height={220}
          options={options}
          series={[
            { name: "Served", data: data.ok },
            { name: "Blocked", data: data.blocked },
          ]}
        />
      </Panel>

      <Grid columns={{ minWidth: 240, max: 2 }} gap={3}>
        <Panel title="Protocols">
          <VStack gap={3}>
            {PROTOCOLS.map((protocol) => (
              <Bar key={protocol.label} label={protocol.label} value={protocol.value} max={100} />
            ))}
          </VStack>
        </Panel>

        <Panel title="Top countries">
          <VStack gap={3}>
            <div className="cpm-desktop-only">
              <SegmentedControl
                label={t("mapMetric")}
                size="sm"
                value={metric}
                onChange={(next) => setMetric(next as Metric)}
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
                label={metricOptions.find((option) => option.value === metric)?.label ?? metric}
                aria-label={t("mapMetric")}
                onClick={() => setMetricSheetOpen(true)}
              />
            </div>
            <OptionSheet
              title={t("mapMetric")}
              isOpen={metricSheetOpen}
              onOpenChange={setMetricSheetOpen}
              value={metric}
              options={metricOptions}
              onChange={setMetric}
            />
            {ranked.map((country) => (
              <button
                key={country.code}
                type="button"
                aria-pressed={country.code === selected}
                aria-label={
                  country.code === selected
                    ? t("closeCountryBreakdown", { code: country.code })
                    : t("openCountryBreakdown", { code: country.code })
                }
                onClick={() => setSelected((cur) => (cur === country.code ? null : country.code))}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  display: "block",
                  borderRadius: "var(--radius-inner)",
                  padding: "4px 6px",
                  margin: "-4px -6px",
                  background:
                    country.code === selected ? "var(--color-accent-muted)" : "transparent",
                }}
              >
                <Bar
                  badge={country.code}
                  label={country.name}
                  value={country[metric]}
                  max={maxCountry}
                />
              </button>
            ))}
          </VStack>
        </Panel>
      </Grid>

      {selectedCountry && (
        <CountryBreakdownView
          code={selectedCountry.code}
          data={breakdownFor(selectedCountry)}
          totalRequests={TOTAL_REQUESTS}
          onClose={() => setSelected(null)}
        />
      )}

      <Panel title="Top user agents">
        <VStack gap={3}>
          {USER_AGENTS.map((agent) => (
            <Bar key={agent.name} label={agent.name} value={agent.requests} max={maxAgent} />
          ))}
        </VStack>
      </Panel>
    </VStack>
  );
}

/** Content goes inside DemoSurface, which provides the catalog useTranslations reads. */
export default function AnalyticsDemo() {
  return (
    <DemoSurface>
      <AnalyticsDemoContent />
    </DemoSurface>
  );
}
