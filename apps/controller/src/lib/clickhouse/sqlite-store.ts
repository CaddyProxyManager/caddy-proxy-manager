/**
 * Demo-only analytics without ClickHouse: ./client.ts's ClickHouse SQL, translated, rather than a
 * second copy of every query to drift. An unlisted function is left as written and fails loudly.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { databaseDialect, resolveSqlitePath } from "../db/dialect";

const DDL = `
CREATE TABLE IF NOT EXISTS traffic_events (
  ts INTEGER NOT NULL,
  client_ip TEXT NOT NULL DEFAULT '',
  country_code TEXT,
  host TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT '',
  uri TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  proto TEXT NOT NULL DEFAULT '',
  bytes_sent INTEGER NOT NULL DEFAULT 0,
  user_agent TEXT NOT NULL DEFAULT '',
  is_blocked INTEGER NOT NULL DEFAULT 0,
  agent_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS traffic_events_ts ON traffic_events (ts);
CREATE INDEX IF NOT EXISTS traffic_events_host_ts ON traffic_events (host, ts);
CREATE TABLE IF NOT EXISTS waf_events (
  ts INTEGER NOT NULL,
  host TEXT NOT NULL DEFAULT '',
  client_ip TEXT NOT NULL DEFAULT '',
  country_code TEXT,
  method TEXT NOT NULL DEFAULT '',
  uri TEXT NOT NULL DEFAULT '',
  rule_id INTEGER,
  rule_message TEXT,
  severity TEXT,
  raw_data TEXT,
  blocked INTEGER NOT NULL DEFAULT 1,
  agent_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS waf_events_ts ON waf_events (ts);
`;

export const ANALYTICS_TABLES = ["traffic_events", "waf_events"] as const;

/** Beside the app's SQLite file, so a demo resets in one directory; memory on PostgreSQL. */
export function sqliteStorePath(env: Record<string, string | undefined> = process.env): string {
  const pinned = env.DEMO_ANALYTICS_DB?.trim();
  if (pinned) return pinned;
  if (databaseDialect(env) !== "sqlite") return ":memory:";
  const main = resolveSqlitePath(env.DATABASE_URL?.trim() ?? "");
  return main === ":memory:" ? ":memory:" : join(dirname(main), "analytics.db");
}

type Global = typeof globalThis & { __CPM_ANALYTICS_SQLITE__?: Database };

/** One handle per process: vinext evaluates modules once per environment, and memory is per handle. */
function store(): Database {
  const global = globalThis as Global;
  if (global.__CPM_ANALYTICS_SQLITE__) return global.__CPM_ANALYTICS_SQLITE__;
  const path = sqliteStorePath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true });
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA busy_timeout = 5000");
  database.run(DDL);
  global.__CPM_ANALYTICS_SQLITE__ = database;
  return database;
}

export function initSqliteStore(): void {
  store();
}

export function clearSqliteStore(): void {
  for (const table of ANALYTICS_TABLES) store().run(`DELETE FROM ${table}`);
}

/** As ClickHouse's TTL would. */
export function pruneSqliteStore(retentionDays: number): void {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  for (const table of ANALYTICS_TABLES) store().run(`DELETE FROM ${table} WHERE ts < ?`, [cutoff]);
}

/** So a restarted demo can fill the gap it was down for. */
export function latestEventTs(): number | null {
  const row = store()
    .query<{ ts: number | null }, []>("SELECT max(ts) AS ts FROM traffic_events")
    .get();
  return row?.ts ?? null;
}

type Row = Record<string, string | number | boolean | null>;

export function insertIntoSqliteStore(table: (typeof ANALYTICS_TABLES)[number], rows: Row[]): void {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]!);
  const statement = store().prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  store().transaction(() => {
    for (const row of rows) {
      statement.run(
        ...columns.map((column) => {
          const value = row[column];
          return typeof value === "boolean" ? (value ? 1 : 0) : (value ?? null);
        }),
      );
    }
  })();
}

export function querySqliteStore<T>(query: string, params: Record<string, unknown> = {}): T[] {
  const { sql, bindings } = translateClickHouseSql(query, params);
  return store().query(sql).all(bindings) as T[];
}

// ── Translation ─────────────────────────────────────────────────────────────

/** Split at top-level commas. */
function callArguments(sql: string, open: number): { args: string[]; end: number } {
  const args: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = open + 1;
  for (let i = open; i < sql.length; i++) {
    const char = sql[i];
    // An escaped quote ('') toggles twice, so a literal holding one still ends where it should.
    if (char === "'") quoted = !quoted;
    if (quoted) continue;
    if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0) {
        args.push(sql.slice(start, i).trim());
        return { args: args.filter((arg, index) => arg !== "" || index > 0), end: i + 1 };
      }
    } else if (char === "," && depth === 1) {
      args.push(sql.slice(start, i).trim());
      start = i + 1;
    }
  }
  throw new Error(`Unbalanced parentheses in analytics query: ${sql}`);
}

/** Longer names first, so a prefix never wins. */
const FUNCTIONS: Array<[string, (args: string[]) => string]> = [
  [
    "uniqExactIf",
    ([value, condition]) => `count(DISTINCT CASE WHEN ${condition} THEN ${value} END)`,
  ],
  ["uniqExact", ([value]) => `count(DISTINCT ${value})`],
  ["uniq", ([value]) => `count(DISTINCT ${value})`],
  ["countIf", ([condition]) => `count(CASE WHEN ${condition} THEN 1 END)`],
  ["count", (args) => (args.length === 0 ? "count(*)" : `count(${args.join(", ")})`)],
  ["toDateTime", ([value]) => `(${value})`],
  ["toUInt32", ([value]) => `(${value})`],
  ["intDiv", ([left, right]) => `(${left} / ${right})`],
  ["upperUTF8", ([value]) => `upper(${value})`],
  ["startsWith", ([value, prefix]) => `(substr(${value}, 1, length(${prefix})) = ${prefix})`],
  ["concat", (args) => `(${args.join(" || ")})`],
  ["ifNull", ([value, fallback]) => `ifnull(${value}, ${fallback})`],
  ["any", ([value]) => `min(${value})`],
];

function translateCalls(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    // Copied whole: 'count()' in a literal is data. An escaped quote ('') rejoins the literal.
    if (sql[i] === "'") {
      const close = sql.indexOf("'", i + 1);
      const end = close === -1 ? sql.length : close + 1;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    let matched = false;
    for (const [name, rewrite] of FUNCTIONS) {
      if (!sql.startsWith(name, i) || /[\w]/.test(sql[i - 1] ?? "")) continue;
      let open = i + name.length;
      while (sql[open] === " ") open++;
      if (sql[open] !== "(") continue;
      const { args, end } = callArguments(sql, open);
      out += rewrite(args.map(translateCalls));
      i = end;
      matched = true;
      break;
    }
    if (!matched) out += sql[i++];
  }
  return out;
}

export function translateClickHouseSql(
  query: string,
  params: Record<string, unknown>,
): { sql: string; bindings: Record<string, string | number | null> } {
  const bindings: Record<string, string | number | null> = {};
  const withPlaceholders = query.replace(/\{(\w+):[\w()]+\}/g, (_whole, name: string) => {
    const value = params[name];
    bindings[`$${name}`] =
      typeof value === "boolean" ? (value ? 1 : 0) : ((value as string | number | null) ?? null);
    return `$${name}`;
  });
  // SQLite's LIKE is already case-insensitive for ASCII.
  const sql = translateCalls(withPlaceholders).replace(/\bILIKE\b/g, "LIKE");
  return { sql, bindings };
}
