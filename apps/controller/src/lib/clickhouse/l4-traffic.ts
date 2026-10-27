/**
 * One L4 host's connections for its page, by protocol and listen port: caddy-l4 logs no host, so
 * hosts sharing a port share its numbers. Written in the ClickHouse SQL ./sqlite-store.ts translates.
 */

import type { TimeWindow } from "../analytics/explore-state";
import { queryRow, queryRows, timeFilter, timeParams } from "./client";

/** A chart point every half hour, as the proxy host page has. */
export const L4_TRAFFIC_BUCKET_SECONDS = 1800;
export const L4_TOP_CLIENTS = 10;

export type L4Ports = { protocol: string; start: number; end: number };

export type L4TrafficTotals = {
  connections: number;
  bytesIn: number;
  bytesOut: number;
  uniqueIps: number;
  /** Null with no connections. */
  avgDurationMs: number | null;
};

export type L4TrafficBucket = { ts: number; connections: number };

export type L4ClientRow = {
  ip: string;
  country: string | null;
  connections: number;
  bytes: number;
};

export type L4TrafficReport = {
  window: TimeWindow;
  totals: L4TrafficTotals;
  timeline: L4TrafficBucket[];
  clients: L4ClientRow[];
};

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function bucketStarts(window: TimeWindow, size: number): number[] {
  const starts: number[] = [];
  for (let ts = Math.floor(window.from / size) * size; ts < window.to; ts += size) starts.push(ts);
  return starts;
}

export async function queryL4Traffic(window: TimeWindow, ports: L4Ports): Promise<L4TrafficReport> {
  const where = `${timeFilter()} AND network = {p_network:String} AND port >= {p_start:UInt16} AND port <= {p_end:UInt16}`;
  const params = {
    ...timeParams(window.from, window.to),
    p_network: ports.protocol,
    p_start: ports.start,
    p_end: ports.end,
  };

  const [totals, buckets, clients] = await Promise.all([
    queryRow<Record<string, unknown>>(
      `
      SELECT count() AS connections, sum(bytes_in) AS bytes_in, sum(bytes_out) AS bytes_out,
             uniq(client_ip) AS unique_ips, avg(duration_ms) AS avg_duration
      FROM l4_events
      WHERE ${where}
    `,
      params,
    ),
    queryRows<Record<string, unknown>>(
      `
      SELECT intDiv(toUInt32(ts), {p_bucket:UInt32}) AS bucket, count() AS connections
      FROM l4_events
      WHERE ${where}
      GROUP BY bucket
    `,
      { ...params, p_bucket: L4_TRAFFIC_BUCKET_SECONDS },
    ),
    queryRows<Record<string, unknown>>(
      `
      SELECT client_ip, any(country_code) AS country, count() AS connections,
             sum(bytes_in) + sum(bytes_out) AS bytes
      FROM l4_events
      WHERE ${where}
      GROUP BY client_ip
      ORDER BY connections DESC
      LIMIT {p_limit:UInt32}
    `,
      { ...params, p_limit: L4_TOP_CLIENTS },
    ),
  ]);

  const connections = num(totals?.connections);
  const byStart = new Map(
    buckets.map((row) => [Math.floor(num(row.bucket)) * L4_TRAFFIC_BUCKET_SECONDS, row]),
  );
  return {
    window,
    totals: {
      connections,
      bytesIn: num(totals?.bytes_in),
      bytesOut: num(totals?.bytes_out),
      uniqueIps: num(totals?.unique_ips),
      avgDurationMs: connections > 0 ? Math.round(num(totals?.avg_duration)) : null,
    },
    timeline: bucketStarts(window, L4_TRAFFIC_BUCKET_SECONDS).map((ts) => ({
      ts,
      connections: num(byStart.get(ts)?.connections),
    })),
    clients: clients.map((row) => ({
      ip: String(row.client_ip ?? ""),
      country: typeof row.country === "string" && row.country ? row.country : null,
      connections: num(row.connections),
      bytes: num(row.bytes),
    })),
  };
}
