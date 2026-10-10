import { AsyncLocalStorage } from "node:async_hooks";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { TrafficOutcome } from "@cpm/shared";
import { userAgentFamily } from "../analytics/user-agent";
import { onAnnouncement } from "../cluster/announcements";
import { isDemoMode } from "../demo/mode";
import * as sqliteStore from "./sqlite-store";
import { wafEventKey } from "../waf/event-key";

// ── Configuration ───────────────────────────────────────────────────────────

/**
 * Where analytics are written, from the settings registry. Read per call rather than at module
 * load, or a saved Settings change would wait for a restart.
 */
type ClickHouseConfig = {
  url: string;
  user: string;
  password: string;
  database: string;
  retentionDays: number;
  /** Whether to talk to ClickHouse at all. See resolveConfig for how an unset toggle is read. */
  enabled: boolean;
  /** A demo with no ClickHouse keeps its analytics in SQLite instead. See ./sqlite-store.ts. */
  sqlite: boolean;
};

/**
 * Dropped by `invalidateClickHouseConfig` on save. The promise is cached, not the value, so the
 * queries one analytics page fires share a single settings read.
 */
let configPromise: Promise<ClickHouseConfig> | null = null;

// The saving replica calls invalidateClickHouseConfig; the others hear of the save this way, or
// they would keep inserting under the old URL, password or retention until a restart.
onAnnouncement("settings", () => {
  configPromise = null;
  schemaPromise = null;
});

async function resolveConfig(): Promise<ClickHouseConfig> {
  // Imported lazily: this module is pulled in by the agent fleet configuration, which the settings
  // layer reaches in turn, and a static import would close that cycle.
  const [registry, { getSetting }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);

  const [toggle, url, user, password, database, retentionDays] = await Promise.all([
    getSetting(registry.analyticsEnabled),
    getSetting(registry.clickhouseUrl),
    getSetting(registry.clickhouseUser),
    getSetting(registry.clickhousePassword),
    getSetting(registry.clickhouseDb),
    getSetting(registry.clickhouseRetentionDays),
  ]);

  // No password, no analytics, whatever the toggle says: the ClickHouse container will not start
  // without one, and an empty password would only produce a connection refused per query.
  const configured = password.trim().length > 0;
  // A demo runs no containers, so without a ClickHouse it gets the SQLite store - on unless switched
  // off, since a demo's analytics page is part of what it is showing.
  const sqlite = isDemoMode() && !configured;
  if (toggle === true && !configured && !sqlite) {
    console.warn(
      "Analytics are switched on but no ClickHouse password is set - nothing will be recorded.",
    );
  }
  // An unset toggle decides from the configuration, so upgrading keeps a working deployment's
  // analytics on.
  const enabled = sqlite ? toggle !== false : (toggle ?? configured) && configured;

  // Interpolated into DDL, which has no placeholder for an identifier. The registry rejects a bad
  // value on the way in; this catches one that reached the table before that pattern existed.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(database)) {
    throw new Error(`The ClickHouse database name contains invalid characters: ${database}`);
  }

  return { url, user, password, database, retentionDays, enabled, sqlite };
}

function chConfig(): Promise<ClickHouseConfig> {
  configPromise ??= resolveConfig();
  return configPromise;
}

/**
 * Called on settings save. Without the close, the singleton would keep a connection opened under
 * the old URL or password until a restart.
 */
export async function invalidateClickHouseConfig(): Promise<void> {
  configPromise = null;
  // The database, retention or the server itself may have changed; the next insert re-checks.
  schemaPromise = null;
  try {
    await closeClickHouse();
  } catch (error) {
    // Best-effort: the settings are already saved, and the next getClient rebuilds either way.
    console.warn("Could not close the previous ClickHouse client:", error);
    client = null;
    clientKey = null;
  }
}

/** Whether traffic and WAF events are being recorded. */
export async function isAnalyticsEnabled(): Promise<boolean> {
  return (await chConfig()).enabled;
}

/** Whether this is a demo keeping its analytics in SQLite rather than ClickHouse. */
export async function usesSqliteAnalytics(): Promise<boolean> {
  return (await chConfig()).sqlite;
}

/** Number of days analytics events are retained before TTL deletion. */
export async function getRetentionDays(): Promise<number> {
  return (await chConfig()).retentionDays;
}

// ── Singleton client ────────────────────────────────────────────────────────

let client: ClickHouseClient | null = null;
/** The connection settings `client` was opened with, so a changed one is noticed. */
let clientKey: string | null = null;

export async function getClient(): Promise<ClickHouseClient> {
  const { url, user, password, database } = await chConfig();
  const key = JSON.stringify([url, user, password, database]);
  if (client && clientKey === key) return client;

  if (client) await client.close();
  clientKey = key;
  // outbound: clickhouse
  client = createClient({
    url,
    username: user,
    password,
    database,
    // The default 10 queues an analytics page's parallel reads behind the inserts.
    max_open_connections: 20,
    clickhouse_settings: {
      async_insert: 1,
      wait_for_async_insert: 0,
    },
    log: {
      // 127 is ClickHouseLogLevel.OFF; keep this numeric to avoid widening test mocks.
      level: 127,
    },
  });
  return client;
}

// ── Table creation ──────────────────────────────────────────────────────────

/**
 * Outcome, duration, ASN and user-agent family. The outcome's default is computed per read for rows
 * written before it, so an older blocker row still counts as geo without rewriting a part.
 */
const TRAFFIC_EVENTS_V2_COLUMNS = [
  "duration_ms  Nullable(UInt32)",
  "outcome      LowCardinality(String) DEFAULT if(is_blocked, 'geo', 'served')",
  "asn          UInt32 DEFAULT 0",
  "asn_org      LowCardinality(String) DEFAULT ''",
  "ua_family    LowCardinality(String) DEFAULT ''",
];

