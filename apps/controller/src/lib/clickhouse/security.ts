/**
 * The security page's queries beyond the analytics page's own. Written in the ClickHouse SQL
 * ./sqlite-store.ts translates, and filtered the way ./explore.ts filters.
 */

import type { AnalyticsFilter, TimeWindow } from "../analytics/explore-state";
import {
  type QueryParams,
  type StoredWafEventRow,
  type WafEvent,
  queryRow,
  queryRows,
  safeUint,
  timeFilter,
  timeParams,
  toWafEvent,
} from "./client";
import { bucketStarts, buildWhere, trafficCondition, wafCondition } from "./explore";

const MITIGATED = "outcome != 'served'";

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

const WAF_EVENT_COLUMNS = `toUInt32(ts) AS ts, host, client_ip, country_code, method, uri,
  rule_id, rule_message, severity, raw_data, blocked`;

/** Every event stored at one second, which an event key names, with the agent that relayed it. */
export async function queryWafEventsAt(ts: number): Promise<(WafEvent & { relayedBy: string })[]> {
  const rows = await queryRows<StoredWafEventRow & { agent_id?: string | null }>(
    `SELECT ${WAF_EVENT_COLUMNS}, agent_id FROM waf_events WHERE ${timeFilter()} LIMIT 500`,
    timeParams(ts, ts),
  );
  return rows.map((row, index) => ({
    ...toWafEvent(row, index + 1),
    relayedBy: row.agent_id ?? "",
  }));
}

/**
 * The user agent of the request a WAF event blocked. The WAF record has none; the access log
 * keeps one per request, so it is matched on the second either side, address and host, then on
 * the path (the WAF's copy of the query string is redacted, the log's is not). Null when that
 * request was not logged (access logging off, or relayed late).
 */
export async function queryUserAgentOfWafEvent(event: {
  ts: number;
  clientIp: string;
  host: string;
  uri: string;
}): Promise<string | null> {
  const rows = await queryRows<{ ts: unknown; uri: string; user_agent: string }>(
    `SELECT toUInt32(ts) AS ts, uri, user_agent FROM traffic_events
     WHERE ${timeFilter()} AND client_ip = {p_ip:String} AND host IN ({p_host:String}, {p_bare:String})
       AND user_agent != '' LIMIT 50`,
    {
      ...timeParams(event.ts - 2, event.ts + 2),
      p_ip: event.clientIp,
      p_host: event.host,
      // The WAF names the host as the request did, port and all; the access log may not.
      p_bare: event.host.replace(/:\d+$/, ""),
    },
  );
  const path = (uri: string) => uri.split("?")[0];
  const nearest = (candidates: typeof rows) =>
    candidates.sort((a, b) => Math.abs(num(a.ts) - event.ts) - Math.abs(num(b.ts) - event.ts))[0];
  const match =
    nearest(rows.filter((row) => row.uri === event.uri)) ??
    nearest(rows.filter((row) => path(row.uri) === path(event.uri)));
  return match?.user_agent || null;
}

export async function queryWafEventPage(
  window: TimeWindow,
  filters: readonly AnalyticsFilter[],
  limit: number,
  offset: number,
): Promise<{ items: WafEvent[]; total: number }> {
  const where = buildWhere(window, filters, wafCondition);
  const [rows, count] = await Promise.all([
    queryRows<StoredWafEventRow>(
      `SELECT ${WAF_EVENT_COLUMNS} FROM waf_events WHERE ${where.sql}
       ORDER BY ts DESC LIMIT {p_limit:UInt32} OFFSET {p_offset:UInt32}`,
      { ...where.params, p_limit: safeUint(limit), p_offset: safeUint(offset) },
    ),
    queryRow<{ total: unknown }>(
      `SELECT count() AS total FROM waf_events WHERE ${where.sql}`,
      where.params,
    ),
  ]);
  return {
    items: rows.map((row, index) => toWafEvent(row, safeUint(offset) + index + 1)),
    total: num(count?.total),
  };
}

export type OutcomeCount = { outcome: string; count: number };

