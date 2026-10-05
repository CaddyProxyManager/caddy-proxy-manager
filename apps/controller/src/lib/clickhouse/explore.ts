/**
 * The analytics page's queries: every one takes the page's filters, so tiles, chart, lists and log
 * always describe the same requests. Written in the ClickHouse SQL ./sqlite-store.ts translates.
 */

import type { TrafficOutcome } from "@cpm/shared";
import {
  type AnalyticsFilter,
  type FilterField,
  type GroupBy,
  MAX_HOST_SERIES,
  OTHER_SERIES_KEY,
  type TimeWindow,
  type TopDimension,
} from "../analytics/explore-state";
import { type QueryParams, queryRow, queryRows, safeUint, timeFilter, timeParams } from "./client";

/** The path without its query string. ClickHouse's own path() wants a scheme. */
export const PATH_SQL =
  "if(position(uri, '?') > 0, substring(uri, 1, position(uri, '?') - 1), uri)";

const MITIGATED_SQL = "outcome != 'served'";

type Clause = { sql: string; params: QueryParams };

/** One field's comparison, `is` form; `not` wraps it. Null for a field the table cannot answer. */
export function trafficCondition(field: FilterField, value: string, key: string): Clause | null {
  const p = (type: string) => `{${key}:${type}}`;
  switch (field) {
    case "host":
      // The column is the Host header, so the same site also appears with its port.
      return {
        sql: `(host = ${p("String")} OR startsWith(host, concat(${p("String")}, ':')))`,
        params: { [key]: value },
      };
    case "path":
      return { sql: `${PATH_SQL} = ${p("String")}`, params: { [key]: value } };
    case "country":
      return { sql: `ifNull(country_code, 'XX') = ${p("String")}`, params: { [key]: value } };
    case "asn":
      return { sql: `asn = ${p("UInt32")}`, params: { [key]: Number(value) } };
    case "status":
      return value.endsWith("xx")
        ? { sql: `intDiv(status, 100) = ${p("UInt16")}`, params: { [key]: Number(value[0]) } }
        : { sql: `status = ${p("UInt16")}`, params: { [key]: Number(value) } };
    case "method":
      return { sql: `method = ${p("String")}`, params: { [key]: value } };
    case "proto":
      return { sql: `proto = ${p("String")}`, params: { [key]: value } };
    case "ip":
      return { sql: `client_ip = ${p("String")}`, params: { [key]: value } };
    case "ua":
      return { sql: `ua_family = ${p("String")}`, params: { [key]: value } };
    case "outcome":
      return { sql: `outcome = ${p("String")}`, params: { [key]: value } };
    case "rule":
      // The access log does not know the rule, so a request is one the rule matched by its client
      // and URI in the same window.
      return {
        sql: `(client_ip, uri) IN (SELECT client_ip, uri FROM waf_events WHERE ${timeFilter()} AND rule_id = ${p("Int32")})`,
        params: { [key]: Number(value) },
      };
  }
}

/** WAF events have no status, protocol, ASN, user agent or outcome; those filters pass. */
export function wafCondition(field: FilterField, value: string, key: string): Clause | null {
  const p = (type: string) => `{${key}:${type}}`;
  switch (field) {
    case "host":
    case "path":
    case "country":
    case "method":
    case "ip":
      return trafficCondition(field, value, key);
    case "rule":
      return { sql: `rule_id = ${p("Int32")}`, params: { [key]: Number(value) } };
    default:
      return null;
  }
}

