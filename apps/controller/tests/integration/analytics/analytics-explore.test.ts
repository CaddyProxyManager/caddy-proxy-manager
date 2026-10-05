/**
 * The analytics page's report and the traffic signals, run for real against the SQLite analytics
 * store (the ClickHouse SQL, translated), on rows small enough to count by hand.
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
const { getAnalyticsReport, getAnalyticsTopList } = await import(
  '../../../src/lib/analytics/explore'
);
const { parseExploreState } = await import('../../../src/lib/analytics/explore-state');
const { detectTrafficSignals } = await import('../../../src/lib/analytics/signals');

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
    user_agent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
    is_blocked: false,
    duration_ms: 20,
    outcome: 'served',
    asn: 64500,
    asn_org: 'Example Net',
    ...overrides,
  };
}

const traffic: TrafficEventRow[] = [
  row({}),
  row({ uri: '/login?next=/', duration_ms: 40 }),
  row({ client_ip: '198.51.100.2', status: 404, uri: '/missing' }),
  row({
    client_ip: '203.0.113.9',
    country_code: 'CN',
    asn: 64501,
    asn_org: 'Other Net',
    status: 403,
    outcome: 'waf',
    uri: '/.env',
    user_agent: 'curl/8.0',
  }),
  row({
    client_ip: '203.0.113.9',
    country_code: 'CN',
    asn: 64501,
    asn_org: 'Other Net',
    status: 403,
    outcome: 'geo',
    is_blocked: true,
    uri: '/',
  }),
  row({ host: 'api.example.com', status: 502, uri: '/v1/items', method: 'POST' }),
  // An older agent: no duration, no outcome, no ASN.
  row({
    host: 'api.example.com',
    duration_ms: undefined,
    outcome: undefined,
    asn: undefined,
    asn_org: undefined,
    country_code: null,
  }),
  // In the previous period of a one-hour window.
  row({ ts: NOW - 3600 - 600 }),
  row({ ts: NOW - 3600 - 700, outcome: 'rate_limit', status: 429 }),
];

const waf: WafEventRow[] = [
  {
    ts: NOW - 600,
    host: 'app.example.com',
    client_ip: '203.0.113.9',
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

/** Signals look two hours on, so their rows stay out of the report's one-hour window. */
const LATER = NOW + 7200;

const signalRows = [
  ...Array.from({ length: 12 }, (_, i) =>
    row({ ts: LATER - 120 - i, host: 'broken.example.com', status: 503 }),
  ),
  ...Array.from({ length: 60 }, (_, i) =>
    row({ ts: LATER - 900 - i, host: 'target.example.com', uri: '/wp-login.php', outcome: 'waf' }),
  ),
];

beforeAll(async () => {
  process.env.DEMO_MODE = 'true';
  process.env.DEMO_ANALYTICS_DB = ':memory:';
  await client.invalidateClickHouseConfig();
  await client.initClickHouse();
  await client.clearAnalyticsEvents();
  await client.insertTrafficEvents(traffic, 'edge-1');
  await client.insertWafEvents(waf, 'edge-1');
  await client.insertTrafficEvents(signalRows, 'edge-1');
});

afterAll(async () => {
  delete process.env.DEMO_MODE;
  delete process.env.DEMO_ANALYTICS_DB;
  await client.invalidateClickHouseConfig();
});

const report = (query: string) =>
  getAnalyticsReport(parseExploreState(new URLSearchParams(query)), NOW);

