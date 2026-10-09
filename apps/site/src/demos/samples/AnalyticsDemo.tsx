import { useMemo, useState } from "react";
import ReactApexChart from "react-apexcharts";
import { Grid } from "@astryxdesign/core/Grid";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { useTranslations } from "next-intl";
import {
  type AnalyticsFilter,
  type FilterOp,
  type GroupBy,
  TOP_DIMENSION_FIELD,
  type TopDimension,
  withFilter,
  DEFAULT_EXPLORE_STATE,
} from "@cpm/controller/src/lib/analytics/explore-state";
import type {
  ExploreBucket,
  ExploreRequest,
  ExploreSeries,
  ExploreTotals,
  TopRow,
} from "@cpm/controller/src/lib/clickhouse/explore";
import { FilterBar } from "@cpm/controller/src/app/(dashboard)/analytics/explore/FilterBar";
import {
  type ApexChartComponent,
  KpiTiles,
} from "@cpm/controller/src/app/(dashboard)/analytics/explore/KpiTiles";
import { RequestLog } from "@cpm/controller/src/app/(dashboard)/analytics/explore/RequestLog";
import { TopListCard } from "@cpm/controller/src/app/(dashboard)/analytics/explore/TopList";
import { TrafficChart } from "@cpm/controller/src/app/(dashboard)/analytics/explore/TrafficChart";
import { DemoSurface } from "../DemoSurface";

const Chart = ReactApexChart as unknown as ApexChartComponent;

type TrafficOutcome = ExploreRequest["outcome"];

/** Invented, but shaped: a working-day curve, a scanner that keeps coming back, a slow upstream. */
type Sample = {
  bucket: number;
  host: string;
  path: string;
  country: string;
  asn: number;
  asnOrg: string;
  status: number;
  method: string;
  proto: string;
  ip: string;
  ua: string;
  outcome: TrafficOutcome;
  rule: number | null;
  bytes: number;
  durationMs: number;
};

const BUCKETS = 24;
const HOUR = 3600;
/** A fixed "now", so the server render and the browser's agree. */
const END = 1_790_000_000 - (1_790_000_000 % HOUR);

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function samples(seed: number, scale: number): Sample[] {
  const next = random(seed);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(next() * list.length)] as T;
  const rows: Sample[] = [];
  for (let bucket = 0; bucket < BUCKETS; bucket++) {
    const busy = 0.2 + 0.8 * Math.max(0, Math.sin(((bucket - 5) / 24) * Math.PI * 2) * 0.5 + 0.5);
    const count = Math.round(40 * busy * scale);
    for (let i = 0; i < count; i++) {
      const r = next();
      const outcome: TrafficOutcome =
        r > 0.985 ? "rate_limit" : r > 0.975 ? "auth" : r > 0.965 ? "geo" : "served";
      rows.push({
        bucket,
        host: pick([
          "app.example.com",
          "app.example.com",
          "grafana.example.com",
          "cloud.example.com",
        ]),
        path: pick(["/", "/", "/login", "/api/items", "/assets/app.js", "/media/stream"]),
        country: pick(["GB", "GB", "DE", "US", "NL", "FR"]),
        asn: 64500,
        asnOrg: "Example Broadband",
        status:
          outcome === "rate_limit"
            ? 429
            : outcome === "auth"
              ? 401
              : outcome === "geo"
                ? 403
                : next() > 0.97
                  ? 502
                  : next() > 0.92
                    ? 404
                    : 200,
        method: next() > 0.85 ? "POST" : "GET",
        proto: next() > 0.3 ? "HTTP/2.0" : "HTTP/3.0",
        // A third over IPv6, so the request log is seen with the widest addresses.
        ip:
          next() > 0.66
            ? `2001:db8:${Math.floor(next() * 0xffff).toString(16)}::${Math.floor(next() * 60) + 1}`
            : `198.51.100.${Math.floor(next() * 60) + 1}`,
        ua: pick(["Chrome", "Chrome", "Safari", "Firefox", "curl"]),
        outcome,
        rule: null,
        bytes: Math.floor(next() * 90_000) + 400,
        durationMs: next() > 0.95 ? Math.floor(next() * 3000) + 500 : Math.floor(next() * 80) + 4,
      });
    }
    // A scanner, mostly turned away by the WAF.
    for (let i = 0; i < Math.round(4 * scale); i++) {
      rows.push({
        bucket,
        host: "app.example.com",
        path: pick(["/.env", "/wp-login.php", "/admin/config.php"]),
        country: "CN",
        asn: 64510,
        asnOrg: "Example Hosting",
        status: 403,
        method: "GET",
        proto: "HTTP/1.1",
        ip: "203.0.113.66",
        ua: "Other",
        outcome: "waf",
        rule: pick([930130, 913100]),
        bytes: 0,
        durationMs: 2,
      });
    }
  }
  return rows;
}

const CURRENT = samples(7, 1);
const PREVIOUS = samples(11, 0.85);

function matches(row: Sample, filter: AnalyticsFilter): boolean {
  const value = filter.value;
  const hit = (() => {
    switch (filter.field) {
      case "host":
        return row.host === value;
      case "path":
        return row.path === value;
      case "country":
        return row.country === value;
      case "asn":
        return String(row.asn) === value;
      case "status":
        return value.endsWith("xx")
          ? String(row.status)[0] === value[0]
          : String(row.status) === value;
      case "method":
        return row.method === value;
      case "proto":
        return row.proto === value;
      case "ip":
        return row.ip === value;
      case "ua":
        return row.ua === value;
      case "outcome":
        return row.outcome === value;
      case "rule":
        return String(row.rule) === value;
    }
  })();
  return filter.op === "is" ? hit : !hit;
}

