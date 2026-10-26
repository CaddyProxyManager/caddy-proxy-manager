import { describe, expect, it } from 'bun:test';
import {
  WAF_OVERRIDE_RULE_ID_BASE,
  WAF_OVERRIDE_RULES_PER_SESSION,
  collectOverrideRules,
  isLoopbackIp,
  isWafOverrideActive,
  normalizeOverrideRuleIds,
  overridePresetDirectives,
  wafOverrideRoute,
} from '@/src/lib/waf/override';
import { buildWafHandler, customDirectivesError } from '@/src/lib/waf/caddy';
import { seclangErrors } from '@/src/lib/waf/seclang';

const SQLI =
  '[id "942100"] [msg "SQL Injection Attack Detected via libinjection"] ' +
  '[data "Matched Data: s&sos found within ARGS:id: 1\' or 1=1"] [severity "critical"] ' +
  '[tag "paranoia-level/1"]';
const XSS =
  '[id "941100"] [msg "XSS Attack Detected via libinjection"] ' +
  '[data "Matched Data: XSS data found within ARGS:q: <script>"] [severity "critical"]';
const EVALUATION =
  '[id "949110"] [msg "Inbound Anomaly Score Exceeded (Total Score: 10)"] [severity "emergency"]';

function event(
  uri: string,
  messages: string[],
  extra: Partial<{ blocked: boolean; ruleId: number | null }> = {},
) {
  return {
    uri,
    rawData: JSON.stringify({
      transaction: { id: 'tx' },
      messages: messages.map((error_message) => ({ error_message })),
    }),
    blocked: extra.blocked ?? false,
    ruleId: extra.ruleId ?? null,
    ruleMessage: null,
    severity: null,
  };
}

describe('collectOverrideRules', () => {
  it('groups the matched rules by id, most hit first, without the anomaly evaluation', () => {
    const rules = collectOverrideRules(
      [
        event('/search?q=1', [SQLI, EVALUATION]),
        event('/search?q=2', [SQLI, XSS, EVALUATION]),
        event('/login', [XSS]),
        event('/login', [XSS]),
      ],
      5,
    );
    expect(rules.map((rule) => [rule.ruleId, rule.hits])).toEqual([
      [941100, 3],
      [942100, 2],
    ]);
    expect(rules[1]).toMatchObject({
      message: 'SQL Injection Attack Detected via libinjection',
      severity: 'critical',
      points: 5,
      paranoiaLevel: 1,
      matches: [{ variable: 'ARGS:id', data: 's&sos' }],
      paths: ['/search'],
    });
    expect(rules[0].paths).toEqual(['/search', '/login']);
  });

  it('counts a rule once per request however often its chain logged it', () => {
    expect(collectOverrideRules([event('/a', [XSS, XSS])], 5)[0].hits).toBe(1);
  });

  it("falls back to the event's own rule for a record without messages", () => {
    const rules = collectOverrideRules(
      [{ ...event('/x', []), ruleId: 930130, ruleMessage: 'Restricted File Access' }],
      5,
    );
    expect(rules).toMatchObject([{ ruleId: 930130, message: 'Restricted File Access', hits: 1 }]);
  });

  it('leaves every anomaly evaluation rule out, the outbound ones included', () => {
    const outbound = '[id "959100"] [msg "Outbound Anomaly Score Exceeded (Total Score: 4)"]';
    expect(collectOverrideRules([event('/x', [outbound, EVALUATION])], 5)).toEqual([]);
  });
});

describe('normalizeOverrideRuleIds', () => {
  it('deduplicates and accepts numbers as text', () => {
    expect(normalizeOverrideRuleIds([942100, '942100', 920350])).toEqual({
      ruleIds: [942100, 920350],
      error: null,
    });
  });

  it('refuses an empty, oversized, malformed or protected selection', () => {
    expect(normalizeOverrideRuleIds([]).error).toBe('wafOverrideNoRules');
    expect(
      normalizeOverrideRuleIds(
        Array.from({ length: WAF_OVERRIDE_RULES_PER_SESSION + 1 }, (_, i) => i + 1),
      ).error,
    ).toBe('wafOverrideTooManyRules');
    expect(normalizeOverrideRuleIds([0]).error).toBe('wafExclusionRuleIdInvalid');
    expect(normalizeOverrideRuleIds('942100').error).toBe('wafExclusionRuleIdInvalid');
    expect(normalizeOverrideRuleIds([949110]).error).toBe('wafExclusionRuleProtected');
  });
});

