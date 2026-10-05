/**
 * Coraza's audit log records headers and the matched values verbatim, and a stored WAF event must
 * not keep the session cookies, tokens and passwords that pass through it.
 */
import { describe, expect, it } from "bun:test";
import { redactAuditEntry } from "@cpm/shared";
import { extractBracketField, parseLine } from "../../src/analytics/waf-log-parser";

describe("stored WAF event redaction", () => {
  const line = JSON.stringify({
    transaction: {
      id: "tx-cred",
      client_ip: "1.2.3.4",
      unix_timestamp: 1_700_000_000_000_000_000,
      is_interrupted: true,
      request: {
        method: "GET",
        uri: "/?q=<script>",
        headers: {
          host: ["example.com"],
          cookie: ["_cpm_fa=session-secret; other=1"],
          Authorization: ["Bearer api-secret"],
          "user-agent": ["curl/8"],
        },
      },
      response: { status: 403, headers: { "Set-Cookie": ["sid=response-secret"] } },
    },
    messages: [{ error_message: '[id "941100"] [msg "XSS"] [severity "CRITICAL"]' }],
  });

  it("replaces credential header values but keeps the rest of the entry", () => {
    const row = parseLine(line, new Map());
    expect(row).not.toBeNull();
    expect(row?.raw_data).not.toMatch(/session-secret|api-secret|response-secret/);
    const stored = JSON.parse(row?.raw_data ?? "{}");
    expect(stored.transaction.request.headers.cookie).toEqual(["[redacted]"]);
    expect(stored.transaction.request.headers.Authorization).toEqual(["[redacted]"]);
    expect(stored.transaction.response.headers["Set-Cookie"]).toEqual(["[redacted]"]);
    expect(stored.transaction.request.headers["user-agent"]).toEqual(["curl/8"]);
    expect(stored.transaction.request.uri).toBe("/?q=<script>");
  });

  it("does not mutate the parsed input", () => {
    const entry = JSON.parse(line);
    redactAuditEntry(entry);
    expect(entry.transaction.request.headers.cookie).toEqual(["_cpm_fa=session-secret; other=1"]);
  });

  it("redacts the rule message from the rules-log join too", () => {
    const bare = JSON.stringify({
      transaction: {
        id: "tx-join",
        client_ip: "1.2.3.4",
        is_interrupted: true,
        request: { method: "GET", uri: "/", headers: { cookie: ["session=JOIN-SECRET"] } },
      },
    });
    const ruleMap = new Map([
      [
        "tx-join",
        { ruleId: 990002, ruleMessage: "REQUEST_COOKIES:session=JOIN-SECRET", severity: null },
      ],
    ]);
    expect(parseLine(bare, ruleMap)?.rule_message).toBe("REQUEST_COOKIES:session=[redacted]");
  });
});

