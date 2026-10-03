/**
 * Upstream error counts for the controller's notification: read off the access log with analytics
 * off, relayed as counts per host and minute, and never counted twice.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrafficEventRow } from "@cpm/shared";
import type { ControllerClient } from "../src/controller-client";
import type { AgentStore } from "../src/db";

const dir = mkdtempSync(join(tmpdir(), "cpm-upstream-errors-"));
const logFile = join(dir, "access.log");
// Before the import: the parser reads its path once.
process.env.CADDY_ACCESS_LOG = logFile;

const { countUpstreamErrors, bindStore, initLogParser, parseNewLogEntries } = await import(
  "../src/analytics/log-parser"
);
const { analyticsEnabled, configureAnalytics, relayTrafficEvents, upstreamErrorsEnabled } =
  await import("../src/analytics/relay");

type Call = { kind: string; rows: readonly unknown[] };
let calls: Call[] = [];
let refuse = false;
const client = {
  controllerUrl: "http://controller:3000",
  postAnalytics: async (_secret: string, kind: string, rows: readonly unknown[]) => {
    if (refuse) throw new Error("refused");
    calls.push({ kind, rows });
    return { accepted: rows.length, rejected: 0 };
  },
} as unknown as ControllerClient;

const state = new Map<string, string>();
bindStore({
  parseState: (key: string) => state.get(key) ?? null,
  setParseState: (key: string, value: string) => void state.set(key, value),
} as unknown as AgentStore);

function line(host: string, status: number, ts: number): string {
  return JSON.stringify({
    ts,
    msg: "handled request",
    status,
    size: 0,
    request: { client_ip: "203.0.113.9", host, method: "GET", uri: "/", proto: "HTTP/1.1" },
  });
}

function row(host: string, status: number, ts: number): TrafficEventRow {
  return {
    ts,
    client_ip: "203.0.113.9",
    country_code: null,
    host,
    method: "GET",
    uri: "/",
    status,
    proto: "HTTP/1.1",
    bytes_sent: 0,
    user_agent: "",
    is_blocked: false,
  };
}

beforeEach(async () => {
  calls = [];
  refuse = false;
  state.clear();
  writeFileSync(logFile, "");
  await initLogParser();
});

afterEach(() => {
  configureAnalytics(null);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("countUpstreamErrors", () => {
  it("counts 502, 503 and 504 per host, status and minute, and nothing else", () => {
    const counts = countUpstreamErrors([
      row("app.example.com", 502, 1_000_020),
      row("app.example.com", 502, 1_000_050),
      row("app.example.com", 502, 1_000_090),
      row("app.example.com", 503, 1_000_021),
      row("api.example.com", 504, 1_000_022),
      row("app.example.com", 500, 1_000_023),
      row("app.example.com", 200, 1_000_024),
      row("", 502, 1_000_025),
    ]);
    expect(counts).toEqual([
      { minute: 1_000_020, host: "app.example.com", status: 502, count: 2 },
      { minute: 1_000_080, host: "app.example.com", status: 502, count: 1 },
      { minute: 1_000_020, host: "app.example.com", status: 503, count: 1 },
      { minute: 1_000_020, host: "api.example.com", status: 504, count: 1 },
    ]);
  });
});

describe("the access log with analytics off", () => {
  it("relays only the counts, and keeps its place", async () => {
    configureAnalytics({ client, secret: "s" }, { analytics: false, upstreamErrors: true });
    expect(analyticsEnabled()).toBe(false);
    expect(upstreamErrorsEnabled()).toBe(true);

    appendFileSync(logFile, `${line("app.example.com", 502, 1_000_000)}\n`);
    appendFileSync(logFile, `${line("app.example.com", 200, 1_000_001)}\n`);
    await parseNewLogEntries();
    appendFileSync(logFile, `${line("app.example.com", 502, 1_000_002)}\n`);
    await parseNewLogEntries();

    expect(calls).toEqual([
      {
        kind: "upstream-errors",
        rows: [{ minute: 999_960, host: "app.example.com", status: 502, count: 1 }],
      },
      {
        kind: "upstream-errors",
        rows: [{ minute: 999_960, host: "app.example.com", status: 502, count: 1 }],
      },
    ]);
    // Traffic rows are not the controller's to receive with analytics off.
    await relayTrafficEvents([row("app.example.com", 502, 1)]);
    expect(calls).toHaveLength(2);
  });

  it("moves on past a refused count rather than stalling the log", async () => {
    configureAnalytics({ client, secret: "s" }, { analytics: false, upstreamErrors: true });
    refuse = true;
    appendFileSync(logFile, `${line("app.example.com", 502, 1_000_000)}\n`);
    await parseNewLogEntries();
    refuse = false;
    await parseNewLogEntries();
    expect(calls).toEqual([]);
  });
});

describe("the access log with both on", () => {
  it("relays the rows, then the counts", async () => {
    configureAnalytics({ client, secret: "s" }, { analytics: true, upstreamErrors: true });
    appendFileSync(logFile, `${line("app.example.com", 504, 1_000_000)}\n`);
    await parseNewLogEntries();
    expect(calls.map((call) => call.kind)).toEqual(["traffic", "upstream-errors"]);
  });

  it("sends no counts to a controller that did not ask", async () => {
    configureAnalytics({ client, secret: "s" });
    appendFileSync(logFile, `${line("app.example.com", 504, 1_000_000)}\n`);
    await parseNewLogEntries();
    expect(calls.map((call) => call.kind)).toEqual(["traffic"]);
  });
});