const trafficEventsDdl = (retentionDays: number) => `
CREATE TABLE IF NOT EXISTS traffic_events (
    ts           DateTime          CODEC(Delta, ZSTD),
    client_ip    String            CODEC(ZSTD(3)),
    country_code LowCardinality(Nullable(String)),
    host         LowCardinality(String) DEFAULT '' CODEC(ZSTD(3)),
    method       LowCardinality(String) DEFAULT '' CODEC(ZSTD(3)),
    uri          String            DEFAULT '' CODEC(ZSTD(3)),
    status       UInt16            DEFAULT 0,
    proto        LowCardinality(String) DEFAULT '' CODEC(ZSTD(3)),
    bytes_sent   UInt64            DEFAULT 0 CODEC(Delta, ZSTD),
    user_agent   String            DEFAULT '' CODEC(ZSTD(3)),
    is_blocked   Bool              DEFAULT false,
    agent_id     LowCardinality(String) DEFAULT '',
    ${TRAFFIC_EVENTS_V2_COLUMNS.join(", ")}
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(ts)
ORDER BY (host, ts)
TTL ts + INTERVAL ${retentionDays} DAY DELETE
SETTINGS index_granularity = 8192
`;

const wafEventsDdl = (retentionDays: number) => `
CREATE TABLE IF NOT EXISTS waf_events (
    ts           DateTime          CODEC(Delta, ZSTD),
    host         LowCardinality(String) DEFAULT '' CODEC(ZSTD(3)),
    client_ip    String            CODEC(ZSTD(3)),
    country_code LowCardinality(Nullable(String)),
    method       LowCardinality(String) DEFAULT '' CODEC(ZSTD(3)),
    uri          String            DEFAULT '' CODEC(ZSTD(3)),
    rule_id      Nullable(Int32),
    rule_message Nullable(String)  CODEC(ZSTD(3)),
    severity     LowCardinality(Nullable(String)),
    raw_data     Nullable(String)  CODEC(ZSTD(3)),
    blocked      Bool              DEFAULT true,
    agent_id     LowCardinality(String) DEFAULT ''
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(ts)
ORDER BY (host, ts)
TTL ts + INTERVAL ${retentionDays} DAY DELETE
SETTINGS index_granularity = 8192
`;

// Migrations applied to existing tables on startup, each idempotent.
const TRAFFIC_EVENTS_MIGRATIONS = [
  `ALTER TABLE traffic_events MODIFY COLUMN ts DateTime CODEC(Delta, ZSTD)`,
  `ALTER TABLE traffic_events MODIFY COLUMN client_ip String CODEC(ZSTD(3))`,
  `ALTER TABLE traffic_events MODIFY COLUMN country_code LowCardinality(Nullable(String))`,
  `ALTER TABLE traffic_events MODIFY COLUMN host LowCardinality(String) DEFAULT '' CODEC(ZSTD(3))`,
  `ALTER TABLE traffic_events MODIFY COLUMN method LowCardinality(String) DEFAULT '' CODEC(ZSTD(3))`,
  `ALTER TABLE traffic_events MODIFY COLUMN uri String DEFAULT '' CODEC(ZSTD(3))`,
  `ALTER TABLE traffic_events MODIFY COLUMN proto LowCardinality(String) DEFAULT '' CODEC(ZSTD(3))`,
  `ALTER TABLE traffic_events MODIFY COLUMN bytes_sent UInt64 DEFAULT 0 CODEC(Delta, ZSTD)`,
  `ALTER TABLE traffic_events MODIFY COLUMN user_agent String DEFAULT '' CODEC(ZSTD(3))`,
  `ALTER TABLE traffic_events ADD COLUMN IF NOT EXISTS agent_id LowCardinality(String) DEFAULT ''`,
  // Metadata only: an added column costs no rewrite, so this is safe on a table of any size.
  ...TRAFFIC_EVENTS_V2_COLUMNS.map(
    (column) => `ALTER TABLE traffic_events ADD COLUMN IF NOT EXISTS ${column}`,
  ),
];

const WAF_EVENTS_MIGRATIONS = [
  `ALTER TABLE waf_events MODIFY COLUMN ts DateTime CODEC(Delta, ZSTD)`,
  `ALTER TABLE waf_events MODIFY COLUMN host LowCardinality(String) DEFAULT '' CODEC(ZSTD(3))`,
  `ALTER TABLE waf_events MODIFY COLUMN client_ip String CODEC(ZSTD(3))`,
  `ALTER TABLE waf_events MODIFY COLUMN country_code LowCardinality(Nullable(String))`,
  `ALTER TABLE waf_events MODIFY COLUMN method LowCardinality(String) DEFAULT '' CODEC(ZSTD(3))`,
  `ALTER TABLE waf_events MODIFY COLUMN uri String DEFAULT '' CODEC(ZSTD(3))`,
  `ALTER TABLE waf_events MODIFY COLUMN severity LowCardinality(Nullable(String))`,
  `ALTER TABLE waf_events MODIFY COLUMN rule_message Nullable(String) CODEC(ZSTD(3))`,
  `ALTER TABLE waf_events MODIFY COLUMN raw_data Nullable(String) CODEC(ZSTD(3))`,
  `ALTER TABLE waf_events ADD COLUMN IF NOT EXISTS agent_id LowCardinality(String) DEFAULT ''`,
];

const RETENTION_TABLES = ["traffic_events", "waf_events"] as const;

/** Extract the retention (in days) from a table's TTL clause, if present. */
function ttlDaysFromCreateQuery(createQuery: string): number | null {
  // ClickHouse normalizes `INTERVAL N DAY` to `toIntervalDay(N)` in create_table_query, but
  // older servers may report the literal form - match both.
  const match =
    createQuery.match(/TTL\s+ts\s*\+\s*toIntervalDay\((\d+)\)/i) ??
    createQuery.match(/TTL\s+ts\s*\+\s*INTERVAL\s+(\d+)\s+DAY/i);
  return match ? Number(match[1]) : null;
}

/**
 * Bring an existing table's TTL in line with CH_RETENTION_DAYS. `CREATE TABLE IF NOT EXISTS` never
 * alters one, so an explicit MODIFY TTL is needed - only when it differs, since it rewrites parts.
 */
async function ensureRetentionTtl(
  ch: ClickHouseClient,
  table: (typeof RETENTION_TABLES)[number],
  database: string,
  retentionDays: number,
): Promise<void> {
  const result = await ch.query({
    query: `SELECT create_table_query FROM system.tables WHERE database = {db:String} AND name = {tbl:String}`,
    query_params: { db: database, tbl: table },
    format: "JSONEachRow",
  });
  const rows = await result.json<{ create_table_query: string }>();
  const current = ttlDaysFromCreateQuery(rows[0]?.create_table_query ?? "");
  if (current === retentionDays) return;
  await ch.command({
    query: `ALTER TABLE ${table} MODIFY TTL ts + INTERVAL ${retentionDays} DAY DELETE`,
  });
}