describe("stored WAF event redaction - credential names beyond the fixed header list", () => {
  function stored(uri: string, headers: Record<string, string[]>, data: string) {
    const line = JSON.stringify({
      transaction: {
        id: "tx-names",
        client_ip: "1.2.3.4",
        is_interrupted: true,
        request: { method: "POST", uri, headers: { host: ["example.com"], ...headers } },
      },
      messages: [
        { error_message: `[id "942100"] [msg "SQLi"] [data "${data}"] [severity "CRITICAL"]` },
      ],
    });
    const row = parseLine(line, new Map());
    if (!row) throw new Error("no row");
    const entry = JSON.parse(row.raw_data ?? "{}");
    return { row, entry, data: extractBracketField(entry.messages[0].error_message, "data") };
  }

  it("redacts credential query parameters in the stored URI, keeping the others", () => {
    const { row, entry } = stored(
      "/feed?q=1%27--&api_key=K1&accessToken=T1&X-Plex-Token=P1&page=2",
      {},
      "x",
    );
    const expected =
      "/feed?q=1%27--&api_key=[redacted]&accessToken=[redacted]&X-Plex-Token=[redacted]&page=2";
    expect(row.uri).toBe(expected);
    expect(entry.transaction.request.uri).toBe(expected);
    expect(row.raw_data).not.toMatch(/K1|T1|P1/);
  });

  it("redacts headers whose names contain a credential word", () => {
    const { entry } = stored(
      "/",
      { "X-Access-Token": ["T2"], "X-Gitea-Api-Key": ["K2"], accept: ["*/*"] },
      "x",
    );
    expect(entry.transaction.request.headers["X-Access-Token"]).toEqual(["[redacted]"]);
    expect(entry.transaction.request.headers["X-Gitea-Api-Key"]).toEqual(["[redacted]"]);
    expect(entry.transaction.request.headers.accept).toEqual(["*/*"]);
  });

  it("redacts form fields and query parameters with credential names that rule messages echo", () => {
    expect(
      stored("/", {}, "Matched Data: ' or 1=1 found within ARGS:password: ' or 1=1--hunter2").data,
    ).toBe("Matched Data: [redacted] found within ARGS:password: [redacted]");
    expect(stored("/", {}, "ARGS_POST:client_secret=abc--").data).toBe(
      "ARGS_POST:client_secret=[redacted]",
    );
    expect(stored("/", {}, "Matched Data: ' or 1=1 found within ARGS:q: ' or 1=1").data).toBe(
      "Matched Data: ' or 1=1 found within ARGS:q: ' or 1=1",
    );
  });

  it("redacts credential query parameters inside an echoed request URI", () => {
    expect(
      stored("/", {}, "Matched Data: union found within REQUEST_URI: /x?token=S3&q=union").data,
    ).toBe("Matched Data: union found within REQUEST_URI: /x?token=[redacted]&q=union");
  });
});

// CRS logdata echoes the matched value, so a session cookie that trips a rule reaches the message.
describe("stored WAF event redaction - rule messages", () => {
  const SQLI_ON_COOKIE =
    '[client "1.2.3.4"] Coraza: Access denied (phase 2). SQL Injection Attack Detected via libinjection ' +
    '[file "@owasp_crs/REQUEST-942-APPLICATION-ATTACK-SQLI.conf"] [line "46"] [id "942100"] [rev ""] ' +
    '[msg "SQL Injection Attack Detected via libinjection"] ' +
    '[data "Matched Data: s&sos found within REQUEST_COOKIES:session: abc\' or 1=1--COOKIE-SECRET"] ' +
    '[severity "critical"] [ver "OWASP_CRS/4.25.0"] [maturity "0"] [accuracy "0"] ' +
    '[tag "attack-sqli"] [hostname "10.0.0.1"] [uri "/"] [unique_id "tx-cookie"]';

  function lineWith(messages: unknown[]): string {
    return JSON.stringify({
      transaction: {
        id: "tx-cookie",
        client_ip: "1.2.3.4",
        is_interrupted: true,
        request: { method: "GET", uri: "/", headers: { host: ["example.com"] } },
      },
      messages,
    });
  }

  it("redacts the matched cookie value in error_message but keeps the rule fields", () => {
    const row = parseLine(lineWith([{ error_message: SQLI_ON_COOKIE }]), new Map());
    expect(row?.rule_id).toBe(942100);
    expect(row?.raw_data).not.toContain("COOKIE-SECRET");
    expect(row?.raw_data).not.toContain("s&sos");

    const stored = JSON.parse(row?.raw_data ?? "{}");
    const message: string = stored.messages[0].error_message;
    expect(message).toContain(
      '[data "Matched Data: [redacted] found within REQUEST_COOKIES:session: [redacted]"]',
    );
    expect(extractBracketField(message, "id")).toBe("942100");
    expect(extractBracketField(message, "msg")).toBe(
      "SQL Injection Attack Detected via libinjection",
    );
    expect(extractBracketField(message, "severity")).toBe("critical");
    expect(extractBracketField(message, "unique_id")).toBe("tx-cookie");
  });

  it("redacts credential headers and part K message data, in any logdata shape", () => {
    const row = parseLine(
      lineWith([
        {
          error_message:
            '[client "1.2.3.4"] Coraza: Warning. Bad header [id "920000"] ' +
            '[data "REQUEST_HEADERS:Authorization=Bearer HEADER-SECRET"] [severity "warning"]',
          message: "Matched Data: Header REQUEST_HEADERS:x-plex-token: PLEX-SECRET",
          data: {
            id: 920001,
            msg: "Bad value",
            data: "Matched Data: TOKEN-PART found within REQUEST_HEADERS:x-api-key: API-SECRET-TOKEN-PART",
          },
        },
      ]),
      new Map(),
    );
    expect(row?.raw_data).not.toMatch(/HEADER-SECRET|PLEX-SECRET|API-SECRET|TOKEN-PART/);
    const stored = JSON.parse(row?.raw_data ?? "{}");
    expect(extractBracketField(stored.messages[0].error_message, "data")).toBe(
      "REQUEST_HEADERS:Authorization=[redacted]",
    );
    expect(stored.messages[0].message).toBe(
      "Matched Data: Header REQUEST_HEADERS:x-plex-token: [redacted]",
    );
    expect(stored.messages[0].data.data).toBe(
      "Matched Data: [redacted] found within REQUEST_HEADERS:x-api-key: [redacted]",
    );
    expect(stored.messages[0].data.msg).toBe("Bad value");
  });

  it("leaves messages about other variables untouched", () => {
    const xss =
      '[client "1.2.3.4"] Coraza: Warning. XSS [id "941100"] ' +
      '[data "Matched Data: <script> found within ARGS:q: <script>alert(1)</script>"] ' +
      '[severity "critical"]';
    const cookieNames = "Matched Data: x found within REQUEST_COOKIES_NAMES:session: session";
    const row = parseLine(lineWith([{ error_message: xss, message: cookieNames }]), new Map());
    const stored = JSON.parse(row?.raw_data ?? "{}");
    expect(stored.messages[0].error_message).toBe(xss);
    expect(stored.messages[0].message).toBe(cookieNames);
  });
});

