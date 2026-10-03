/**
 * Caddy's access log, turned into analytics rows. On the agent because the log is a file on this
 * host; the offset lives in the agent's SQLite and the rows are relayed to the controller.
 */
import { existsSync, statSync } from "node:fs";
import maxmind, { type CountryResponse } from "maxmind";
import { type TrafficEventRow, UPSTREAM_ERROR_STATUSES, type UpstreamErrorRow } from "@cpm/shared";
import type { AgentStore } from "../db";
import {
  analyticsEnabled,
  relayTrafficEvents,
  relayUpstreamErrors,
  upstreamErrorsEnabled,
} from "./relay";
import { readLines as readLinesFrom } from "./log-read";
import { accessLogPath, geoipCountryDb } from "./paths";

const LOG_FILE = accessLogPath();
const BATCH_SIZE = 500;

let store: AgentStore | null = null;

export function bindStore(next: AgentStore): void {
  store = next;
}

/** The controller has no way to see this. */
export function accessLogPresent(): boolean {
  return existsSync(LOG_FILE);
}

let geoReader: Awaited<ReturnType<typeof maxmind.open<CountryResponse>>> | null = null;
const geoCache = new Map<string, string | null>();

let stopped = false;

// ── state helpers ────────────────────────────────────────────────────────────

async function getState(key: string): Promise<string | null> {
  return store?.parseState(key) ?? null;
}

async function setState(key: string, value: string): Promise<void> {
  store?.setParseState(key, value);
}

// ── GeoIP ────────────────────────────────────────────────────────────────────

async function initGeoIP(): Promise<void> {
  const database = geoipCountryDb();
  if (!existsSync(database)) {
    console.log("[log-parser] GeoIP database not found, country codes will be null");
    return;
  }
  try {
    geoReader = await maxmind.open<CountryResponse>(database);
    console.log("[log-parser] GeoIP database loaded");
  } catch (err) {
    console.warn("[log-parser] Failed to load GeoIP database:", err);
  }
}

function lookupCountry(ip: string): string | null {
  if (!geoReader) return null;
  if (geoCache.has(ip)) return geoCache.get(ip)!;
  if (geoCache.size > 10_000) geoCache.clear();
  try {
    const result = geoReader.get(ip);
    const code = result?.country?.iso_code ?? null;
    geoCache.set(ip, code);
    return code;
  } catch {
    geoCache.set(ip, null);
    return null;
  }
}

// ── log parsing ──────────────────────────────────────────────────────────────

interface CaddyLogEntry {
  ts?: number;
  msg?: string;
  plugin?: string;
  // fields on "request blocked" entries (top-level)
  client_ip?: string;
  method?: string;
  uri?: string;
  // fields on "handled request" entries
  status?: number;
  size?: number;
  request?: {
    client_ip?: string;
    remote_ip?: string;
    host?: string;
    method?: string;
    uri?: string;
    proto?: string;
    headers?: Record<string, string[]>;
  };
}

type BlockedSignatures = Set<string> | Map<string, number>;

function consumeBlockedSignature(blocked: BlockedSignatures, key: string): boolean {
  if (blocked instanceof Map) {
    const count = blocked.get(key) ?? 0;
    if (count <= 0) return false;
    if (count === 1) blocked.delete(key);
    else blocked.set(key, count - 1);
    return true;
  }
  return blocked.has(key);
}

const BLOCKED_CARRYOVER_WINDOW_SEC = 120;

// "request blocked" is logged just before its "handled request", so a parse pass can end between
// them; unmatched signatures carry into the next pass.
let pendingBlocked: Map<string, number> = new Map();

// Marks blocked rows by signature, not status 403, which upstreams send too.
export function collectBlockedSignatures(
  lines: string[],
  into?: Map<string, number>,
): Map<string, number> {
  const blocked = into ?? new Map<string, number>();
  for (const line of lines) {
    // Cheap prefilter: parseLine parses every line anyway, and Caddy never escapes message letters.
    if (!line.includes("request blocked")) continue;
    let entry: CaddyLogEntry;
    try {
      entry = JSON.parse(line.trim());
    } catch {
      continue;
    }
    if (entry.msg !== "request blocked" || entry.plugin !== "caddy-blocker") continue;
    const ts = Math.floor(entry.ts ?? 0);
    const key = `${ts}|${entry.client_ip ?? ""}|${entry.method ?? ""}|${entry.uri ?? ""}`;
    blocked.set(key, (blocked.get(key) ?? 0) + 1);
  }
  return blocked;
}