// Diagnostic system-log tables that low-disk-write.yml turns off. On stock ClickHouse they flush
// every few seconds regardless of traffic; disabling stops new writes, and dropping them reclaims
// what a deployment accumulated before the override.
const DISABLED_SYSTEM_LOGS = [
  "metric_log",
  "asynchronous_metric_log",
  "trace_log",
  "query_log",
  "query_thread_log",
  "query_views_log",
  "part_log",
  "processors_profile_log",
  "text_log",
  "session_log",
  "opentelemetry_span_log",
  "blob_storage_log",
  "backup_log",
  "histogram_metric_log",
] as const;

// Also matches numbered upgrade leftovers: an upgrade renames the old table to `<name>_<N>` and
// never cleans it up. Built from the constant list above, so no user input reaches it.
const DISABLED_SYSTEM_LOG_PATTERN = `^(${DISABLED_SYSTEM_LOGS.join("|")})(_[0-9]+)?$`;

/** Best-effort: the analytics user often lacks DROP on `system`. */
async function dropDisabledSystemLogs(ch: ClickHouseClient): Promise<void> {
  let names: string[];
  try {
    const result = await ch.query({
      query: `SELECT name FROM system.tables WHERE database = 'system' AND match(name, {pattern:String})`,
      query_params: { pattern: DISABLED_SYSTEM_LOG_PATTERN },
      format: "JSONEachRow",
    });
    names = (await result.json<{ name: string }>())
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0);
  } catch (err) {
    console.warn(
      `[clickhouse] could not list disabled system log tables to drop: ${(err as Error).message}`,
    );
    return;
  }

  for (const name of names) {
    try {
      await ch.command({ query: `DROP TABLE IF EXISTS system.${name} SYNC` });
    } catch (err) {
      console.warn(
        `[clickhouse] could not drop disabled system log tables (insufficient privileges?); ` +
          `they will stop growing once the config override is applied, but existing data must be ` +
          `cleared manually. Reason: ${(err as Error).message}`,
      );
      return;
    }
  }
}

/**
 * Settled once per config, and forgotten on failure: the bundled agent starts ClickHouse after the
 * controller has booted, so the first attempt usually finds nothing listening.
 */
let schemaPromise: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    const pending = createSchema();
    schemaPromise = pending;
    pending.catch(() => {
      if (schemaPromise === pending) schemaPromise = null;
    });
  }
  return schemaPromise;
}

/** Code 60 and 81: tables or database gone under a live controller, e.g. a wiped volume. */
function isMissingSchema(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "60" || code === "81";
}

/** Runs `op`, and once more after recreating the schema if ClickHouse says it is missing. */
async function withSchema<T>(op: (ch: ClickHouseClient) => Promise<T>): Promise<T> {
  try {
    return await op(await getClient());
  } catch (error) {
    if (!isMissingSchema(error)) throw error;
    schemaPromise = null;
    await ensureSchema();
    return op(await getClient());
  }
}

/** Called at startup; a failure there is retried by the next insert rather than a restart. */
export function initClickHouse(): Promise<void> {
  return ensureSchema();
}

async function createSchema(): Promise<void> {
  const { enabled, database, retentionDays, sqlite } = await chConfig();
  if (!enabled) {
    console.log("ClickHouse analytics disabled");
    return;
  }
  if (sqlite) {
    sqliteStore.initSqliteStore();
    sqliteStore.pruneSqliteStore(retentionDays);
    return;
  }
  const ch = await getClient();
  await ch.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });
  await ch.command({ query: trafficEventsDdl(retentionDays) });
  await ch.command({ query: wafEventsDdl(retentionDays) });
  for (const q of [...TRAFFIC_EVENTS_MIGRATIONS, ...WAF_EVENTS_MIGRATIONS]) {
    await ch.command({ query: q });
  }
  for (const table of RETENTION_TABLES) {
    await ensureRetentionTtl(ch, table, database, retentionDays);
  }
  await dropDisabledSystemLogs(ch);
}

export async function closeClickHouse(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    clientKey = null;
  }
}

/** Empty both event tables, wherever they are. For the demo seed, whose data is not incremental. */
export async function clearAnalyticsEvents(): Promise<void> {
  const { enabled, sqlite } = await chConfig();
  if (!enabled) return;
  if (sqlite) return sqliteStore.clearSqliteStore();
  const ch = await getClient();
  for (const table of sqliteStore.ANALYTICS_TABLES) {
    await ch.command({ query: `TRUNCATE TABLE IF EXISTS ${table}` });
  }
}

// ── Insert helpers ──────────────────────────────────────────────────────────

export interface TrafficEventRow {
  ts: number;
  client_ip: string;
  country_code: string | null;
  host: string;
  method: string;
  uri: string;
  status: number;
  proto: string;
  bytes_sent: number;
  user_agent: string;
  is_blocked: boolean;
  duration_ms?: number | null;
  outcome?: TrafficOutcome;
  asn?: number | null;
  asn_org?: string | null;
}

/** The columns an older agent leaves out, filled the way a newer one would. */
function storedTrafficRow(row: TrafficEventRow, agentId: string) {
  return {
    ...row,
    duration_ms: row.duration_ms ?? null,
    outcome: row.outcome ?? (row.is_blocked ? "geo" : "served"),
    asn: row.asn ?? 0,
    asn_org: row.asn_org ?? "",
    ua_family: userAgentFamily(row.user_agent),
    agent_id: agentId,
  };
}

export interface WafEventRow {
  ts: number;
  host: string;
  client_ip: string;
  country_code: string | null;
  rule_id: number | null;
  rule_message: string | null;
  severity: string | null;
  raw_data: string | null;
  blocked: boolean;
  method: string;
  uri: string;
}

/** `agentId` is the agent that relayed the rows, recorded so a false event is attributable. */
/**
 * The ingest path waits for the flush: the dashboard re-reads the moment rows are announced, and
 * an unflushed row would be missed until the next batch. It also lets a failed flush fail the
 * request, so the agent resends instead of dropping the batch.
 */
const FLUSHED_INSERT = { async_insert: 1, wait_for_async_insert: 1 } as const;

