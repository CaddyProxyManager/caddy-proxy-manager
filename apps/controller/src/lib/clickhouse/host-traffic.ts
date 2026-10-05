/**
 * One proxy host's traffic for its page: every name it serves, with or without a port on the
 * authority. Written in the ClickHouse SQL ./sqlite-store.ts translates.
 */

import type { TimeWindow } from "../analytics/explore-state";
import { PATH_SQL } from "./explore";
import { type QueryParams, queryRow, queryRows, safeUint, timeFilter, timeParams } from "./client";

/** A chart point every half hour: 48 over a day. */
export const HOST_TRAFFIC_BUCKET_SECONDS = 1800;

type Clause = { sql: string; params: QueryParams };

/** Null for a host with no name traffic can arrive under, e.g. only wildcards. */
export function hostNamesClause(names: readonly string[]): Clause | null {
  if (names.length === 0) return null;
  const params: QueryParams = {};
  const parts = names.map((name, index) => {
    const key = `hn_${index}`;
    params[key] = name;
    return `host = {${key}:String} OR startsWith(host, concat({${key}:String}, ':'))`;
  });
  return { sql: `(${parts.join(" OR ")})`, params };
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export type HostTrafficTotals = {
  requests: number;
  serverErrors: number;
  uniqueIps: number;
  bytes: number;
  mitigated: number;
};

export type HostTrafficBucket = {
  ts: number;
  requests: number;
  served: number;
  serverErrors: number;
};

export type HostPathRow = { path: string; requests: number; serverErrors: number };
export type HostStatusRow = { status: number; requests: number };

export type HostTrafficReport = {
  window: TimeWindow;
  totals: HostTrafficTotals;
  timeline: HostTrafficBucket[];
  paths: HostPathRow[];
  statuses: HostStatusRow[];
};

const EMPTY_TOTALS: HostTrafficTotals = {
  requests: 0,
  serverErrors: 0,
  uniqueIps: 0,
  bytes: 0,
  mitigated: 0,
};

/** Every bucket of the window, empty ones included, so the chart has no gaps to interpolate. */
function bucketStarts(window: TimeWindow, size: number): number[] {
  const starts: number[] = [];
  for (let ts = Math.floor(window.from / size) * size; ts < window.to; ts += size) starts.push(ts);
  return starts;
}

export async function queryHostTraffic(
  window: TimeWindow,
  names: readonly string[],
  limit = 10,
): Promise<HostTrafficReport> {
  const clause = hostNamesClause(names);
  const starts = bucketStarts(window, HOST_TRAFFIC_BUCKET_SECONDS);
  if (!clause) {
    return {
      window,
      totals: EMPTY_TOTALS,
      timeline: starts.map((ts) => ({ ts, requests: 0, served: 0, serverErrors: 0 })),
      paths: [],
      statuses: [],
    };
  }
  const where = `${timeFilter()} AND ${clause.sql}`;
  const params = { ...timeParams(window.from, window.to), ...clause.params };
  const top = Math.min(Math.max(1, safeUint(limit)), 50);

  const [totals, buckets, paths, statuses] = await Promise.all([
    queryRow<Record<string, unknown>>(
      `
      SELECT count() AS requests, countIf(status >= 500) AS server_errors,
             uniq(client_ip) AS unique_ips, sum(bytes_sent) AS bytes,
             countIf(outcome != 'served') AS mitigated
      FROM traffic_events
      WHERE ${where}
    `,
      params,
    ),
    queryRows<Record<string, unknown>>(
      `
      SELECT intDiv(toUInt32(ts), {p_bucket:UInt32}) AS bucket, count() AS requests,
             countIf(outcome = 'served' AND status < 500) AS served,
             countIf(status >= 500) AS server_errors
      FROM traffic_events
      WHERE ${where}
      GROUP BY bucket
    `,
      { ...params, p_bucket: HOST_TRAFFIC_BUCKET_SECONDS },
    ),
    queryRows<Record<string, unknown>>(
      `
      SELECT ${PATH_SQL} AS path_key, count() AS requests, countIf(status >= 500) AS server_errors
      FROM traffic_events
      WHERE ${where}
      GROUP BY path_key
      ORDER BY requests DESC
      LIMIT {p_limit:UInt32}
    `,
      { ...params, p_limit: top },
    ),
    queryRows<Record<string, unknown>>(
      `
      SELECT status, count() AS requests
      FROM traffic_events
      WHERE ${where}
      GROUP BY status
      ORDER BY requests DESC
      LIMIT {p_limit:UInt32}
    `,
      { ...params, p_limit: top },
    ),
  ]);

  const byStart = new Map(
    buckets.map((row) => [Math.floor(num(row.bucket)) * HOST_TRAFFIC_BUCKET_SECONDS, row]),
  );
  return {
    window,
    totals: {
      requests: num(totals?.requests),
      serverErrors: num(totals?.server_errors),
      uniqueIps: num(totals?.unique_ips),
      bytes: num(totals?.bytes),
      mitigated: num(totals?.mitigated),
    },
    timeline: starts.map((ts) => {
      const row = byStart.get(ts);
      return {
        ts,
        requests: num(row?.requests),
        served: num(row?.served),
        serverErrors: num(row?.server_errors),
      };
    }),
    paths: paths.map((row) => ({
      path: String(row.path_key ?? ""),
      requests: num(row.requests),
      serverErrors: num(row.server_errors),
    })),
    statuses: statuses.map((row) => ({ status: num(row.status), requests: num(row.requests) })),
  };
}
