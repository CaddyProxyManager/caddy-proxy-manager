/**
 * The security page's report and a WAF event's detail, run against the SQLite analytics store
 * (the ClickHouse SQL, translated) on rows few enough to count by hand.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';
import type { TrafficEventRow, WafEventRow } from '@/src/lib/clickhouse/client';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

const client = await import('../../../src/lib/clickhouse/client');
const { parseExploreState } = await import('../../../src/lib/analytics/explore-state');
const { getSecurityReport, getWafHostModes } = await import('../../../src/lib/security/report');
const { getWafEventDetail, reviewWafEvent, getWafEventReviews } = await import(
  '../../../src/lib/security/waf-event'
);
const schema = await import('../../../src/lib/db/schema');
const { setSetting } = await import('../../../src/lib/settings');

const NOW = Math.floor(Date.now() / 1000);

function row(overrides: Partial<TrafficEventRow>): TrafficEventRow {
  return {
    ts: NOW - 600,
    client_ip: '198.51.100.1',
    country_code: 'DE',
    host: 'app.example.com',
    method: 'GET',
    uri: '/',
    status: 200,
    proto: 'HTTP/2.0',
    bytes_sent: 100,
    user_agent: 'curl/8.0',
    is_blocked: false,
    duration_ms: 20,
    outcome: 'served',
    asn: 64500,
    asn_org: 'Example Net',
    ...overrides,
  };
}

const ATTACKER = '203.0.113.9';

const SQLI_RECORD = JSON.stringify({
  transaction: {
    id: 'tx-sqli',
    request: {
      method: 'GET',
      uri: '/search?id=1%27&token=abc',
      headers: { host: ['app.example.com'], 'x-upstream-token': ['secret-value'] },
    },
  },
  messages: [
    {
      error_message:
        '[id "942100"] [msg "SQL Injection Attack Detected via libinjection"] [data "Matched Data: s&sos found within ARGS:id: 1\'"] [severity "critical"] [tag "paranoia-level/1"]',
    },
    { error_message: '[id "949110"] [msg "Inbound Anomaly Score Exceeded (Total Score: 5)"]' },
  ],
});

const traffic: TrafficEventRow[] = [
  row({}),
  row({ uri: '/about' }),
  row({
    client_ip: ATTACKER,
    asn: 64501,
    asn_org: 'Bad Net',
    country_code: 'CN',
    status: 403,
    outcome: 'waf',
    uri: '/search?id=1%27',
  }),
  row({
    client_ip: ATTACKER,
    asn: 64501,
    asn_org: 'Bad Net',
    country_code: 'CN',
    status: 403,
    outcome: 'waf',
    uri: '/.env',
  }),
  row({ client_ip: '192.0.2.4', status: 403, outcome: 'geo', is_blocked: true }),
  row({ client_ip: '192.0.2.5', status: 403, outcome: 'blocked' }),
  // The hour before.
  row({ ts: NOW - 3600 - 600, client_ip: ATTACKER, status: 403, outcome: 'waf' }),
];

const waf: WafEventRow[] = [
  {
    ts: NOW - 600,
    host: 'app.example.com:443',
    client_ip: ATTACKER,
    country_code: 'CN',
    rule_id: 942100,
    rule_message: 'SQL Injection Attack Detected via libinjection',
    severity: 'CRITICAL',
    raw_data: SQLI_RECORD,
    blocked: true,
    method: 'GET',
    uri: '/search?id=1%27&token=abc',
  },
  {
    ts: NOW - 590,
    host: 'app.example.com',
    client_ip: ATTACKER,
    country_code: 'CN',
    rule_id: 930130,
    rule_message: 'Restricted File Access Attempt',
    severity: 'CRITICAL',
    raw_data: null,
    blocked: true,
    method: 'GET',
    uri: '/.env',
  },
];

let hostId = 0;

beforeAll(async () => {
  process.env.DEMO_MODE = 'true';
  process.env.DEMO_ANALYTICS_DB = ':memory:';
  await client.invalidateClickHouseConfig();
  await client.initClickHouse();
  await client.clearAnalyticsEvents();
  await client.insertTrafficEvents(traffic, 'edge-1');
  await client.insertWafEvents(waf, 'edge-1');

  const now = new Date().toISOString();
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'admin@test',
    name: 'Admin',
    role: 'admin',
    provider: 'credentials',
    subject: 'admin',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  const [host] = await ctx.db
    .insert(schema.proxyHosts)
    .values({
      name: 'App',
      domains: JSON.stringify(['app.example.com']),
      upstreams: JSON.stringify(['app:80']),
      meta: JSON.stringify({ waf: { enabled: true, mode: 'DetectionOnly' } }),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  hostId = host.id;
  await setSetting('waf', {
    enabled: true,
    mode: 'On',
    load_owasp_crs: true,
    custom_directives: '',
    paranoia_level: 2,
    inbound_anomaly_threshold: 7,
  });
  await ctx.db.insert(schema.blockedSources).values({
    kind: 'ip',
    value: ATTACKER,
    reason: '',
    expiresAt: null,
    createdAt: now,
  });
});

afterAll(async () => {
  delete process.env.DEMO_MODE;
  delete process.env.DEMO_ANALYTICS_DB;
  await client.invalidateClickHouseConfig();
});

const report = (query: string, page = 1) =>
  getSecurityReport(parseExploreState(new URLSearchParams(query)), page, NOW);

describe('security report', () => {
  it('summarises the rule set as configured', async () => {
    const { ruleSet } = await report('range=1h');
    expect(ruleSet).toMatchObject({
      globalMode: 'On',
      crsLoaded: true,
      paranoiaLevel: 2,
      inboundThreshold: 7,
      outboundThreshold: 4,
      hosts: { On: 0, DetectionOnly: 1, Off: 0 },
      blockedSources: 1,
    });
  });

  it('counts mitigated requests by outcome against the hour before', async () => {
    const result = await report('range=1h');
    expect(result.source).toBe('traffic');
    expect(result.totals).toMatchObject({
      requests: 6,
      mitigated: 4,
      previousMitigated: 1,
      sources: 3,
      topHost: { host: 'app.example.com', count: 4 },
    });
    expect(result.totals.byOutcome).toEqual(
      expect.arrayContaining([
        { outcome: 'waf', count: 2, previous: 1 },
        { outcome: 'geo', count: 1, previous: 0 },
        { outcome: 'blocked', count: 1, previous: 0 },
      ]),
    );
    const total = result.series.reduce(
      (sum, series) => sum + series.counts.reduce((a, b) => a + b, 0),
      0,
    );
    expect(total).toBe(4);
  });

  it('explains the peak by its busiest address, host and rule', async () => {
    const { peak } = await report('range=1h');
    expect(peak).toMatchObject({ count: 4, ip: ATTACKER, host: 'app.example.com' });
    expect([942100, 930130]).toContain(peak?.ruleId as number);
  });

  it('ranks rules and sources, marking a source already blocked', async () => {
    const result = await report('range=1h');
    expect(result.topRules.map((rule) => rule.ruleId).sort()).toEqual([930130, 942100]);
    const attacker = result.topSources.find((source) => source.ip === ATTACKER);
    expect(attacker).toMatchObject({
      requests: 2,
      asn: 64501,
      asnOrg: 'Bad Net',
      blocked: true,
    });
    expect(attacker?.rules.sort()).toEqual([930130, 942100]);
  });

  it('pages the WAF events, redacted, under the same filters', async () => {
    const all = await report('range=1h');
    expect(all.events.total).toBe(2);
    expect(all.events.items[0]?.uri).not.toContain('abc');

    const filtered = await report(`range=1h&f=rule:is:930130`);
    expect(filtered.events.items.map((event) => event.ruleId)).toEqual([930130]);
    const excluded = await report(`range=1h&f=ip:not:${ATTACKER}`);
    expect(excluded.events.total).toBe(0);
  });

  it('lists each host with its mode and its week of WAF events', async () => {
    const modes = await getWafHostModes(NOW);
    expect(modes).toEqual([
      expect.objectContaining({
        id: hostId,
        mode: 'DetectionOnly',
        source: 'host',
        events7d: 2,
      }),
    ]);
  });
});

describe('WAF event detail', () => {
  async function sqliKey() {
    const { events } = await report('range=1h&f=rule:is:942100');
    return events.items[0]?.key as string;
  }

  it('explains the score and suggests the narrowest exclusion', async () => {
    const detail = await getWafEventDetail(await sqliKey());
    expect(detail.explanation).toMatchObject({
      totalScore: 5,
      scoreReported: true,
      threshold: 7,
      decidingRuleId: 949110,
    });
    expect(detail.suggestedExclusion).toEqual({
      ruleId: 942100,
      proxyHostId: hostId,
      hostName: 'App',
      path: '/search',
      target: 'ARGS:id',
    });
    expect(detail.curl).toContain("'https://app.example.com/search?id=1%27&token=[redacted]'");
    expect(detail.curl).not.toContain('secret-value');
    expect(detail.event.rawData).not.toContain('secret-value');
  });

  it('keeps a review per event, replacing and clearing it', async () => {
    const key = await sqliKey();
    await reviewWafEvent(key, 'intended', 1);
    await reviewWafEvent(key, 'false_positive', 1);
    expect((await getWafEventReviews([key])).get(key)).toMatchObject({
      verdict: 'false_positive',
      reviewedBy: 'Admin',
    });
    const page = await report('range=1h&f=rule:is:942100');
    expect(page.events.items[0]?.review?.verdict).toBe('false_positive');
    await reviewWafEvent(key, null, 1);
    expect((await getWafEventReviews([key])).size).toBe(0);
  });

  it('refuses a key that names nothing stored', async () => {
    await expect(getWafEventDetail(`${NOW}.0123456789abcdef0123`)).rejects.toThrow();
    await expect(getWafEventDetail('not-a-key')).rejects.toThrow();
  });
});