export async function insertTrafficEvents(rows: TrafficEventRow[], agentId = ""): Promise<void> {
  if (rows.length === 0 || !(await isAnalyticsEnabled())) return;
  if ((await chConfig()).sqlite) {
    sqliteStore.insertIntoSqliteStore(
      "traffic_events",
      rows.map((r) => storedTrafficRow(r, agentId)),
    );
    return;
  }
  await ensureSchema();
  const values = rows.map((r) => ({
    ...storedTrafficRow(r, agentId),
    ts: new Date(r.ts * 1000).toISOString().replace("T", " ").slice(0, 19),
    is_blocked: r.is_blocked ? 1 : 0,
  }));
  await withSchema((ch) =>
    ch.insert({
      table: "traffic_events",
      values,
      format: "JSONEachRow",
      clickhouse_settings: FLUSHED_INSERT,
    }),
  );
}

export async function insertWafEvents(rows: WafEventRow[], agentId = ""): Promise<void> {
  if (rows.length === 0 || !(await isAnalyticsEnabled())) return;
  if ((await chConfig()).sqlite) {
    sqliteStore.insertIntoSqliteStore(
      "waf_events",
      rows.map((r) => ({ ...r, agent_id: agentId })),
    );
    return;
  }
  await ensureSchema();
  const values = rows.map((r) => ({
    ...r,
    ts: new Date(r.ts * 1000).toISOString().replace("T", " ").slice(0, 19),
    blocked: r.blocked ? 1 : 0,
    agent_id: agentId,
  }));
  await withSchema((ch) =>
    ch.insert({
      table: "waf_events",
      values,
      format: "JSONEachRow",
      clickhouse_settings: FLUSHED_INSERT,
    }),
  );
}

// ── Parameterized query helpers ─────────────────────────────────────────────

export type QueryParams = Record<string, unknown>;

/** A host filter clause with parameterized placeholders: the SQL fragment plus its params. */
export function hostFilter(hosts: string[]): { sql: string; params: QueryParams } {
  if (hosts.length === 0) return { sql: "", params: {} };
  const params: QueryParams = {};
  const placeholders: string[] = [];
  hosts.forEach((h, i) => {
    const key = `host_${i}`;
    params[key] = h;
    placeholders.push(`{${key}:String}`);
  });
  return { sql: ` AND host IN (${placeholders.join(",")})`, params };
}

export function timeFilter(): string {
  return `ts >= toDateTime({p_from:UInt32}) AND ts <= toDateTime({p_to:UInt32})`;
}

export function timeParams(from: number, to: number): QueryParams {
  return { p_from: safeUint(from), p_to: safeUint(to) };
}

/** A bare string is the free-text search alone, which is all the REST API passes. */
export type WafEventFilter = {
  search?: string;
  host?: string;
  clientIp?: string;
  ruleId?: number;
  blocked?: boolean;
  severity?: string;
};