/** Mitigated requests per outcome. */
export async function queryMitigatedByOutcome(
  window: TimeWindow,
  filters: readonly AnalyticsFilter[],
): Promise<OutcomeCount[]> {
  const where = buildWhere(window, filters, trafficCondition, [MITIGATED]);
  const rows = await queryRows<Record<string, unknown>>(
    `SELECT outcome, count() AS requests FROM traffic_events WHERE ${where.sql}
     GROUP BY outcome ORDER BY requests DESC`,
    where.params,
  );
  return rows.map((row) => ({ outcome: String(row.outcome ?? ""), count: num(row.requests) }));
}

export type OutcomeComparison = { current: OutcomeCount[]; previous: OutcomeCount[] };

function byCount(rows: OutcomeCount[]): OutcomeCount[] {
  return rows
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || (a.outcome < b.outcome ? -1 : 1));
}

/**
 * Two windows' mitigated outcomes in one scan. A `rule` filter matches WAF events in the queried
 * window, so with one the windows stay two queries, or a span would match across both.
 */
export async function queryMitigatedByOutcomeCompared(
  window: TimeWindow,
  previous: TimeWindow,
  filters: readonly AnalyticsFilter[],
): Promise<OutcomeComparison> {
  if (filters.some((filter) => filter.field === "rule")) {
    const [current, before] = await Promise.all([
      queryMitigatedByOutcome(window, filters),
      queryMitigatedByOutcome(previous, filters),
    ]);
    return { current: byCount(current), previous: byCount(before) };
  }
  const span = { from: Math.min(window.from, previous.from), to: Math.max(window.to, previous.to) };
  const where = buildWhere(span, filters, trafficCondition, [MITIGATED]);
  const within = (prefix: string) =>
    `ts >= toDateTime({${prefix}_from:UInt32}) AND ts <= toDateTime({${prefix}_to:UInt32})`;
  const rows = await queryRows<Record<string, unknown>>(
    `SELECT outcome, countIf(${within("w")}) AS current, countIf(${within("pw")}) AS previous
     FROM traffic_events WHERE ${where.sql} GROUP BY outcome`,
    {
      ...where.params,
      w_from: safeUint(window.from),
      w_to: safeUint(window.to),
      pw_from: safeUint(previous.from),
      pw_to: safeUint(previous.to),
    },
  );
  const pick = (column: string) =>
    byCount(rows.map((row) => ({ outcome: String(row.outcome ?? ""), count: num(row[column]) })));
  return { current: pick("current"), previous: pick("previous") };
}

export type WafTotals = { events: number; blocked: number; sources: number };

export async function queryWafTotals(
  window: TimeWindow,
  filters: readonly AnalyticsFilter[],
): Promise<WafTotals> {
  const where = buildWhere(window, filters, wafCondition);
  const row = await queryRow<Record<string, unknown>>(
    `SELECT count() AS events, countIf(blocked) AS blocked, uniq(client_ip) AS sources
     FROM waf_events WHERE ${where.sql}`,
    where.params,
  );
  return { events: num(row?.events), blocked: num(row?.blocked), sources: num(row?.sources) };
}

/** WAF events per bucket, aligned with `bucketStarts`: the chart when outcomes are not known. */
export async function queryWafTimeline(
  window: TimeWindow,
  filters: readonly AnalyticsFilter[],
  bucketSeconds: number,
): Promise<{ blocked: number[]; detected: number[] }> {
  const where = buildWhere(window, filters, wafCondition);
  const rows = await queryRows<Record<string, unknown>>(
    `SELECT intDiv(toUInt32(ts), {p_bucket:UInt32}) AS bucket, countIf(blocked) AS blocked,
            count() AS events
     FROM waf_events WHERE ${where.sql} GROUP BY bucket`,
    { ...where.params, p_bucket: safeUint(bucketSeconds) },
  );
  const byStart = new Map(rows.map((row) => [Math.floor(num(row.bucket)) * bucketSeconds, row]));
  const starts = bucketStarts(window, bucketSeconds);
  return {
    blocked: starts.map((ts) => num(byStart.get(ts)?.blocked)),
    detected: starts.map((ts) => num(byStart.get(ts)?.events) - num(byStart.get(ts)?.blocked)),
  };
}

export type SecuritySource = {
  ip: string;
  countryCode: string | null;
  asn: number | null;
  asnOrg: string | null;
  requests: number;
  lastSeen: number;
  /** The WAF rules this address set off, most often first. */
  rules: number[];
};