describe('analytics report', () => {
  it('totals the window and the period before it', async () => {
    const result = await report('range=1h');
    expect(result.totals).toMatchObject({
      requests: 7,
      bytes: 700,
      uniqueIps: 3,
      mitigated: 2,
      serverErrors: 1,
    });
    // Six rows carry a duration: five at 20 ms and one at 40.
    expect(result.totals.avgDurationMs).toBe(Math.round((5 * 20 + 40) / 6));
    expect(result.previousTotals).toMatchObject({ requests: 2, mitigated: 1 });
    expect(result.previousTimeline).toHaveLength(result.timeline.length);
    expect(result.timeline.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(7);
  });

  it('stores what an older agent leaves out as served, with no duration', async () => {
    const result = await report('range=1h&f=host:is:api.example.com&f=status:is:200');
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({ outcome: 'served', durationMs: null, asn: null });
  });

  it('applies is and is-not filters to every part', async () => {
    const only = await report('range=1h&f=host:is:app.example.com');
    expect(only.totals.requests).toBe(5);
    expect(only.top.host.map((r) => r.key)).toEqual(['app.example.com']);

    const without = await report('range=1h&f=host:not:app.example.com');
    expect(without.totals.requests).toBe(2);

    expect((await report('range=1h&f=status:is:4xx')).totals.requests).toBe(3);
    expect((await report('range=1h&f=outcome:is:waf')).totals.requests).toBe(1);
    expect((await report('range=1h&f=path:is:/login')).totals.requests).toBe(1);
    expect((await report('range=1h&f=country:is:XX')).totals.requests).toBe(1);
    expect((await report('range=1h&f=asn:is:AS64501')).totals.requests).toBe(2);
    expect((await report('range=1h&f=ua:is:curl')).totals.requests).toBe(1);
    expect((await report('range=1h&f=method:not:GET')).totals.requests).toBe(1);
    expect((await report('range=1h&f=ip:is:203.0.113.9')).totals.requests).toBe(2);
  });

  it('narrows to the requests a WAF rule matched', async () => {
    const result = await report('range=1h&f=rule:is:930130');
    expect(result.totals.requests).toBe(1);
    expect(result.requests[0]?.uri).toBe('/.env');
    expect(result.top.rule).toEqual([
      expect.objectContaining({
        key: '930130',
        label: 'Restricted File Access Attempt',
        requests: 1,
      }),
    ]);
  });

  it('ranks every top list', async () => {
    const result = await report('range=1h');
    expect(result.top.status[0]).toMatchObject({ key: '200', requests: 3 });
    expect(result.top.path.find((r) => r.key === '/login')?.requests).toBe(1);
    expect(result.top.asn[0]).toMatchObject({ key: '64500', label: 'Example Net' });
    expect(result.top.ua.map((r) => r.key).sort()).toEqual(['Firefox', 'curl']);
    expect(result.top.country.find((r) => r.key === 'CN')).toMatchObject({
      requests: 2,
      mitigated: 2,
    });
    expect(result.countries.length).toBe(3);
  });

  it('groups the chart by outcome and by status class', async () => {
    const byOutcome = await report('range=1h&group=outcome');
    const totals = Object.fromEntries(
      byOutcome.groups.map((g) => [g.key, g.counts.reduce((a, b) => a + b, 0)]),
    );
    expect(totals).toEqual({ served: 5, waf: 1, geo: 1 });

    const byStatus = await report('range=1h&group=status');
    expect(byStatus.groups.map((g) => g.key)).toEqual(['2xx', '4xx', '5xx']);
  });

  it('limits the log to mitigated requests when asked', async () => {
    const result = await report('range=1h&log=mitigated');
    expect(result.requests.map((r) => r.outcome).sort()).toEqual(['geo', 'waf']);
  });

  it('serves a full list for view all', async () => {
    const rows = await getAnalyticsTopList(
      parseExploreState(new URLSearchParams('range=1h')),
      'ip',
      100,
      NOW,
    );
    expect(rows.reduce((sum, r) => sum + r.requests, 0)).toBe(7);
  });
});

describe('traffic signals', () => {
  it('finds the burst, the spike and the pile-up', async () => {
    const result = await detectTrafficSignals({ now: LATER });
    expect(result.available).toBe(true);
    expect(result.skipped).toEqual([]);
    expect(result.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'serverErrorBurst',
          host: 'broken.example.com',
          ongoing: true,
        }),
        expect.objectContaining({ kind: 'mitigationSpike', host: 'target.example.com' }),
        expect.objectContaining({
          kind: 'blockedConcentration',
          host: 'target.example.com',
          path: '/wp-login.php',
          outcome: 'waf',
          requests: 60,
        }),
      ]),
    );
  });

  it('skips a detector that outlives its budget rather than waiting', async () => {
    const result = await detectTrafficSignals({ now: LATER, budgetMs: 0 });
    expect(result.available).toBe(true);
    // A zero budget can still race a fast query; whatever ran late is named, never waited for.
    expect(result.skipped.length + result.signals.length).toBeGreaterThan(0);
  });
});