function buildWafFilter(
  filter?: string | WafEventFilter,
  from?: number,
  to?: number,
): { where: string; params: QueryParams } {
  const clauses: string[] = [];
  let params: QueryParams = {};
  const { search, host, clientIp, ruleId, blocked, severity } =
    typeof filter === "string" ? { search: filter } : (filter ?? {});

  if (Number.isFinite(from) && Number.isFinite(to)) {
    clauses.push(timeFilter());
    params = { ...params, ...timeParams(from as number, to as number) };
  }

  // The column is the Host header, so the same site also appears with its port.
  if (host) {
    clauses.push(`(host = {p_host:String} OR startsWith(host, concat({p_host:String}, ':')))`);
    params.p_host = host;
  }
  if (clientIp) {
    clauses.push(`client_ip = {p_client_ip:String}`);
    params.p_client_ip = clientIp;
  }
  if (ruleId !== undefined && Number.isInteger(ruleId)) {
    clauses.push(`rule_id = {p_rule_id:Int32}`);
    params.p_rule_id = ruleId;
  }
  if (blocked !== undefined) {
    clauses.push(`blocked = {p_blocked:Bool}`);
    params.p_blocked = blocked;
  }
  // Severity arrives in whatever case the rule set wrote it, as the stats query already allows for.
  if (severity) {
    clauses.push(`upperUTF8(ifNull(severity, '')) = upperUTF8({p_severity:String})`);
    params.p_severity = severity;
  }

  if (search) {
    clauses.push(`(
      host ILIKE {p_search:String}
         OR client_ip ILIKE {p_search:String}
         OR uri ILIKE {p_search:String}
         OR rule_message ILIKE {p_search:String}
    )`);
    params.p_search = `%${search}%`;
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

/** Clamp a number to a safe non-negative integer (guards against NaN/Infinity). */
export function safeUint(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

const queryAbort = new AsyncLocalStorage<AbortSignal>();

/**
 * Every query `run` issues is cancelled on the server when `signal` aborts, rather than left
 * running after a budget gave up on it. Nested scopes abort with either signal.
 */
export function withQueryAbort<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  const outer = queryAbort.getStore();
  return queryAbort.run(outer ? AbortSignal.any([outer, signal]) : signal, run);
}

export async function queryRows<T>(query: string, query_params?: QueryParams): Promise<T[]> {
  const abort_signal = queryAbort.getStore();
  if (!(await isAnalyticsEnabled())) return [];
  abort_signal?.throwIfAborted();
  // Synchronous, so there is nothing to cancel once it starts.
  if ((await chConfig()).sqlite) return sqliteStore.querySqliteStore<T>(query, query_params);
  return withSchema(async (ch) => {
    abort_signal?.throwIfAborted();
    const result = await ch.query({ query, query_params, format: "JSONEachRow", abort_signal });
    return result.json<T>();
  });
}

/**
 * A `WITH TOTALS` query: the rows, and the totals row ClickHouse adds, which JSONEachRow drops.
 * ClickHouse only - the SQLite store cannot answer one, so its callers ask `usesSqliteAnalytics`.
 */
export async function queryRowsWithTotals<T>(
  query: string,
  query_params?: QueryParams,
): Promise<{ rows: T[]; totals: T | null }> {
  const abort_signal = queryAbort.getStore();
  if (!(await isAnalyticsEnabled())) return { rows: [], totals: null };
  if ((await chConfig()).sqlite)
    throw new Error("WITH TOTALS is not available in the SQLite store");
  abort_signal?.throwIfAborted();
  return withSchema(async (ch) => {
    const result = await ch.query({ query, query_params, format: "JSON", abort_signal });
    const body = await result.json<T>();
    return { rows: body.data, totals: (body.totals as T | undefined) ?? null };
  });
}

export async function queryRow<T>(query: string, query_params?: QueryParams): Promise<T | null> {
  const rows = await queryRows<T>(query, query_params);
  return rows[0] ?? null;
}

// ── Analytics queries ───────────────────────────────────────────────────────

export interface AnalyticsSummary {
  totalRequests: number;
  uniqueIps: number;
  blockedRequests: number;
  blockedPercent: number;
  bytesServed: number;
}

export async function querySummary(
  from: number,
  to: number,
  hosts: string[],
): Promise<AnalyticsSummary> {
  const hf = hostFilter(hosts);
  const tp = timeParams(from, to);

  // Independent tables, so one round trip rather than two in sequence.
  const [traffic, wafRow] = await Promise.all([
    queryRow<{
      total: string;
      unique_ips: string;
      blocked: string;
      bytes: string;
    }>(
      `
    SELECT
      count() AS total,
      uniq(client_ip) AS unique_ips,
      countIf(is_blocked) AS blocked,
      sum(bytes_sent) AS bytes
    FROM traffic_events
    WHERE ${timeFilter()}${hf.sql}
  `,
      { ...tp, ...hf.params },
    ),
    queryRow<{ waf_blocked: string }>(
      `
    SELECT count() AS waf_blocked
    FROM waf_events
    WHERE ${timeFilter()} AND blocked = true${hf.sql}
  `,
      { ...tp, ...hf.params },
    ),
  ]);

  const total = Number(traffic?.total ?? 0);
  const geoBlocked = Number(traffic?.blocked ?? 0);
  const wafBlocked = Number(wafRow?.waf_blocked ?? 0);
  const blocked = geoBlocked + wafBlocked;

  return {
    totalRequests: total,
    uniqueIps: Number(traffic?.unique_ips ?? 0),
    blockedRequests: blocked,
    blockedPercent: total > 0 ? Math.round((blocked / total) * 1000) / 10 : 0,
    bytesServed: Number(traffic?.bytes ?? 0),
  };
}

export interface TimelineBucket {
  ts: number;
  total: number;
  blocked: number;
  /** For the overview, whose chart follows whichever tile is selected. */
  clientErrors: number;
  serverErrors: number;
  bytes: number;
}

export function bucketSizeForDuration(seconds: number): number {
  if (seconds <= 3600) return 300;
  if (seconds <= 43200) return 1800;
  if (seconds <= 86400) return 3600;
  if (seconds <= 7 * 86400) return 21600;
  return 86400;
}

export async function queryTimeline(
  from: number,
  to: number,
  hosts: string[],
): Promise<TimelineBucket[]> {
  const bucketSize = bucketSizeForDuration(to - from);
  const hf = hostFilter(hosts);
  const tp = timeParams(from, to);

  const rows = await queryRows<{
    bucket: string;
    total: string;
    blocked: string;
    client_errors: string;
    server_errors: string;
    bytes: string;
  }>(
    `
    SELECT
      intDiv(toUInt32(ts), {p_bucket:UInt32}) AS bucket,
      count() AS total,
      countIf(is_blocked) AS blocked,
      countIf(status >= 400 AND status < 500) AS client_errors,
      countIf(status >= 500) AS server_errors,
      sum(bytes_sent) AS bytes
    FROM traffic_events
    WHERE ${timeFilter()}${hf.sql}
    GROUP BY bucket
    ORDER BY bucket
  `,
    { ...tp, ...hf.params, p_bucket: safeUint(bucketSize) },
  );

  return rows.map((r) => ({
    ts: Number(r.bucket) * bucketSize,
    total: Number(r.total),
    blocked: Number(r.blocked),
    clientErrors: Number(r.client_errors),
    serverErrors: Number(r.server_errors),
    bytes: Number(r.bytes),
  }));
}

export interface CountryStats {
  countryCode: string;
  total: number;
  blocked: number;
  uniqueIps: number;
}

export async function queryCountries(
  from: number,
  to: number,
  hosts: string[],
): Promise<CountryStats[]> {
  const hf = hostFilter(hosts);
  const tp = timeParams(from, to);

  const rows = await queryRows<{
    country_code: string | null;
    total: string;
    blocked: string;
    unique_ips: string;
  }>(
    `
    SELECT
      country_code,
      count() AS total,
      countIf(is_blocked) AS blocked,
      uniqExact(client_ip) AS unique_ips
    FROM traffic_events
    WHERE ${timeFilter()}${hf.sql}
    GROUP BY country_code
    ORDER BY total DESC
  `,
    { ...tp, ...hf.params },
  );

  return rows.map((r) => ({
    countryCode: r.country_code ?? "XX",
    total: Number(r.total),
    blocked: Number(r.blocked),
    uniqueIps: Number(r.unique_ips),
  }));
}

export interface CountryBreakdown {
  countryCode: string;
  total: number;
  blocked: number;
  uniqueIps: number;
  hosts: { host: string; count: number }[];
  statusClasses: { ok: number; redirects: number; clientErrors: number; serverErrors: number };
  userAgents: { userAgent: string; count: number }[];
}

/** How many rows each list in the country breakdown carries. */
const COUNTRY_BREAKDOWN_LIMIT = 5;

/**
 * "XX" is what queryCountries gives unplaced rows, so it selects the NULLs rather than a literal.
 * Three small queries, not one: each is a different GROUP BY, and they run in parallel.
 */
export async function queryCountryBreakdown(
  from: number,
  to: number,
  hosts: string[],
  countryCode: string,
): Promise<CountryBreakdown> {
  const hf = hostFilter(hosts);
  const tp = timeParams(from, to);
  const countrySql =
    countryCode === "XX" ? " AND country_code IS NULL" : " AND country_code = {country:String}";
  const params = { ...tp, ...hf.params, country: countryCode };
  const where = `${timeFilter()}${hf.sql}${countrySql}`;

  const [totals, hostRows, uaRows] = await Promise.all([
    queryRow<{
      total: string;
      blocked: string;
      unique_ips: string;
      ok: string;
      redirects: string;
      client_errors: string;
      server_errors: string;
    }>(
      `
      SELECT
        count() AS total,
        countIf(is_blocked) AS blocked,
        uniqExact(client_ip) AS unique_ips,
        countIf(status < 300) AS ok,
        countIf(status >= 300 AND status < 400) AS redirects,
        countIf(status >= 400 AND status < 500) AS client_errors,
        countIf(status >= 500) AS server_errors
      FROM traffic_events
      WHERE ${where}
    `,
      params,
    ),
    queryRows<{ host: string; count: string }>(
      `
      SELECT host, count() AS count
      FROM traffic_events
      WHERE ${where}
      GROUP BY host
      ORDER BY count DESC
      LIMIT ${COUNTRY_BREAKDOWN_LIMIT}
    `,
      params,
    ),
    queryRows<{ user_agent: string; count: string }>(
      `
      SELECT user_agent, count() AS count
      FROM traffic_events
      WHERE ${where}
      GROUP BY user_agent
      ORDER BY count DESC
      LIMIT ${COUNTRY_BREAKDOWN_LIMIT}
    `,
      params,
    ),
  ]);

  return {
    countryCode,
    total: Number(totals?.total ?? 0),
    blocked: Number(totals?.blocked ?? 0),
    uniqueIps: Number(totals?.unique_ips ?? 0),
    hosts: hostRows.map((r) => ({ host: r.host || "Unknown", count: Number(r.count) })),
    statusClasses: {
      ok: Number(totals?.ok ?? 0),
      redirects: Number(totals?.redirects ?? 0),
      clientErrors: Number(totals?.client_errors ?? 0),
      serverErrors: Number(totals?.server_errors ?? 0),
    },
    userAgents: uaRows.map((r) => ({
      userAgent: r.user_agent || "Unknown",
      count: Number(r.count),
    })),
  };
}

export interface ProtoStats {
  proto: string;
  count: number;
  percent: number;
}

export async function queryProtocols(
  from: number,
  to: number,
  hosts: string[],
): Promise<ProtoStats[]> {
  const hf = hostFilter(hosts);
  const tp = timeParams(from, to);

  const rows = await queryRows<{ proto: string; count: string }>(
    `
    SELECT
      proto,
      count() AS count
    FROM traffic_events
    WHERE ${timeFilter()}${hf.sql}
    GROUP BY proto
    ORDER BY count DESC
  `,
    { ...tp, ...hf.params },
  );

  const total = rows.reduce((s, r) => s + Number(r.count), 0);

  return rows.map((r) => ({
    proto: r.proto || "Unknown",
    count: Number(r.count),
    percent: total > 0 ? Math.round((Number(r.count) / total) * 1000) / 10 : 0,
  }));
}

export interface UAStats {
  userAgent: string;
  count: number;
  percent: number;
}

export async function queryUserAgents(
  from: number,
  to: number,
  hosts: string[],
): Promise<UAStats[]> {
  const hf = hostFilter(hosts);
  const tp = timeParams(from, to);

  const rows = await queryRows<{ user_agent: string; count: string }>(
    `
    SELECT
      user_agent,
      count() AS count
    FROM traffic_events
    WHERE ${timeFilter()}${hf.sql}
    GROUP BY user_agent
    ORDER BY count DESC
    LIMIT 10
  `,
    { ...tp, ...hf.params },
  );

  const total = rows.reduce((s, r) => s + Number(r.count), 0);

  return rows.map((r) => ({
    userAgent: r.user_agent || "Unknown",
    count: Number(r.count),
    percent: total > 0 ? Math.round((Number(r.count) / total) * 1000) / 10 : 0,
  }));
}

export interface BlockedEvent {
  id: number;
  ts: number;
  clientIp: string;
  countryCode: string | null;
  method: string;
  uri: string;
  status: number;
  host: string;
}

export interface BlockedPage {
  events: BlockedEvent[];
  total: number;
  page: number;
  pages: number;
}

export async function queryBlocked(
  from: number,
  to: number,
  hosts: string[],
  page: number,
): Promise<BlockedPage> {
  if (!(await isAnalyticsEnabled())) return { events: [], total: 0, page: 1, pages: 1 };
  const pageSize = 10;
  const hf = hostFilter(hosts);
  const tp = timeParams(from, to);
  const whereSQL = `${timeFilter()} AND is_blocked = true${hf.sql}`;
  const params = { ...tp, ...hf.params };

  const totalRow = await queryRow<{ total: string }>(
    `SELECT count() AS total FROM traffic_events WHERE ${whereSQL}`,
    params,
  );
  const total = Number(totalRow?.total ?? 0);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, Number.isFinite(page) ? page : 1), pages);

  const rows = await queryRows<{
    ts: string;
    client_ip: string;
    country_code: string | null;
    method: string;
    uri: string;
    status: string;
    host: string;
  }>(
    `
    SELECT toUInt32(ts) AS ts, client_ip, country_code, method, uri, status, host
    FROM traffic_events
    WHERE ${whereSQL}
    ORDER BY ts DESC
    LIMIT {p_limit:UInt32} OFFSET {p_offset:UInt32}
  `,
    { ...params, p_limit: pageSize, p_offset: (safePage - 1) * pageSize },
  );

  return {
    events: rows.map((r, i) => ({
      id: (safePage - 1) * pageSize + i + 1,
      ts: Number(r.ts),
      clientIp: r.client_ip,
      countryCode: r.country_code,
      method: r.method,
      uri: r.uri,
      status: Number(r.status),
      host: r.host,
    })),
    total,
    page: safePage,
    pages,
  };
}