export function buildWhere(
  window: TimeWindow,
  filters: readonly AnalyticsFilter[],
  condition: typeof trafficCondition,
  extra: string[] = [],
): Clause {
  const clauses = [timeFilter(), ...extra];
  let params: QueryParams = timeParams(window.from, window.to);
  filters.forEach((filter, index) => {
    const built = condition(filter.field, filter.value, `f_${index}`);
    if (!built) return;
    clauses.push(filter.op === "not" ? `NOT (${built.sql})` : built.sql);
    params = { ...params, ...built.params };
  });
  return { sql: clauses.join(" AND "), params };
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// ── Totals ─────────────────────────────────────────────────────────────────

export type ExploreTotals = {
  requests: number;
  bytes: number;
  uniqueIps: number;
  mitigated: number;
  serverErrors: number;
  /** Null when no row carried a duration: an older agent, or no requests. */
  avgDurationMs: number | null;
};

export async function queryExploreTotals(
  window: TimeWindow,
  filters: readonly AnalyticsFilter[],
): Promise<ExploreTotals> {
  const where = buildWhere(window, filters, trafficCondition);
  const row = await queryRow<Record<string, unknown>>(
    `
    SELECT
      count() AS requests,
      sum(bytes_sent) AS bytes,
      uniq(client_ip) AS unique_ips,
      countIf(${MITIGATED_SQL}) AS mitigated,
      countIf(status >= 500) AS server_errors,
      avg(duration_ms) AS avg_duration
    FROM traffic_events
    WHERE ${where.sql}
  `,
    where.params,
  );
  const duration = row?.avg_duration;
  return {
    requests: num(row?.requests),
    bytes: num(row?.bytes),
    uniqueIps: num(row?.unique_ips),
    mitigated: num(row?.mitigated),
    serverErrors: num(row?.server_errors),
    avgDurationMs:
      duration === null || duration === undefined || !Number.isFinite(Number(duration))
        ? null
        : Math.round(Number(duration)),
  };
}

// ── Timeline ───────────────────────────────────────────────────────────────

export type ExploreBucket = {
  ts: number;
  requests: number;
  bytes: number;
  uniqueIps: number;
  mitigated: number;
  serverErrors: number;
};

/** Every bucket of the window, empty ones included, so two windows line up by index. */
export function bucketStarts(window: TimeWindow, bucketSeconds: number): number[] {
  const starts: number[] = [];
  const first = Math.floor(window.from / bucketSeconds) * bucketSeconds;
  for (let ts = first; ts < window.to; ts += bucketSeconds) starts.push(ts);
  return starts;
}

export async function queryExploreTimeline(
  window: TimeWindow,
  filters: readonly AnalyticsFilter[],
  bucketSeconds: number,
): Promise<ExploreBucket[]> {
  const where = buildWhere(window, filters, trafficCondition);
  const rows = await queryRows<Record<string, unknown>>(
    `
    SELECT
      intDiv(toUInt32(ts), {p_bucket:UInt32}) AS bucket,
      count() AS requests,
      sum(bytes_sent) AS bytes,
      uniq(client_ip) AS unique_ips,
      countIf(${MITIGATED_SQL}) AS mitigated,
      countIf(status >= 500) AS server_errors
    FROM traffic_events
    WHERE ${where.sql}
    GROUP BY bucket
  `,
    { ...where.params, p_bucket: safeUint(bucketSeconds) },
  );
  const byStart = new Map(rows.map((row) => [Math.floor(num(row.bucket)) * bucketSeconds, row]));
  return bucketStarts(window, bucketSeconds).map((ts) => {
    const row = byStart.get(ts);
    return {
      ts,
      requests: num(row?.requests),
      bytes: num(row?.bytes),
      uniqueIps: num(row?.unique_ips),
      mitigated: num(row?.mitigated),
      serverErrors: num(row?.server_errors),
    };
  });
}

export type ExploreSeries = { key: string; counts: number[] };

const GROUP_SQL: Record<Exclude<GroupBy, "none">, string> = {
  outcome: "outcome",
  status: "intDiv(status, 100)",
  host: "host",
};

/** Requests per bucket and group, aligned with `bucketStarts`. Status groups are `2xx` and so on. */
export async function queryExploreGroups(
  window: TimeWindow,
  filters: readonly AnalyticsFilter[],
  bucketSeconds: number,
  group: Exclude<GroupBy, "none">,
): Promise<ExploreSeries[]> {
  const where = buildWhere(window, filters, trafficCondition);
  const rows = await queryRows<Record<string, unknown>>(
    `
    SELECT
      intDiv(toUInt32(ts), {p_bucket:UInt32}) AS bucket,
      ${GROUP_SQL[group]} AS group_key,
      count() AS requests
    FROM traffic_events
    WHERE ${where.sql}
    GROUP BY bucket, group_key
  `,
    { ...where.params, p_bucket: safeUint(bucketSeconds) },
  );
  const starts = bucketStarts(window, bucketSeconds);
  const index = new Map(starts.map((ts, i) => [ts, i]));
  const keyOf = (raw: unknown) =>
    group === "status" ? `${Math.floor(num(raw))}xx` : String(raw ?? "");

  const totals = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row.group_key);
    totals.set(key, (totals.get(key) ?? 0) + num(row.requests));
  }
  let keys = [...totals.keys()].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  const folded = new Set<string>();
  if (group === "host" && keys.length > MAX_HOST_SERIES) {
    for (const key of keys.slice(MAX_HOST_SERIES - 1)) folded.add(key);
    keys = [...keys.slice(0, MAX_HOST_SERIES - 1), OTHER_SERIES_KEY];
  }
  if (group === "status") keys.sort();

  const series = new Map(keys.map((key) => [key, starts.map(() => 0)]));
  for (const row of rows) {
    const raw = keyOf(row.group_key);
    const key = folded.has(raw) ? OTHER_SERIES_KEY : raw;
    const at = index.get(Math.floor(num(row.bucket)) * bucketSeconds);
    const counts = series.get(key);
    if (at === undefined || !counts) continue;
    counts[at] = (counts[at] ?? 0) + num(row.requests);
  }
  return keys.map((key) => ({ key, counts: series.get(key) ?? [] }));
}

// ── Top lists ──────────────────────────────────────────────────────────────

export type TopRow = {
  /** The value a filter on this row uses. */
  key: string;
  /** What to show beside it, where the key alone says little: an ASN's name, a rule's message. */
  label: string | null;
  requests: number;
  mitigated: number;
  serverErrors: number;
  bytes: number;
  uniqueIps: number;
};