// Coraza cuts rule data to 280 bytes, which can end before the variable name does.
describe("stored WAF event redaction - truncated rule data", () => {
  const MAX_DATA = 280;
  const cookieSecret = `SECRET${"x".repeat(294)}`;
  const truncated = `Matched Data: ${cookieSecret}`.slice(0, MAX_DATA);

  function lineWith(
    headers: Record<string, string[]>,
    errorMessage: string,
    message?: string,
  ): string {
    return JSON.stringify({
      transaction: {
        id: "tx-trunc",
        client_ip: "1.2.3.4",
        is_interrupted: true,
        request: { method: "GET", uri: "/", headers: { host: ["example.com"], ...headers } },
      },
      messages: [{ error_message: errorMessage, ...(message ? { message } : {}) }],
    });
  }

  function ruleMessage(data: string, extra = ""): string {
    return (
      `[client "1.2.3.4"] Coraza: Access denied (phase 2). SQL Injection Attack [id "942100"] ` +
      `[msg "SQL Injection Attack"] [data "${data}"] [severity "critical"]${extra}`
    );
  }

  function storedData(row: ReturnType<typeof parseLine>, field = "data"): string | null {
    return extractBracketField(JSON.parse(row?.raw_data ?? "{}").messages[0].error_message, field);
  }

  it("redacts a match excerpt whose variable name was cut off when the request carried credentials", () => {
    const row = parseLine(
      lineWith(
        { cookie: [`session=${cookieSecret}`] },
        ruleMessage(truncated, ` [msg_match_1 ""] [data_match_1 "${truncated}"]`),
        truncated,
      ),
      new Map(),
    );
    expect(row?.raw_data).not.toContain("SECRET");
    expect(storedData(row)).toBe("Matched Data: [redacted]");
    expect(storedData(row, "data_match_1")).toBe("Matched Data: [redacted]");
    expect(JSON.parse(row?.raw_data ?? "{}").messages[0].message).toBe("Matched Data: [redacted]");
    expect(row?.rule_id).toBe(942100);
  });

  it("redacts the excerpt when the cut falls inside the variable name", () => {
    const data = `Matched Data: ${"S".repeat(40)}SECRET found within REQUEST_COO`;
    const row = parseLine(
      lineWith({ authorization: ["Bearer token"] }, ruleMessage(data)),
      new Map(),
    );
    expect(storedData(row)).toBe("Matched Data: [redacted] found within REQUEST_COO");
  });

  it("keeps the excerpt when the request carried no credentials, or the variable name survived", () => {
    expect(storedData(parseLine(lineWith({}, ruleMessage(truncated)), new Map()))).toBe(truncated);

    const attributed =
      "Matched Data: union select found within ARGS:q: 1 union select password from users";
    const withCredentials = parseLine(
      lineWith({ cookie: ["session=abc"] }, ruleMessage(attributed)),
      new Map(),
    );
    expect(storedData(withCredentials)).toBe(attributed);
  });

  it("stores the rule message from the redacted entry", () => {
    const msg = "REQUEST_COOKIES:session=MSG-SECRET";
    const row = parseLine(
      lineWith(
        { cookie: ["session=MSG-SECRET"] },
        `[client "1.2.3.4"] Coraza: Warning. ${msg} [id "990001"] [msg "${msg}"] [severity "warning"]`,
      ),
      new Map(),
    );
    expect(row?.rule_message).toBe("REQUEST_COOKIES:session=[redacted]");
    expect(row?.raw_data).not.toContain("MSG-SECRET");
  });

  it("measures the cap in bytes of the unquoted data", () => {
    // 133 two-byte characters: 280 bytes, but 147 characters.
    const data = `Matched Data: ${"é".repeat(133)}`;
    const row = parseLine(lineWith({ cookie: ["session=abc"] }, ruleMessage(data)), new Map());
    expect(storedData(row)).toBe("Matched Data: [redacted]");

    const short = `Matched Data: ${"é".repeat(132)}`;
    const kept = parseLine(lineWith({ cookie: ["session=abc"] }, ruleMessage(short)), new Map());
    expect(storedData(kept)).toBe(short);
  });
});

