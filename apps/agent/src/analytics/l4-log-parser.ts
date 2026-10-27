/**
 * caddy-l4's connection log, turned into one row per connection. caddy-l4 has no access log, only
 * a debug line as each connection closes, so the controller asks Caddy for that logger alone.
 */
import { existsSync, statSync } from "node:fs";
import type { L4ConnectionRow } from "@cpm/shared";
import type { AgentStore } from "../db";
import { ensureGeoIP, lookupCountry } from "./log-parser";
import { readLines } from "./log-read";
import { l4ConnectionLogPath } from "./paths";
import { relayL4Connections } from "./relay";

const BATCH_SIZE = 500;
const STATS_MESSAGE = "stopped handling connection; connection stats";

let store: AgentStore | null = null;
let stopped = false;

export function bindStore(next: AgentStore): void {
  store = next;
}

/** `host:port` or `[v6]:port`. Null without a port. */
export function splitAddress(address: string): { host: string; port: number } | null {
  const match = /^\[?([^\]]*?)\]?:(\d{1,5})$/.exec(address.trim());
  if (!match) return null;
  const port = Number(match[2]);
  return match[1] && port <= 65_535 ? { host: match[1], port } : null;
}

type Entry = {
  ts?: unknown;
  logger?: unknown;
  msg?: unknown;
  network?: unknown;
  local?: unknown;
  remote?: unknown;
  read?: unknown;
  written?: unknown;
  /** Seconds, fractional: Caddy's encoder. */
  duration?: unknown;
};

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;

/** Null for anything but a closed connection's stats, which is most of what the logger writes. */
export function parseL4Line(
  line: string,
  country: (ip: string) => string | null = () => null,
): L4ConnectionRow | null {
  if (!line.includes(STATS_MESSAGE)) return null;
  let entry: Entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (entry.msg !== STATS_MESSAGE || typeof entry.ts !== "number") return null;
  // Caddy names a socket by its family: tcp4, udp6...
  const network = typeof entry.network === "string" ? entry.network.slice(0, 3) : "";
  if (network !== "tcp" && network !== "udp") return null;
  const local = typeof entry.local === "string" ? splitAddress(entry.local) : null;
  const remote = typeof entry.remote === "string" ? splitAddress(entry.remote) : null;
  if (!local || !remote) return null;
  return {
    ts: Math.floor(entry.ts),
    network,
    port: local.port,
    client_ip: remote.host,
    country_code: country(remote.host),
    bytes_in: count(entry.read),
    bytes_out: count(entry.written),
    duration_ms: count(typeof entry.duration === "number" ? entry.duration * 1000 : 0),
  };
}

export async function initL4LogParser(): Promise<void> {
  stopped = false;
  await ensureGeoIP();
  console.log("[l4-log-parser] initialized");
}

export async function parseNewL4LogEntries(): Promise<void> {
  const file = l4ConnectionLogPath();
  if (stopped || !store || !existsSync(file)) return;
  try {
    const storedOffset = Number.parseInt(store.parseState("l4_log_offset") ?? "0", 10);
    const storedSize = Number.parseInt(store.parseState("l4_log_size") ?? "0", 10);
    const currentSize = statSync(file).size;
    // A shrunk file was rotated.
    const startOffset = currentSize < storedSize ? 0 : storedOffset;
    const { lines, newOffset } = await readLines(startOffset, file);
    const rows = lines.map((line) => parseL4Line(line, lookupCountry)).filter((r) => r !== null);
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      await relayL4Connections(rows.slice(i, i + BATCH_SIZE));
    }
    if (rows.length > 0) console.log(`[l4-log-parser] relayed ${rows.length} connections`);
    store.setParseState("l4_log_offset", String(newOffset));
    store.setParseState("l4_log_size", String(currentSize));
  } catch (err) {
    console.error("[l4-log-parser] error during parse:", err);
  }
}

export function stopL4LogParser(): void {
  stopped = true;
}