export interface StatusClassCounts {
  /** 2xx and 3xx together: the overview treats "served" as one number. */
  ok: number;
  clientErrors: number;
  serverErrors: number;
  /** Rows the blocker handler stopped, so the tile and its log share one population. */
  blocked: number;
}

/**
 * Not in `querySummary`: the analytics page shares it and has no use for these, so widening it
 * would make every caller pay for three more aggregates.
 */
export async function queryStatusClasses(
  from: number,
  to: number,
  hosts: string[],
): Promise<StatusClassCounts> {
  const hf = hostFilter(hosts);
  const tp = timeParams(from, to);
  const row = await queryRow<{
    ok: string;
    client_errors: string;
    server_errors: string;
    blocked: string;
  }>(
    `
    SELECT
      countIf(status < 400) AS ok,
      countIf(status >= 400 AND status < 500) AS client_errors,
      countIf(status >= 500) AS server_errors,
      countIf(is_blocked) AS blocked
    FROM traffic_events
    WHERE ${timeFilter()}${hf.sql}
  `,
    { ...tp, ...hf.params },
  );
  return {
    ok: Number(row?.ok ?? 0),
    clientErrors: Number(row?.client_errors ?? 0),
    serverErrors: Number(row?.server_errors ?? 0),
    blocked: Number(row?.blocked ?? 0),
  };
}