// Matched values are request data: whatever they contain must not decide what gets redacted.
describe("stored WAF event redaction - where the variable name sits", () => {
  function storedData(data: string, headers: Record<string, string[]> = {}): string | null {
    const line = JSON.stringify({
      transaction: {
        id: "tx-anchor",
        client_ip: "1.2.3.4",
        is_interrupted: true,
        request: { method: "POST", uri: "/", headers: { host: ["example.com"], ...headers } },
      },
      messages: [
        {
          error_message: `[client "1.2.3.4"] Coraza: Warning. Attack [id "944110"] [msg "Attack"] [data "${data}"] [severity "critical"]`,
        },
      ],
    });
    return extractBracketField(
      JSON.parse(parseLine(line, new Map())?.raw_data ?? "{}").messages[0].error_message,
      "data",
    );
  }

  it("keeps an excerpt whose logdata names the variable with no value after it, cookies or not", () => {
    const data = "Matched Data: java.lang.ProcessBuilder found within ARGS:payload";
    expect(storedData(data, { cookie: ["theme=dark"] })).toBe(data);
    expect(storedData(data)).toBe(data);
  });

  it("keeps a payload that spells out a credential variable name", () => {
    const data =
      "Matched Data: <script> found within ARGS_POST:body: REQUEST_COOKIES: <script>alert(1)</script>";
    expect(storedData(data, { cookie: ["theme=dark"] })).toBe(data);
    expect(storedData(data)).toBe(data);

    const forged =
      "Matched Data: java.lang.Runtime found within REQUEST_COOKIES:a: x found within ARGS:payload";
    expect(storedData(forged, { cookie: ["a=1"] })).toBe(forged);
    const forgedHeader =
      "Matched Data: Header REQUEST_HEADERS:authorization: java.lang.Runtime found within ARGS:x";
    expect(storedData(forgedHeader, { authorization: ["Bearer t"] })).toBe(forgedHeader);
    const forgedPair = "ARGS:x=REQUEST_COOKIES:a=java.lang.Runtime";
    expect(storedData(forgedPair, { cookie: ["a=1"] })).toBe(forgedPair);
  });

  it('redacts a credential value named after " found within ", with or without a value after it', () => {
    expect(
      storedData(
        "Matched Data: Bearer java.lang.Runtime-SECRET found within REQUEST_HEADERS:authorization",
      ),
    ).toBe("Matched Data: [redacted] found within REQUEST_HEADERS:authorization");
    expect(
      storedData(
        "Matched Data: java.lang.Runtime found within REQUEST_COOKIES:session: x=java.lang.Runtime-SECRET",
      ),
    ).toBe("Matched Data: [redacted] found within REQUEST_COOKIES:session: [redacted]");
  });

  it("redacts a cookie reported as NAME=VALUE", () => {
    expect(storedData("REQUEST_COOKIES:session=abc\\u1234SECRET")).toBe(
      "REQUEST_COOKIES:session=[redacted]",
    );
    expect(storedData("REQUEST_HEADERS:cookie=session=SECRET")).toBe(
      "REQUEST_HEADERS:cookie=[redacted]",
    );
  });

  it("redacts a credential reported as NAME: VALUE, but not a variable name inside another value", () => {
    expect(
      storedData("REQUEST_COOKIES:session: secretvalue", { cookie: ["session=secretvalue"] }),
    ).toBe("REQUEST_COOKIES:session: [redacted]");
    expect(storedData("REQUEST_HEADERS:X-Plex-Token: abc=SECRET")).toBe(
      "REQUEST_HEADERS:X-Plex-Token: [redacted]",
    );
    const forged = "ARGS:q: REQUEST_COOKIES:session: java.lang.Runtime";
    expect(storedData(forged, { cookie: ["session=1"] })).toBe(forged);
  });

  it("redacts an excerpt cut inside the credential variable name, but not inside another", () => {
    const cookies = { cookie: ["session=abc"] };
    expect(storedData("Matched Data: SECRET found within REQUEST_HEADERS:auth", cookies)).toBe(
      "Matched Data: [redacted] found within REQUEST_HEADERS:auth",
    );
    expect(
      storedData("Matched Data: SECRET found within REQUEST_HEADERS:authorization:", cookies),
    ).toBe("Matched Data: [redacted] found within REQUEST_HEADERS:authorization:");
    expect(storedData("Matched Data: SECRET found within ", cookies)).toBe(
      "Matched Data: [redacted] found within ",
    );
    expect(storedData("Matched Data: payload found within REQUEST_HEADERS:user-ag", cookies)).toBe(
      "Matched Data: payload found within REQUEST_HEADERS:user-ag",
    );
  });
});

describe("stored WAF event serialization", () => {
  it("keeps a header named __proto__ as an ordinary header", () => {
    const line =
      '{"transaction":{"id":"tx-proto","client_ip":"1.2.3.4","is_interrupted":true,' +
      '"request":{"method":"GET","uri":"/","headers":{"host":["example.com"],"__proto__":["hidden"]}}}}';
    const row = parseLine(line, new Map());
    const stored = JSON.parse(row?.raw_data ?? "{}");
    expect(Object.keys(stored.transaction.request.headers)).toContain("__proto__");
    expect(row?.raw_data).toContain('"__proto__":["hidden"]');
  });

  it("keeps the nanosecond unix_timestamp digits of the original line", () => {
    const line =
      '{"transaction":{"timestamp":"2023/11/14 22:13:20","unix_timestamp":1700000000123456789,' +
      '"id":"tx-ts","client_ip":"1.2.3.4","is_interrupted":true,' +
      '"request":{"method":"GET","uri":"/","headers":{"host":["example.com"]}}}}';
    const row = parseLine(line, new Map());
    expect(row?.ts).toBe(1700000000);
    expect(row?.raw_data).toContain('"unix_timestamp":1700000000123456789');
  });
});
