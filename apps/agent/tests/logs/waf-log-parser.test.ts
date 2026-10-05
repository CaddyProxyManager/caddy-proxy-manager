import { describe, it, expect } from "bun:test";
import {
  extractBracketField,
  parseLine,
  ruleInfoFromAuditEntry,
} from "../../src/analytics/waf-log-parser";

/**
 * Regression (#233): attribution comes from the entry's `messages` (part H); the waf-rules.log join
 * misses across a 30s tick. Each test passes an EMPTY ruleMap to simulate that.
 */
describe("rule attribution from the audit entry itself", () => {
  const CRS_XSS =
    '[client "1.2.3.4"] Coraza: Warning. XSS Attack Detected ' +
    '[file "@owasp_crs/REQUEST-941-APPLICATION-ATTACK-XSS.conf"] [line "123"] ' +
    '[id "941100"] [rev ""] [msg "XSS Attack Detected"] [severity "CRITICAL"] ' +
    '[unique_id "tx-xss"]';
  const CRS_ANOMALY =
    '[client "1.2.3.4"] Coraza: Access denied (phase 2). Inbound Anomaly Score Exceeded ' +
    '[file "@owasp_crs/REQUEST-949-BLOCKING-EVALUATION.conf"] [line "7663"] ' +
    '[id "949110"] [msg "Inbound Anomaly Score Exceeded"] [severity "CRITICAL"] ' +
    '[unique_id "tx-xss"]';

  function auditLine(opts: { interrupted: boolean; messages?: unknown[] }): string {
    return JSON.stringify({
      transaction: {
        id: "tx-xss",
        client_ip: "1.2.3.4",
        unix_timestamp: 1_700_000_000_000_000_000,
        is_interrupted: opts.interrupted,
        request: { method: "GET", uri: "/?q=<script>", headers: { host: ["example.com"] } },
      },
      ...(opts.messages ? { messages: opts.messages } : {}),
    });
  }

  it("keeps a detected-but-not-blocked event when the rules-log join misses", () => {
    const row = parseLine(
      auditLine({ interrupted: false, messages: [{ error_message: CRS_XSS }] }),
      new Map(),
    );

    expect(row).not.toBeNull();
    expect(row?.blocked).toBe(false);
    expect(row?.rule_id).toBe(941100);
    expect(row?.rule_message).toBe("XSS Attack Detected");
    expect(row?.severity).toBe("CRITICAL");
  });

  it("attributes a blocked event to the attack rule, not the anomaly evaluation rule", () => {
    const row = parseLine(
      auditLine({
        interrupted: true,
        messages: [{ error_message: CRS_XSS }, { error_message: CRS_ANOMALY }],
      }),
      new Map(),
    );

    expect(row?.rule_id).toBe(941100);
  });

  it("skips a leading anomaly-evaluation rule to find the real attack rule", () => {
    const row = parseLine(
      auditLine({
        interrupted: true,
        messages: [{ error_message: CRS_ANOMALY }, { error_message: CRS_XSS }],
      }),
      new Map(),
    );

    expect(row?.rule_id).toBe(941100);
  });

  it("still drops audit entries with no rule match and no interruption", () => {
    // Coraza logs every 4xx/5xx even when no rule fired.
    expect(parseLine(auditLine({ interrupted: false }), new Map())).toBeNull();
  });

  it("falls back to the rules-log join when Coraza emits no messages", () => {
    const ruleMap = new Map([
      ["tx-xss", { ruleId: 941100, ruleMessage: "XSS Attack Detected", severity: "CRITICAL" }],
    ]);
    const row = parseLine(auditLine({ interrupted: false }), ruleMap);

    expect(row?.rule_id).toBe(941100);
  });

  it("reads the legacy `message` field when `error_message` is absent", () => {
    expect(ruleInfoFromAuditEntry({ messages: [{ message: CRS_XSS }] })?.ruleId).toBe(941100);
  });

  it("returns null when the entry has no messages", () => {
    expect(ruleInfoFromAuditEntry({})).toBeNull();
  });
});

describe("extractBracketField", () => {
  it('extracts id from [id "941100"]', () => {
    expect(extractBracketField('[id "941100"]', "id")).toBe("941100");
  });

  it('extracts msg from [msg "XSS Attack Detected"]', () => {
    expect(extractBracketField('[msg "XSS Attack Detected"]', "msg")).toBe("XSS Attack Detected");
  });

  it('extracts severity from [severity "critical"]', () => {
    expect(extractBracketField('[severity "critical"]', "severity")).toBe("critical");
  });

  it('extracts unique_id from [unique_id "abc123"]', () => {
    expect(extractBracketField('[unique_id "abc123"]', "unique_id")).toBe("abc123");
  });

  it("returns null for field not present", () => {
    expect(extractBracketField('[msg "something"]', "id")).toBeNull();
  });

  it("works when multiple fields are present in one string", () => {
    const msg = '[id "941100"] [msg "XSS Attack"] [severity "critical"] [unique_id "abc123"]';
    expect(extractBracketField(msg, "id")).toBe("941100");
    expect(extractBracketField(msg, "msg")).toBe("XSS Attack");
    expect(extractBracketField(msg, "severity")).toBe("critical");
    expect(extractBracketField(msg, "unique_id")).toBe("abc123");
  });

  it("handles special characters in field values", () => {
    const msg = '[msg "SQL Injection: SELECT * FROM users WHERE id=1"]';
    expect(extractBracketField(msg, "msg")).toBe("SQL Injection: SELECT * FROM users WHERE id=1");
  });

  it("returns null for empty string input", () => {
    expect(extractBracketField("", "id")).toBeNull();
  });
});

describe("parseLine host header contract", () => {
  const ruleMap = new Map([["tx-1", { ruleId: 941100, ruleMessage: "XSS", severity: "critical" }]]);

  function makeAuditLine(hostHeader: string): string {
    return JSON.stringify({
      transaction: {
        id: "tx-1",
        client_ip: "1.2.3.4",
        unix_timestamp: 1_700_000_000_000_000_000,
        is_interrupted: true,
        request: {
          method: "GET",
          uri: "/",
          headers: { host: [hostHeader] },
        },
      },
    });
  }

  it("stores host header verbatim - bare hostname has no port", () => {
    const row = parseLine(makeAuditLine("example.com"), ruleMap);
    expect(row?.host).toBe("example.com");
  });

  it("stores host header verbatim - port suffix is preserved (downstream must strip)", () => {
    // Some clients include the port; suppression in settings/actions.ts must normalize it.
    const row = parseLine(makeAuditLine("app.example.com:443"), ruleMap);
    expect(row?.host).toBe("app.example.com:443");
  });

  it("handles missing host header without throwing", () => {
    const line = JSON.stringify({
      transaction: {
        id: "tx-1",
        client_ip: "1.2.3.4",
        unix_timestamp: 1_700_000_000_000_000_000,
        is_interrupted: true,
        request: { method: "GET", uri: "/", headers: {} },
      },
    });
    const row = parseLine(line, ruleMap);
    expect(row?.host).toBe("");
  });
});
