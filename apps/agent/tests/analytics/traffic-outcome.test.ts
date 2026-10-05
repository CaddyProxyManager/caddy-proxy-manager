/** The outcome marker and duration the config's access log carries, read into a traffic row. */
import { describe, expect, it } from "bun:test";
import { durationMs, parseLine, requestOutcome } from "../../src/analytics/log-parser";

const NOW = Math.floor(Date.now() / 1000);

function handled(extra: Record<string, unknown>): string {
  return JSON.stringify({
    ts: NOW,
    msg: "handled request",
    status: 403,
    size: 9,
    request: { client_ip: "198.51.100.7", host: "app.example.com", method: "GET", uri: "/" },
    ...extra,
  });
}

describe("requestOutcome", () => {
  it("takes the gate the config marked", () => {
    expect(requestOutcome("waf", false)).toBe("waf");
    expect(requestOutcome("rate_limit", false)).toBe("rate_limit");
    expect(requestOutcome("served", true)).toBe("served");
  });

  it("falls back to the blocker's own line, then served, without a marker", () => {
    expect(requestOutcome(undefined, true)).toBe("geo");
    expect(requestOutcome(null, false)).toBe("served");
  });

  it("ignores a marker it does not know", () => {
    expect(requestOutcome("teapot", false)).toBe("served");
    expect(requestOutcome(7, true)).toBe("geo");
  });
});

describe("durationMs", () => {
  it("rounds Caddy's seconds to whole milliseconds", () => {
    expect(durationMs(0.0123)).toBe(12);
    expect(durationMs(1.5)).toBe(1500);
    expect(durationMs(0)).toBe(0);
  });

  it("is null for anything that is not a duration", () => {
    expect(durationMs(undefined)).toBeNull();
    expect(durationMs(-1)).toBeNull();
    expect(durationMs("0.2")).toBeNull();
    expect(durationMs(Number.NaN)).toBeNull();
  });

  it("caps at what the controller's column holds", () => {
    expect(durationMs(1e12)).toBe(4_294_967_295);
  });
});

describe("parseLine", () => {
  it("carries the marker and the duration into the row", () => {
    const row = parseLine(handled({ duration: 0.25, cpm_outcome: "auth" }), new Set());
    expect(row?.outcome).toBe("auth");
    expect(row?.duration_ms).toBe(250);
  });

  it("reads a row without either as served with no duration", () => {
    const row = parseLine(handled({}), new Set());
    expect(row?.outcome).toBe("served");
    expect(row?.duration_ms).toBeNull();
  });

  it("has no ASN without the ASN database", () => {
    const row = parseLine(handled({}), new Set());
    expect(row?.asn).toBeNull();
    expect(row?.asn_org).toBeNull();
  });
});