// Bounds the pending map when a block never gets its "handled request" row.
export function pruneBlockedSignatures(
  blocked: Map<string, number>,
  refTs: number,
): Map<string, number> {
  const cutoff = refTs - BLOCKED_CARRYOVER_WINDOW_SEC;
  for (const [key, count] of blocked) {
    if (count <= 0) {
      blocked.delete(key);
      continue;
    }
    const ts = Number(key.slice(0, key.indexOf("|")));
    if (Number.isFinite(ts) && ts < cutoff) blocked.delete(key);
  }
  return blocked;
}

export function parseLine(line: string, blocked: BlockedSignatures): TrafficEventRow | null {
  let entry: CaddyLogEntry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }

  if (entry.msg !== "handled request") return null;

  const req = entry.request ?? {};
  const clientIp = req.client_ip || req.remote_ip || "";
  const ts = Math.floor(entry.ts ?? Date.now() / 1000);
  const method = req.method ?? "";
  const uri = req.uri ?? "";
  const status = entry.status ?? 0;

  const key = `${ts}|${clientIp}|${method}|${uri}`;

  return {
    ts,
    client_ip: clientIp,
    country_code: clientIp ? lookupCountry(clientIp) : null,
    host: req.host ?? "",
    method,
    uri,
    status,
    proto: req.proto ?? "",
    bytes_sent: entry.size ?? 0,
    user_agent: req.headers?.["User-Agent"]?.[0] ?? "",
    is_blocked: consumeBlockedSignature(blocked, key),
  };
}

// Lives in ./log-read, which waf-log-parser shares; callers and tests import it from here.
export async function readLines(
  startOffset: number,
  file: string = LOG_FILE,
): Promise<{ lines: string[]; newOffset: number }> {
  return readLinesFrom(startOffset, file);
}

/** Per host, status and minute: a flood of errors is a handful of rows, and no request leaves. */
export function countUpstreamErrors(rows: readonly TrafficEventRow[]): UpstreamErrorRow[] {
  const counts = new Map<string, UpstreamErrorRow>();
  for (const row of rows) {
    if (!(UPSTREAM_ERROR_STATUSES as readonly number[]).includes(row.status) || !row.host) continue;
    const minute = Math.floor(row.ts / 60) * 60;
    const key = `${minute}|${row.status}|${row.host}`;
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { minute, host: row.host, status: row.status, count: 1 });
  }
  return [...counts.values()];
}

async function insertBatch(rows: TrafficEventRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await relayTrafficEvents(rows.slice(i, i + BATCH_SIZE));
  }
}

// ── public API ───────────────────────────────────────────────────────────────

export async function initLogParser(): Promise<void> {
  stopped = false;
  await initGeoIP();
  console.log("[log-parser] initialized");
}

export async function parseNewLogEntries(): Promise<void> {
  if (stopped) return;
  if (!existsSync(LOG_FILE)) return;

  try {
    const storedOffset = parseInt((await getState("access_log_offset")) ?? "0", 10);
    const storedSize = parseInt((await getState("access_log_size")) ?? "0", 10);

    let currentSize: number;
    try {
      currentSize = statSync(LOG_FILE).size;
    } catch {
      return;
    }

    // A shrunk file was rotated.
    const startOffset = currentSize < storedSize ? 0 : storedOffset;

    const { lines, newOffset } = await readLines(startOffset);

    if (lines.length > 0) {
      const blocked = collectBlockedSignatures(lines, pendingBlocked);
      const rows = lines.map((l) => parseLine(l, blocked)).filter((r) => r !== null);
      if (analyticsEnabled()) await insertBatch(rows);
      // After the rows: a refused batch is read again next pass, and would be counted twice.
      if (upstreamErrorsEnabled()) {
        await relayUpstreamErrors(countUpstreamErrors(rows)).catch((error: unknown) => {
          console.warn("[log-parser] could not relay upstream error counts:", error);
        });
      }
      // A loop, not Math.max(...spread): a large backlog would overflow the argument list.
      let latestTs = rows.length ? -Infinity : Math.floor(Date.now() / 1000);
      let blockedRows = 0;
      for (const r of rows) {
        if (r.ts > latestTs) latestTs = r.ts;
        if (r.is_blocked) blockedRows++;
      }
      pendingBlocked = pruneBlockedSignatures(blocked, latestTs);
      if (analyticsEnabled()) {
        console.log(`[log-parser] inserted ${rows.length} traffic events (${blockedRows} blocked)`);
      }
    }

    await setState("access_log_offset", String(newOffset));
    await setState("access_log_size", String(currentSize));
  } catch (err) {
    console.error("[log-parser] error during parse:", err);
  }
}

export function stopLogParser(): void {
  stopped = true;
}
