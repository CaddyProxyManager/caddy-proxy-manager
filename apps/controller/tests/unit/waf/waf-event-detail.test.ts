import { describe, expect, it } from 'bun:test';
import { explainWafEvent, splitMatchedData, wafEventCurl } from '@/src/lib/waf/event-detail';
import { wafEventKey, wafEventKeyTs } from '@/src/lib/waf/event-key';

const SQLI =
  '[file "@owasp_crs/REQUEST-942-APPLICATION-ATTACK-SQLI.conf"] [line "1"] [id "942100"] ' +
  '[msg "SQL Injection Attack Detected via libinjection"] ' +
  '[data "Matched Data: s&sos found within ARGS:id: 1\' or \'1\'=\'1"] [severity "critical"] ' +
  '[tag "attack-sqli"] [tag "paranoia-level/1"]';
const XSS =
  '[id "941100"] [msg "XSS Attack Detected via libinjection"] ' +
  '[data "Matched Data: XSS data found within ARGS:q: <script>"] [severity "critical"] ' +
  '[tag "paranoia-level/2"]';
const EVALUATION =
  '[id "949110"] [msg "Inbound Anomaly Score Exceeded (Total Score: 10)"] [severity "emergency"]';

function record(messages: string[], request: Record<string, unknown> = {}): string {
  return JSON.stringify({
    transaction: { id: 'tx-1', request },
    messages: messages.map((error_message) => ({ error_message })),
  });
}

describe('explainWafEvent', () => {
  it('lists each matched rule with its points, variable and data', () => {
    const result = explainWafEvent(record([SQLI, XSS, EVALUATION]), {
      threshold: 5,
      blocked: true,
    });
    expect(result.rules.map((rule) => rule.ruleId)).toEqual([942100, 941100]);
    expect(result.rules[0]).toMatchObject({
      points: 5,
      variable: 'ARGS:id',
      data: 's&sos',
      paranoiaLevel: 1,
      severity: 'critical',
    });
    expect(result.rules[1]?.paranoiaLevel).toBe(2);
  });

  it('takes the score and deciding rule from the anomaly evaluation', () => {
    expect(
      explainWafEvent(record([SQLI, XSS, EVALUATION]), { threshold: 5, blocked: true }),
    ).toMatchObject({ totalScore: 10, scoreReported: true, decidingRuleId: 949110, threshold: 5 });
  });

  it('sums the points when no evaluation was logged', () => {
    const result = explainWafEvent(record([SQLI]), { threshold: 5, blocked: false });
    expect(result).toMatchObject({ totalScore: 5, scoreReported: false, decidingRuleId: null });
  });

  it('names a denying rule of its own as the decision', () => {
    const custom = '[id "9001"] [msg "Blocked path"] [severity "warning"]';
    expect(explainWafEvent(record([custom]), { threshold: 5, blocked: true }).decidingRuleId).toBe(
      9001,
    );
  });

  it("falls back to the event's own rule when the record lists none", () => {
    const result = explainWafEvent(record([]), {
      threshold: 5,
      blocked: true,
      rule: { ruleId: 930130, message: 'Restricted File Access', severity: 'CRITICAL' },
    });
    expect(result.rules).toMatchObject([{ ruleId: 930130, points: 5 }]);
    expect(result).toMatchObject({ totalScore: 5, decidingRuleId: 930130 });
  });

  it('copes with a record that is missing or not JSON', () => {
    expect(explainWafEvent(null, { threshold: 5, blocked: true }).rules).toEqual([]);
    expect(explainWafEvent('not json', { threshold: 5, blocked: false }).totalScore).toBe(0);
  });
});

describe('splitMatchedData', () => {
  it('reads a header match', () => {
    expect(splitMatchedData('Matched Data: Header User-Agent: sqlmap')).toEqual({
      variable: 'REQUEST_HEADERS:User-Agent',
      data: 'sqlmap',
    });
  });

  it('keeps data it cannot split', () => {
    expect(splitMatchedData('anything')).toEqual({ variable: null, data: 'anything' });
  });
});

describe('wafEventCurl', () => {
  it('rebuilds the request with its headers, quoting for a shell', () => {
    const curl = wafEventCurl(
      record([], {
        method: 'POST',
        uri: "/search?q=it's",
        headers: {
          host: ['app.example.com'],
          authorization: ['[redacted]'],
          'user-agent': ['curl/8'],
        },
        body: 'a=1',
      }),
      { host: 'fallback', method: 'GET', uri: '/' },
    );
    expect(curl).toBe(
      "curl -X POST 'https://app.example.com/search?q=it'\\''s' -H 'authorization: [redacted]' " +
        "-H 'user-agent: curl/8' --data-raw 'a=1'",
    );
  });

  it('falls back to the event when the record has no request', () => {
    expect(wafEventCurl(null, { host: 'h.example.com', method: 'get', uri: '/x' })).toBe(
      "curl -X GET 'https://h.example.com/x'",
    );
  });
});

describe('wafEventKey', () => {
  const row = {
    ts: 1_700_000_000,
    clientIp: '203.0.113.7',
    method: 'GET',
    uri: '/',
    ruleId: 942100,
    rawData: '{"transaction":{"id":"abc"}}',
  };

  it('is stable for the same row and differs for another', () => {
    expect(wafEventKey(row)).toBe(wafEventKey({ ...row }));
    expect(wafEventKey(row)).not.toBe(
      wafEventKey({ ...row, rawData: '{"transaction":{"id":"x"}}' }),
    );
  });

  it('carries the second, and refuses anything else as a key', () => {
    expect(wafEventKeyTs(wafEventKey(row))).toBe(1_700_000_000);
    expect(wafEventKeyTs('1700000000.zz')).toBeNull();
    expect(wafEventKeyTs("1' OR 1=1")).toBeNull();
  });
});
