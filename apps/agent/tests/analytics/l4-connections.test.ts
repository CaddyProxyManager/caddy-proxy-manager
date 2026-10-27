/**
 * caddy-l4's connection log: one row per closed connection, relayed only while the controller
 * asks for it, and read again after a refusal rather than lost.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControllerClient } from "../../src/controller-client";
import type { AgentStore } from "../../src/db";

const dir = mkdtempSync(join(tmpdir(), "cpm-l4-connections-"));
// The L4 log sits beside the access log.
process.env.CADDY_ACCESS_LOG = join(dir, "access.log");
const logFile = join(dir, "l4-connections.log");

const { bindStore, initL4LogParser, parseL4Line, parseNewL4LogEntries, splitAddress } =
  await import("../../src/analytics/l4-log-parser");
const { configureAnalytics, l4ConnectionsEnabled } = await import("../../src/analytics/relay");

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

function stats(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    level: "debug",
    ts: 1790000000.5,
    logger: "layer4",
    msg: "stopped handling connection; connection stats",
    network: "tcp",
    local: "172.18.0.5:5432",
    remote: "203.0.113.9:51234",
    read: 1200,
    written: 34000,
    duration: 1.5,
    ...overrides,
  });
}

beforeEach(async () => {
  calls = [];
  refuse = false;
  state.clear();
  writeFileSync(logFile, "");
  await initL4LogParser();
});

afterEach(() => {
  configureAnalytics(null);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("splitAddress", () => {
  it("splits IPv4 and bracketed IPv6", () => {
    expect(splitAddress("203.0.113.9:51234")).toEqual({ host: "203.0.113.9", port: 51234 });
    expect(splitAddress("[2001:db8::1]:443")).toEqual({ host: "2001:db8::1", port: 443 });
    expect(splitAddress("203.0.113.9")).toBeNull();
    expect(splitAddress("203.0.113.9:70000")).toBeNull();
  });
});

describe("parseL4Line", () => {
  it("reads a closed connection's stats", () => {
    expect(parseL4Line(stats(), () => "NL")).toEqual({
      ts: 1790000000,
      network: "tcp",
      port: 5432,
      client_ip: "203.0.113.9",
      country_code: "NL",
      bytes_in: 1200,
      bytes_out: 34000,
      duration_ms: 1500,
    });
  });

  it("takes the family off the socket's network name", () => {
    expect(parseL4Line(stats({ network: "udp6", remote: "[2001:db8::7]:5000" }))).toMatchObject({
      network: "udp",
      client_ip: "2001:db8::7",
    });
  });

  it("ignores everything else the logger writes", () => {
    expect(parseL4Line(stats({ msg: "started handling connection" }))).toBeNull();
    expect(parseL4Line(stats({ network: "unix" }))).toBeNull();
    expect(parseL4Line(stats({ local: "nowhere" }))).toBeNull();
    expect(parseL4Line("not json")).toBeNull();
  });
});

describe("parseNewL4LogEntries", () => {
  it("relays nothing while the controller has not asked", async () => {
    appendFileSync(logFile, `${stats()}\n`);
    configureAnalytics({ client, secret: "s" }, { analytics: true, upstreamErrors: false });
    expect(l4ConnectionsEnabled()).toBe(false);
    await parseNewL4LogEntries();
    expect(calls).toEqual([]);
  });

  it("relays each connection once, and re-reads a refused batch", async () => {
    configureAnalytics(
      { client, secret: "s" },
      { analytics: false, upstreamErrors: false, l4Connections: true },
    );
    appendFileSync(logFile, `${stats({ msg: "started handling connection" })}\n${stats()}\n`);
    refuse = true;
    await parseNewL4LogEntries();
    expect(calls).toEqual([]);

    refuse = false;
    await parseNewL4LogEntries();
    expect(calls.map((c) => [c.kind, c.rows.length])).toEqual([["l4", 1]]);

    await parseNewL4LogEntries();
    expect(calls).toHaveLength(1);
  });
});
