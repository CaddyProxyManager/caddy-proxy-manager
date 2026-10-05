/**
 * Relaying parsed rows. The parser advances only when a relay resolves, so a refusal must
 * propagate and an oversized batch must be split rather than refused every pass forever.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { MAX_ANALYTICS_REQUEST_BYTES, type TrafficEventRow } from "@cpm/shared";
import {
  analyticsEnabled,
  chunkBySize,
  configureAnalytics,
  relayTrafficEvents,
  relayWafEvents,
} from "../../src/analytics/relay";
import type { ControllerClient } from "../../src/controller-client";

function row(uri = "/"): TrafficEventRow {
  return {
    ts: 1_757_000_000,
    client_ip: "203.0.113.9",
    country_code: null,
    host: "example.com",
    method: "GET",
    uri,
    status: 200,
    proto: "HTTP/2.0",
    bytes_sent: 10,
    user_agent: "test",
    is_blocked: false,
  };
}

type Call = { secret: string; kind: string; rows: readonly unknown[] };

function fakeController(post?: (rows: readonly unknown[]) => Promise<unknown>) {
  const calls: Call[] = [];
  const client = {
    controllerUrl: "http://controller:3000",
    postAnalytics: async (secret: string, kind: string, rows: readonly unknown[]) => {
      calls.push({ secret, kind, rows });
      return post ? post(rows) : { accepted: rows.length, rejected: 0 };
    },
  } as unknown as ControllerClient;
  return { client, calls };
}

afterEach(() => {
  configureAnalytics(null);
});

describe("chunkBySize", () => {
  it("keeps rows in order and every chunk under the limit", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`/${i}`));
    const size = Buffer.byteLength(JSON.stringify(rows[0])) + 1;

    const { chunks, oversized } = chunkBySize(rows, size * 3);

    expect(chunks.map((chunk) => chunk.length)).toEqual([3, 3, 3, 1]);
    expect(chunks.flat()).toEqual(rows);
    expect(oversized).toBe(0);
  });

  it("drops a row that could never fit rather than refusing the batch forever", () => {
    const { chunks, oversized } = chunkBySize([row(), row("x".repeat(1000)), row()], 400);

    expect(oversized).toBe(1);
    expect(chunks.flat()).toHaveLength(2);
  });
});

describe("relaying", () => {
  it("does nothing while the controller has analytics off", async () => {
    expect(analyticsEnabled()).toBe(false);
    await relayTrafficEvents([row()]);
  });

  it("sends each kind signed with the pairing secret", async () => {
    const { client, calls } = fakeController();
    configureAnalytics({ client, secret: "s3cret" });

    await relayTrafficEvents([row()]);
    await relayWafEvents([]);

    expect(analyticsEnabled()).toBe(true);
    expect(calls).toEqual([{ secret: "s3cret", kind: "traffic", rows: [row()] }]);
  });

  it("splits a batch too large for one request", async () => {
    const { client, calls } = fakeController();
    configureAnalytics({ client, secret: "s3cret" });
    const rows = Array.from({ length: 12 }, () => row("x".repeat(1024 * 1024)));

    await relayTrafficEvents(rows);

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.flatMap((call) => call.rows)).toHaveLength(12);
    for (const call of calls) {
      expect(Buffer.byteLength(JSON.stringify(call.rows))).toBeLessThan(
        MAX_ANALYTICS_REQUEST_BYTES,
      );
    }
  });

  it("lets a refusal through, so the parser keeps its place and sends the rows again", async () => {
    const { client } = fakeController(async () => {
      throw new Error("Analytics are switched off.");
    });
    configureAnalytics({ client, secret: "s3cret" });

    await expect(relayTrafficEvents([row()])).rejects.toThrow(/switched off/);
  });
});