function totalsOf(rows: Sample[]): ExploreTotals {
  return {
    requests: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    uniqueIps: new Set(rows.map((row) => row.ip)).size,
    mitigated: rows.filter((row) => row.outcome !== "served").length,
    serverErrors: rows.filter((row) => row.status >= 500).length,
    avgDurationMs: rows.length
      ? Math.round(rows.reduce((sum, row) => sum + row.durationMs, 0) / rows.length)
      : null,
  };
}

function timelineOf(rows: Sample[]): ExploreBucket[] {
  return Array.from({ length: BUCKETS }, (_, bucket) => {
    const inBucket = rows.filter((row) => row.bucket === bucket);
    const totals = totalsOf(inBucket);
    return {
      ts: END - (BUCKETS - bucket) * HOUR,
      requests: totals.requests,
      bytes: totals.bytes,
      uniqueIps: totals.uniqueIps,
      mitigated: totals.mitigated,
      serverErrors: totals.serverErrors,
    };
  });
}

function groupsOf(rows: Sample[], group: GroupBy): ExploreSeries[] {
  if (group === "none") return [];
  const keyOf = (row: Sample) =>
    group === "outcome"
      ? row.outcome
      : group === "status"
        ? `${String(row.status)[0]}xx`
        : row.host;
  const keys = [...new Set(rows.map(keyOf))].sort();
  return keys.map((key) => ({
    key,
    counts: Array.from(
      { length: BUCKETS },
      (_, bucket) => rows.filter((row) => row.bucket === bucket && keyOf(row) === key).length,
    ),
  }));
}

const KEY_OF: Partial<Record<TopDimension, (row: Sample) => string>> = {
  host: (row) => row.host,
  path: (row) => row.path,
  status: (row) => String(row.status),
  ua: (row) => row.ua,
  rule: (row) => (row.rule === null ? "" : String(row.rule)),
};

const RULE_MESSAGES: Record<string, string> = {
  "930130": "Restricted File Access Attempt",
  "913100": "Found User-Agent associated with security scanner",
};

function topOf(rows: Sample[], dimension: TopDimension): TopRow[] {
  const keyOf = KEY_OF[dimension];
  if (!keyOf) return [];
  const byKey = new Map<string, Sample[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  return [...byKey.entries()]
    .map(([key, group]) => ({
      key,
      label: dimension === "rule" ? (RULE_MESSAGES[key] ?? null) : null,
      ...totalsOf(group),
    }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 6);
}

function requestsOf(rows: Sample[], mitigatedOnly: boolean): ExploreRequest[] {
  return rows
    .filter((row) => !mitigatedOnly || row.outcome !== "served")
    .slice(-8)
    .reverse()
    .map((row, index) => ({
      ts: END - (BUCKETS - row.bucket) * HOUR + index * 7,
      clientIp: row.ip,
      countryCode: row.country,
      asn: row.asn,
      asnOrg: row.asnOrg,
      host: row.host,
      method: row.method,
      uri: row.path,
      status: row.status,
      proto: row.proto,
      bytesSent: row.bytes,
      durationMs: row.durationMs,
      outcome: row.outcome,
      userAgent: row.ua,
    }));
}

const LISTS: TopDimension[] = ["host", "path", "status", "rule"];

function AnalyticsDemoContent() {
  const t = useTranslations("analytics");
  const [filters, setFilters] = useState<AnalyticsFilter[]>([]);
  const [group, setGroup] = useState<GroupBy>("outcome");
  const [compare, setCompare] = useState(true);
  const [mitigatedOnly, setMitigatedOnly] = useState(false);

  const current = useMemo(
    () => CURRENT.filter((row) => filters.every((filter) => matches(row, filter))),
    [filters],
  );
  const previous = useMemo(
    () => PREVIOUS.filter((row) => filters.every((filter) => matches(row, filter))),
    [filters],
  );
  const timeline = useMemo(() => timelineOf(current), [current]);
  const previousTimeline = useMemo(() => timelineOf(previous), [previous]);

  const addFilter = (dimension: TopDimension, value: string, op: FilterOp) => {
    setFilters(
      withFilter(
        { ...DEFAULT_EXPLORE_STATE, filters },
        { field: TOP_DIMENSION_FIELD[dimension], op, value },
      ).filters,
    );
  };

  return (
    <VStack gap={4}>
      <HStack gap={3} vAlign="center" wrap="wrap">
        <SegmentedControl label={t("timeInterval")} size="sm" value="24h" onChange={() => {}}>
          <SegmentedControlItem value="24h" label="24h" />
        </SegmentedControl>
        <Switch size="sm" label={t("compare")} value={compare} onChange={setCompare} />
      </HStack>
      <FilterBar filters={filters} onChange={setFilters} />
      <KpiTiles
        totals={totalsOf(current)}
        previousTotals={compare ? totalsOf(previous) : null}
        timeline={timeline}
        Chart={Chart}
      />
      <TrafficChart
        timeline={timeline}
        previousTimeline={compare ? previousTimeline : null}
        groups={groupsOf(current, group)}
        group={group}
        onGroupChange={setGroup}
        rangeSeconds={86400}
        Chart={Chart}
      />
      <Grid columns={{ minWidth: 300, max: 2 }} gap={3}>
        {LISTS.map((dimension) => (
          <TopListCard
            key={dimension}
            dimension={dimension}
            rows={topOf(current, dimension)}
            total={current.length}
            onFilter={addFilter}
          />
        ))}
      </Grid>
      <RequestLog
        requests={requestsOf(current, mitigatedOnly)}
        mitigatedOnly={mitigatedOnly}
        onMitigatedOnlyChange={setMitigatedOnly}
      />
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