/**
 * Each is a status class a tile already counts, so the log below a tile is the same population as
 * its number.
 */
export type TrafficEventFilter = "all" | "server-errors" | "client-errors" | "largest" | "blocked";

export interface TrafficEvent {
  ts: number;
  clientIp: string;
  countryCode: string | null;
  host: string;
  method: string;
  uri: string;
  status: number;
  proto: string;
  bytesSent: number;
  isBlocked: boolean;
}

const TRAFFIC_EVENT_CONDITIONS: Record<TrafficEventFilter, string> = {
  all: "",
  "server-errors": " AND status >= 500",
  "client-errors": " AND status >= 400 AND status < 500",
  largest: " AND bytes_sent > 0",
  blocked: " AND is_blocked = true",
};

/**
 * Newest first, or largest first for the bandwidth tile. `traffic_events` has no upstream address
 * or request duration, so neither is offered.
 */
export async function queryTrafficEvents(
  from: number,
  to: number,
  hosts: string[],
  filter: TrafficEventFilter,
  limit: number,
): Promise<TrafficEvent[]> {
  if (!(await isAnalyticsEnabled())) return [];
  const hf = hostFilter(hosts);
  const tp = timeParams(from, to);
  const order = filter === "largest" ? "bytes_sent DESC, ts DESC" : "ts DESC";

  const rows = await queryRows<{
    ts: string;
    client_ip: string;
    country_code: string | null;
    host: string;
    method: string;
    uri: string;
    status: string;
    proto: string;
    bytes_sent: string;
    is_blocked: boolean;
  }>(
    `
    SELECT toUInt32(ts) AS ts, client_ip, country_code, host, method, uri,
           status, proto, bytes_sent, is_blocked
    FROM traffic_events
    WHERE ${timeFilter()}${hf.sql}${TRAFFIC_EVENT_CONDITIONS[filter]}
    ORDER BY ${order}
    LIMIT {p_limit:UInt32}
  `,
    { ...tp, ...hf.params, p_limit: Math.min(Math.max(1, limit), 200) },
  );

  return rows.map((r) => ({
    ts: Number(r.ts),
    clientIp: r.client_ip,
    countryCode: r.country_code,
    host: r.host,
    method: r.method,
    uri: r.uri,
    status: Number(r.status),
    proto: r.proto,
    bytesSent: Number(r.bytes_sent),
    isBlocked: Boolean(r.is_blocked),
  }));
}

export async function queryDistinctHosts(): Promise<string[]> {
  const rows = await queryRows<{ host: string }>(
    `SELECT DISTINCT host FROM traffic_events WHERE host != ''`,
  );
  return rows.map((r) => r.host);
}

export interface HostTotals {
  host: string;
  total: number;
  blocked: number;
  serverErrors: number;
}

/** Per-host request counts in one grouped query, not a round trip per row of the host list. */
export async function queryHostTotals(from: number, to: number): Promise<HostTotals[]> {
  const rows = await queryRows<{
    host: string;
    total: string;
    blocked: string;
    server_errors?: string;
  }>(
    `
    SELECT
      host,
      count() AS total,
      countIf(is_blocked) AS blocked,
      countIf(status >= 500) AS server_errors
    FROM traffic_events
    WHERE ${timeFilter()} AND host != ''
    GROUP BY host
  `,
    timeParams(from, to),
  );

  return rows.map((r) => ({
    host: r.host,
    total: Number(r.total),
    blocked: Number(r.blocked),
    serverErrors: Number(r.server_errors ?? 0),
  }));
}

// ── WAF analytics queries ───────────────────────────────────────────────────

export async function queryWafCount(from: number, to: number): Promise<number> {
  const tp = timeParams(from, to);
  const row = await queryRow<{ value: string }>(
    `
    SELECT count() AS value FROM waf_events WHERE ${timeFilter()}
  `,
    tp,
  );
  return Number(row?.value ?? 0);
}

export async function queryWafCountWithSearch(
  filter?: string | WafEventFilter,
  from?: number,
  to?: number,
): Promise<number> {
  const built = buildWafFilter(filter, from, to);
  const row = await queryRow<{ value: string }>(
    `
    SELECT count() AS value FROM waf_events
    ${built.where}
  `,
    built.params,
  );
  return Number(row?.value ?? 0);
}

export interface WafEventStats {
  total: number;
  blocked: number;
  critical: number;
  uniqueHosts: number;
  ruleIdsTriggered: number;
}

export async function queryWafEventStatsWithSearch(
  filter?: string | WafEventFilter,
  from?: number,
  to?: number,
): Promise<WafEventStats> {
  const built = buildWafFilter(filter, from, to);
  const row = await queryRow<{
    total: string;
    blocked: string;
    critical: string;
    unique_hosts: string;
    rule_ids_triggered: string;
  }>(
    `
    SELECT
      count() AS total,
      countIf(blocked) AS blocked,
      countIf(upperUTF8(ifNull(severity, '')) = 'CRITICAL') AS critical,
      uniqExact(host) AS unique_hosts,
      uniqExactIf(rule_id, rule_id IS NOT NULL) AS rule_ids_triggered
    FROM waf_events
    ${built.where}
  `,
    built.params,
  );

  return {
    total: Number(row?.total ?? 0),
    blocked: Number(row?.blocked ?? 0),
    critical: Number(row?.critical ?? 0),
    uniqueHosts: Number(row?.unique_hosts ?? 0),
    ruleIdsTriggered: Number(row?.rule_ids_triggered ?? 0),
  };
}

export interface TopWafRule {
  ruleId: number;
  count: number;
  message: string | null;
}