describe('overridePresetDirectives', () => {
  it('writes one runtime removal per rule from the session block of ids', () => {
    const directives = overridePresetDirectives(7, [942100, 920350]);
    const base = WAF_OVERRIDE_RULE_ID_BASE + 7 * WAF_OVERRIDE_RULES_PER_SESSION;
    expect(directives.split('\n')).toEqual([
      `SecAction "id:${base},phase:1,pass,t:none,nolog,ctl:ruleRemoveById=942100"`,
      `SecAction "id:${base + 1},phase:1,pass,t:none,nolog,ctl:ruleRemoveById=920350"`,
    ]);
  });

  it('passes the preset checks a save runs, strict directives included', () => {
    const directives = overridePresetDirectives(3, [942100, 941100, 920350]);
    expect(seclangErrors(directives)).toEqual([]);
    expect(customDirectivesError(directives, { strictDirectives: true }, undefined, 'preset')).toBe(
      null,
    );
  });

  it('lands ahead of the CRS when the preset is emitted', () => {
    const directives = overridePresetDirectives(1, [942100]);
    const handler = buildWafHandler(
      { enabled: true, mode: 'On', load_owasp_crs: true, custom_directives: '', preset_ids: [1] },
      new Map([[1, directives]]),
    );
    const text = String(handler.directives);
    expect(text.indexOf('ctl:ruleRemoveById=942100')).toBeLessThan(
      text.indexOf('Include @owasp_crs/*.conf'),
    );
  });
});

describe('wafOverrideRoute', () => {
  it('sends the tester through a detecting copy and everyone else through the handler', () => {
    const handler = { handler: 'waf', directives: 'SecRuleEngine On' };
    const detecting = { handler: 'waf', directives: 'SecRuleEngine DetectionOnly' };
    const route = wafOverrideRoute(handler, detecting, '203.0.113.9');
    expect(route).toEqual({
      handler: 'subroute',
      routes: [
        {
          match: [{ client_ip: { ranges: ['203.0.113.9'] } }],
          handle: [
            {
              handler: 'waf',
              directives: 'SecRuleEngine DetectionOnly\nSecAuditLogRelevantStatus ".*"',
            },
          ],
          terminal: true,
        },
        { handle: [handler] },
      ],
    });
  });
});

describe('isWafOverrideActive', () => {
  const session = {
    id: 1,
    proxyHostId: 1,
    clientIp: '203.0.113.9',
    startedAt: '2026-10-26T10:00:00.000Z',
    expiresAt: '2026-10-26T10:05:00.000Z',
    endedAt: null,
    presetId: null,
  };

  it('runs until it ends or expires', () => {
    const during = Date.parse('2026-10-26T10:02:00.000Z');
    expect(isWafOverrideActive(session, during)).toBe(true);
    expect(isWafOverrideActive(session, Date.parse('2026-10-26T10:05:00.000Z'))).toBe(false);
    expect(isWafOverrideActive({ ...session, endedAt: '2026-10-26T10:01:00.000Z' }, during)).toBe(
      false,
    );
  });
});

describe('isLoopbackIp', () => {
  it('knows loopback however it is spelt', () => {
    for (const ip of [
      '127.0.0.1',
      '127.255.10.2',
      '::1',
      '0:0:0:0:0:0:0:1',
      '0000:0000:0000:0000:0000:0000:0000:0001',
      '::ffff:127.0.0.1',
      '::FFFF:7f00:1',
      '::127.0.0.1',
      '::1%lo0',
    ]) {
      expect([ip, isLoopbackIp(ip)]).toEqual([ip, true]);
    }
  });

  it('lets every other address through', () => {
    for (const ip of [
      '203.0.113.9',
      '10.0.0.1',
      '128.0.0.1',
      '1.127.0.0',
      '::2',
      '2001:db8::1',
      'fe80::1',
      '::ffff:203.0.113.9',
      '0.0.0.0',
      'localhost',
      '',
    ]) {
      expect([ip, isLoopbackIp(ip)]).toEqual([ip, false]);
    }
  });
});