/** Enough for every country there is, for the map. */
export const TOP_MAX_LIMIT = 300;

const TOP_SQL: Record<Exclude<TopDimension, "rule">, string> = {
  host: "host",
  path: PATH_SQL,
  country: "ifNull(country_code, 'XX')",
  asn: "asn",
  status: "status",
  ip: "client_ip",
  ua: "ua_family",
  method: "method",
  proto: "proto",
};

export async function queryExploreTop(
  window: TimeWindow,
  filters: readonly AnalyticsFilter[],
  dimension: TopDimension,
  limit: number,
): Promise<TopRow[]> {
  const safeLimit = Math.min(Math.max(1, safeUint(limit)), TOP_MAX_LIMIT);
  if (dimension === "rule") {
    const where = buildWhere(window, filters, wafCondition, ["rule_id IS NOT NULL"]);
    const rows = await queryRows<Record<string, unknown>>(
      `
      SELECT rule_id AS top_key, any(rule_message) AS label, count() AS requests,
             countIf(blocked) AS mitigated, uniq(client_ip) AS unique_ips
      FROM waf_events
      WHERE ${where.sql}
      GROUP BY top_key
      ORDER BY requests DESC
      LIMIT {p_limit:UInt32}
    `,
      { ...where.params, p_limit: safeLimit },
    );
    return rows.map((row) => ({
      key: String(row.top_key),
      label: typeof row.label === "string" ? row.label : null,
      requests: num(row.requests),
      mitigated: num(row.mitigated),
      serverErrors: 0,
      bytes: 0,
      uniqueIps: num(row.unique_ips),
    }));
  }

  // ASN 0 is "no ASN known", not a network worth ranking.
  const extra = dimension === "asn" ? ["asn != 0"] : [];
  const where = buildWhere(window, filters, trafficCondition, extra);
  const label = dimension === "asn" ? "any(asn_org)" : "''";
  const rows = await queryRows<Record<string, unknown>>(
    `
    SELECT
      ${TOP_SQL[dimension]} AS top_key,
      ${label} AS label,
      count() AS requests,
      countIf(${MITIGATED_SQL}) AS mitigated,
      countIf(status >= 500) AS server_errors,
      sum(bytes_sent) AS bytes,
      uniq(client_ip) AS unique_ips
    FROM traffic_events
    WHERE ${where.sql}
    GROUP BY top_key
    ORDER BY requests DESC
    LIMIT {p_limit:UInt32}
  `,
    { ...where.params, p_limit: safeLimit },
  );
  return rows.map((row) => ({
    key: String(row.top_key ?? ""),
    label: typeof row.label === "string" && row.label ? row.label : null,
    requests: num(row.requests),
    mitigated: num(row.mitigated),
    serverErrors: num(row.server_errors),
    bytes: num(row.bytes),
    uniqueIps: num(row.unique_ips),
  }));
}

// ── Latest requests ────────────────────────────────────────────────────────

export type ExploreRequest = {
  ts: number;
  clientIp: string;
  countryCode: string | null;
  asn: number | null;
  asnOrg: string | null;
  host: string;
  method: string;
  uri: string;
  status: number;
  proto: string;
  bytesSent: number;
  durationMs: number | null;
  outcome: TrafficOutcome;
  userAgent: string;
};

export const REQUEST_LOG_LIMIT = 50;

export async function queryExploreRequests(
  window: TimeWindow,
  filters: readonly AnalyticsFilter[],
  mitigatedOnly: boolean,
  limit = REQUEST_LOG_LIMIT,
): Promise<ExploreRequest[]> {
  const where = buildWhere(window, filters, trafficCondition, mitigatedOnly ? [MITIGATED_SQL] : []);
  const rows = await queryRows<Record<string, unknown>>(
    `
    SELECT toUInt32(ts) AS ts, client_ip, country_code, asn, asn_org, host, method, uri, status,
           proto, bytes_sent, duration_ms, outcome, user_agent
    FROM traffic_events
    WHERE ${where.sql}
    ORDER BY ts DESC
    LIMIT {p_limit:UInt32}
  `,
    { ...where.params, p_limit: Math.min(Math.max(1, safeUint(limit)), 200) },
  );
  return rows.map((row) => ({
    ts: num(row.ts),
    clientIp: String(row.client_ip ?? ""),
    countryCode: typeof row.country_code === "string" ? row.country_code : null,
    asn: num(row.asn) > 0 ? num(row.asn) : null,
    asnOrg: typeof row.asn_org === "string" && row.asn_org ? row.asn_org : null,
    host: String(row.host ?? ""),
    method: String(row.method ?? ""),
    uri: String(row.uri ?? ""),
    status: num(row.status),
    proto: String(row.proto ?? ""),
    bytesSent: num(row.bytes_sent),
    durationMs:
      row.duration_ms === null || row.duration_ms === undefined ? null : num(row.duration_ms),
    outcome: String(row.outcome ?? "served") as TrafficOutcome,
    userAgent: String(row.user_agent ?? ""),
  }));
}