export async function queryTopWafRules(
  from: number,
  to: number,
  limit = 10,
): Promise<TopWafRule[]> {
  const tp = timeParams(from, to);
  const rows = await queryRows<{ rule_id: string; count: string; message: string | null }>(
    `
    SELECT
      rule_id,
      count() AS count,
      any(rule_message) AS message
    FROM waf_events
    WHERE ${timeFilter()} AND rule_id IS NOT NULL
    GROUP BY rule_id
    ORDER BY count DESC
    LIMIT {p_limit:UInt32}
  `,
    { ...tp, p_limit: safeUint(limit) },
  );

  return rows
    .filter((r) => r.rule_id != null)
    .map((r) => ({
      ruleId: Number(r.rule_id),
      count: Number(r.count),
      message: r.message ?? null,
    }));
}

export interface TopWafRuleWithHosts {
  ruleId: number;
  count: number;
  message: string | null;
  hosts: { host: string; count: number }[];
}

export async function queryTopWafRulesWithHosts(
  from: number,
  to: number,
  limit = 10,
): Promise<TopWafRuleWithHosts[]> {
  const topRules = await queryTopWafRules(from, to, limit);
  if (topRules.length === 0) return [];

  // Rule IDs come from ClickHouse query results - integers, so safe for an IN clause
  const ruleIds = topRules.map((r) => r.ruleId);
  const tp = timeParams(from, to);
  const ruleParams: QueryParams = {};
  const rulePlaceholders: string[] = [];
  ruleIds.forEach((id, i) => {
    const key = `rid_${i}`;
    ruleParams[key] = id;
    rulePlaceholders.push(`{${key}:Int32}`);
  });

  const hostRows = await queryRows<{ rule_id: string; host: string; count: string }>(
    `
    SELECT rule_id, host, count() AS count
    FROM waf_events
    WHERE ${timeFilter()} AND rule_id IN (${rulePlaceholders.join(",")})
    GROUP BY rule_id, host
    ORDER BY count DESC
  `,
    { ...tp, ...ruleParams },
  );

  // Grouped once; the rows arrive ordered by count, and insertion order keeps it per rule.
  const hostsByRule = new Map<number, { host: string; count: number }[]>();
  for (const r of hostRows) {
    const ruleId = Number(r.rule_id);
    const entry = { host: r.host, count: Number(r.count) };
    const list = hostsByRule.get(ruleId);
    if (list) list.push(entry);
    else hostsByRule.set(ruleId, [entry]);
  }

  return topRules.map((rule) => ({
    ...rule,
    hosts: hostsByRule.get(rule.ruleId) ?? [],
  }));
}

export async function queryWafCountries(
  from: number,
  to: number,
): Promise<{ countryCode: string; count: number }[]> {
  const tp = timeParams(from, to);
  const rows = await queryRows<{ country_code: string | null; count: string }>(
    `
    SELECT country_code, count() AS count
    FROM waf_events
    WHERE ${timeFilter()}
    GROUP BY country_code
    ORDER BY count DESC
  `,
    tp,
  );
  return rows.map((r) => ({ countryCode: r.country_code ?? "XX", count: Number(r.count) }));
}

export async function queryWafRuleMessages(
  ruleIds: number[],
): Promise<Record<number, string | null>> {
  if (ruleIds.length === 0) return {};
  const params: QueryParams = {};
  const placeholders: string[] = [];
  ruleIds.forEach((id, i) => {
    const key = `rid_${i}`;
    params[key] = id;
    placeholders.push(`{${key}:Int32}`);
  });
  const rows = await queryRows<{ rule_id: string; message: string | null }>(
    `
    SELECT rule_id, any(rule_message) AS message
    FROM waf_events
    WHERE rule_id IN (${placeholders.join(",")})
    GROUP BY rule_id
  `,
    params,
  );
  return Object.fromEntries(
    rows.filter((r) => r.rule_id != null).map((r) => [Number(r.rule_id), r.message ?? null]),
  );
}

export interface WafEvent {
  id: number;
  /** Stable across pages and reloads, unlike `id`; see waf/event-key.ts. */
  key: string;
  ts: number;
  host: string;
  clientIp: string;
  countryCode: string | null;
  method: string;
  uri: string;
  ruleId: number | null;
  ruleMessage: string | null;
  severity: string | null;
  rawData: string | null;
  blocked: boolean;
}

export async function queryWafEvents(
  limit = 50,
  offset = 0,
  filter?: string | WafEventFilter,
  from?: number,
  to?: number,
): Promise<WafEvent[]> {
  const safeLimit = safeUint(limit);
  const safeOffset = safeUint(offset);
  const built = buildWafFilter(filter, from, to);
  const query = `
    SELECT toUInt32(ts) AS ts, host, client_ip, country_code, method, uri,
           rule_id, rule_message, severity, raw_data, blocked
    FROM waf_events
    ${built.where}
    ORDER BY ts DESC
    LIMIT {p_limit:UInt32} OFFSET {p_offset:UInt32}
  `;
  const params = { ...built.params, p_limit: safeLimit, p_offset: safeOffset };

  const rows = await queryRows<{
    ts: string;
    host: string;
    client_ip: string;
    country_code: string | null;
    method: string;
    uri: string;
    rule_id: string | null;
    rule_message: string | null;
    severity: string | null;
    raw_data: string | null;
    blocked: string;
  }>(query, params);

  return rows.map((r, i) => toWafEvent(r, safeOffset + i + 1));
}

export type StoredWafEventRow = {
  ts: string | number;
  host: string;
  client_ip: string;
  country_code: string | null;
  method: string;
  uri: string;
  rule_id: string | number | null;
  rule_message: string | null;
  severity: string | null;
  raw_data: string | null;
  blocked: string | number | boolean;
};

export function toWafEvent(r: StoredWafEventRow, id: number): WafEvent {
  const event = {
    id,
    ts: Number(r.ts),
    host: r.host,
    clientIp: r.client_ip,
    countryCode: r.country_code ?? null,
    method: r.method,
    uri: r.uri,
    ruleId: r.rule_id != null ? Number(r.rule_id) : null,
    ruleMessage: r.rule_message ?? null,
    severity: r.severity ?? null,
    rawData: r.raw_data ?? null,
    blocked: Boolean(Number(r.blocked)),
  };
  return { ...event, key: wafEventKey(event) };
}