async function rulesBySource(
  window: TimeWindow,
  ips: readonly string[],
): Promise<Map<string, number[]>> {
  if (ips.length === 0) return new Map();
  const params: QueryParams = timeParams(window.from, window.to);
  const placeholders = ips.map((ip, index) => {
    params[`ip_${index}`] = ip;
    return `{ip_${index}:String}`;
  });
  const rows = await queryRows<Record<string, unknown>>(
    `SELECT client_ip, rule_id, count() AS hits FROM waf_events
     WHERE ${timeFilter()} AND rule_id IS NOT NULL AND client_ip IN (${placeholders.join(",")})
     GROUP BY client_ip, rule_id ORDER BY hits DESC`,
    params,
  );
  const out = new Map<string, number[]>();
  for (const row of rows) {
    const ip = String(row.client_ip ?? "");
    const list = out.get(ip) ?? [];
    if (list.length < 5) list.push(num(row.rule_id));
    out.set(ip, list);
  }
  return out;
}

/** The addresses most often stopped, from the access log's outcomes. */
export async function queryTopMitigatedSources(
  window: TimeWindow,
  filters: readonly AnalyticsFilter[],
  limit: number,
): Promise<SecuritySource[]> {
  const where = buildWhere(window, filters, trafficCondition, [MITIGATED]);
  const rows = await queryRows<Record<string, unknown>>(
    `SELECT client_ip, any(country_code) AS country_code, any(asn) AS asn,
            any(asn_org) AS asn_org, count() AS requests, max(toUInt32(ts)) AS last_seen
     FROM traffic_events WHERE ${where.sql}
     GROUP BY client_ip ORDER BY requests DESC LIMIT {p_limit:UInt32}`,
    { ...where.params, p_limit: safeUint(limit) },
  );
  const rules = await rulesBySource(
    window,
    rows.map((row) => String(row.client_ip ?? "")),
  );
  return rows.map((row) => {
    const ip = String(row.client_ip ?? "");
    return {
      ip,
      countryCode: typeof row.country_code === "string" ? row.country_code : null,
      asn: num(row.asn) > 0 ? num(row.asn) : null,
      asnOrg: typeof row.asn_org === "string" && row.asn_org ? row.asn_org : null,
      requests: num(row.requests),
      lastSeen: num(row.last_seen),
      rules: rules.get(ip) ?? [],
    };
  });
}

/** The same from WAF events alone, which know no network. */
export async function queryTopWafSources(
  window: TimeWindow,
  filters: readonly AnalyticsFilter[],
  limit: number,
): Promise<SecuritySource[]> {
  const where = buildWhere(window, filters, wafCondition);
  const rows = await queryRows<Record<string, unknown>>(
    `SELECT client_ip, any(country_code) AS country_code, count() AS requests,
            max(toUInt32(ts)) AS last_seen
     FROM waf_events WHERE ${where.sql}
     GROUP BY client_ip ORDER BY requests DESC LIMIT {p_limit:UInt32}`,
    { ...where.params, p_limit: safeUint(limit) },
  );
  const rules = await rulesBySource(
    window,
    rows.map((row) => String(row.client_ip ?? "")),
  );
  return rows.map((row) => {
    const ip = String(row.client_ip ?? "");
    return {
      ip,
      countryCode: typeof row.country_code === "string" ? row.country_code : null,
      asn: null,
      asnOrg: null,
      requests: num(row.requests),
      lastSeen: num(row.last_seen),
      rules: rules.get(ip) ?? [],
    };
  });
}

const WAF_HOST_GROUP_LIMIT = 5_000;

/** WAF events per Host header since `from`, for the per-host table. */
export async function queryWafEventsByHost(from: number, to: number): Promise<Map<string, number>> {
  const rows = await queryRows<Record<string, unknown>>(
    // The Host header is the client's: only the busiest groups come back.
    `SELECT host, count() AS events FROM waf_events WHERE ${timeFilter()} GROUP BY host
     ORDER BY events DESC LIMIT {p_limit:UInt32}`,
    { ...timeParams(from, to), p_limit: WAF_HOST_GROUP_LIMIT },
  );
  const out = new Map<string, number>();
  for (const row of rows) {
    // The column is the Host header, so a site also appears with its port.
    const host = String(row.host ?? "")
      .replace(/:\d+$/, "")
      .toLowerCase();
    out.set(host, (out.get(host) ?? 0) + num(row.events));
  }
  return out;
}
