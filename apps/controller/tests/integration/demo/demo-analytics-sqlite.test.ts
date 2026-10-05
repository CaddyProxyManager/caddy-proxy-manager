/**
 * The demo's SQLite analytics runs ClickHouse's queries translated. Each is checked against a
 * count from the rows, so an unknown or mistranslated function fails here, not on the demo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

const client = await import('../../../src/lib/clickhouse/client');
const { translateClickHouseSql } = await import('../../../src/lib/clickhouse/sqlite-store');
const { generateTraffic, trafficShares } = await import('../../../src/lib/demo/traffic');

const NOW = Math.floor(Date.now() / 1000);
const FROM = NOW - 2 * 86400;
const HOSTS = ['jellyfin.example.com', 'photos.example.com', 'new.example.com'];
const { traffic, waf } = generateTraffic(FROM, NOW, trafficShares(HOSTS));

beforeAll(async () => {
  process.env.DEMO_MODE = 'true';
  process.env.DEMO_ANALYTICS_DB = ':memory:';
  await client.invalidateClickHouseConfig();
  await client.initClickHouse();
  await client.clearAnalyticsEvents();
  await client.insertTrafficEvents(traffic, 'demo');
  await client.insertWafEvents(waf, 'demo');
});

afterAll(async () => {
  delete process.env.DEMO_MODE;
  delete process.env.DEMO_ANALYTICS_DB;
  await client.invalidateClickHouseConfig();
});

const count = <T>(rows: T[], test: (row: T) => boolean) => rows.filter(test).length;

describe('demo analytics in SQLite', () => {
  it('is on, with no ClickHouse configured, and says it is the SQLite store', async () => {
    expect(await client.usesSqliteAnalytics()).toBe(true);
    expect(await client.isAnalyticsEnabled()).toBe(true);
  });

  it('generates a realistic amount of traffic, WAF hits included', () => {
    expect(traffic.length).toBeGreaterThan(1000);
    expect(waf.length).toBeGreaterThan(10);
  });

  it('summarises exactly what was written', async () => {
    const summary = await client.querySummary(FROM, NOW, []);
    expect(summary.totalRequests).toBe(traffic.length);
    expect(summary.uniqueIps).toBe(new Set(traffic.map((row) => row.client_ip)).size);
    expect(summary.bytesServed).toBe(traffic.reduce((sum, row) => sum + row.bytes_sent, 0));
    expect(summary.blockedRequests).toBe(
      count(traffic, (row) => row.is_blocked) + count(waf, (row) => row.blocked),
    );
  });

  it('filters by host', async () => {
    const one = await client.querySummary(FROM, NOW, ['photos.example.com']);
    expect(one.totalRequests).toBe(count(traffic, (row) => row.host === 'photos.example.com'));
  });

  it('buckets the timeline without losing a request', async () => {
    const timeline = await client.queryTimeline(FROM, NOW, []);
    expect(timeline.length).toBeGreaterThan(1);
    expect(timeline.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(traffic.length);
    expect(timeline.reduce((sum, bucket) => sum + bucket.serverErrors, 0)).toBe(
      count(traffic, (row) => row.status >= 500),
    );
  });

  it('answers every breakdown the analytics pages ask for', async () => {
    const countries = await client.queryCountries(FROM, NOW, []);
    expect(countries.reduce((sum, row) => sum + row.total, 0)).toBe(traffic.length);

    const breakdown = await client.queryCountryBreakdown(FROM, NOW, [], countries[0]!.countryCode);
    expect(breakdown.total).toBe(countries[0]!.total);
    expect(breakdown.hosts.length).toBeGreaterThan(0);

    const protocols = await client.queryProtocols(FROM, NOW, []);
    expect(protocols.reduce((sum, row) => sum + row.count, 0)).toBe(traffic.length);

    expect((await client.queryUserAgents(FROM, NOW, [])).length).toBeGreaterThan(0);

    const blocked = await client.queryBlocked(FROM, NOW, [], 1);
    expect(blocked.total).toBe(count(traffic, (row) => row.is_blocked));
    expect(blocked.events.length).toBe(Math.min(10, blocked.total));

    const classes = await client.queryStatusClasses(FROM, NOW, []);
    expect(classes.ok + classes.clientErrors + classes.serverErrors).toBe(traffic.length);

    const largest = await client.queryTrafficEvents(FROM, NOW, [], 'largest', 5);
    expect(largest[0]!.bytesSent).toBe(Math.max(...traffic.map((row) => row.bytes_sent)));

    expect((await client.queryDistinctHosts()).sort()).toEqual([...HOSTS].sort());
    const totals = await client.queryHostTotals(FROM, NOW);
    expect(totals.reduce((sum, row) => sum + row.total, 0)).toBe(traffic.length);
  });

  it('answers every WAF query', async () => {
    expect(await client.queryWafCount(FROM, NOW)).toBe(waf.length);

    const stats = await client.queryWafEventStatsWithSearch(undefined, FROM, NOW);
    expect(stats.total).toBe(waf.length);
    expect(stats.critical).toBe(count(waf, (row) => row.severity === 'CRITICAL'));
    expect(stats.ruleIdsTriggered).toBe(new Set(waf.map((row) => row.rule_id)).size);

    // Case-insensitive, as ILIKE is.
    const searched = await client.queryWafCountWithSearch('SQL INJECTION', FROM, NOW);
    expect(searched).toBe(count(waf, (row) => /sql injection/i.test(row.rule_message ?? '')));

    const rules = await client.queryTopWafRulesWithHosts(FROM, NOW, 3);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules[0]!.message).not.toBeNull();
    expect(rules[0]!.hosts.reduce((sum, host) => sum + host.count, 0)).toBe(rules[0]!.count);

    expect((await client.queryWafCountries(FROM, NOW)).length).toBeGreaterThan(0);
    const messages = await client.queryWafRuleMessages([rules[0]!.ruleId]);
    expect(messages[rules[0]!.ruleId]).toBe(rules[0]!.message);

    const events = await client.queryWafEvents(5, 0, undefined, FROM, NOW);
    expect(events).toHaveLength(Math.min(5, waf.length));
    expect(typeof events[0]!.blocked).toBe('boolean');
  });

  it('answers the WAF log structured filters', async () => {
    const sample = waf[0]!;
    const bareHost = (host: string) => host.replace(/:\d+$/, '');
    const filter = {
      host: bareHost(sample.host),
      ruleId: sample.rule_id ?? undefined,
      blocked: sample.blocked,
      severity: sample.severity?.toLowerCase(),
    };
    const expected = count(
      waf,
      (row) =>
        bareHost(row.host) === filter.host &&
        row.rule_id === sample.rule_id &&
        row.blocked === sample.blocked &&
        row.severity === sample.severity,
    );
    expect(expected).toBeGreaterThan(0);
    expect(await client.queryWafCountWithSearch(filter, FROM, NOW)).toBe(expected);
    expect(await client.queryWafCountWithSearch({ clientIp: sample.client_ip }, FROM, NOW)).toBe(
      count(waf, (row) => row.client_ip === sample.client_ip),
    );
  });
});

describe('translateClickHouseSql', () => {
  it('rewrites nested calls and typed placeholders', () => {
    const { sql, bindings } = translateClickHouseSql(
      "SELECT countIf(upperUTF8(ifNull(severity, '')) = 'CRITICAL') AS c FROM waf_events WHERE ts >= toDateTime({p_from:UInt32}) AND host ILIKE {p:String}",
      { p_from: 5, p: '%x%' },
    );
    expect(sql).toBe(
      "SELECT count(CASE WHEN upper(ifnull(severity, '')) = 'CRITICAL' THEN 1 END) AS c FROM waf_events WHERE ts >= ($p_from) AND host LIKE $p",
    );
    expect(bindings).toEqual({ $p_from: 5, $p: '%x%' });
  });

  it('keeps a literal with an escaped quote whole, commas and parentheses included', () => {
    const { sql } = translateClickHouseSql(
      "SELECT countIf(uri = 'it''s, (x') AS c, count() FROM t WHERE m = 'a'''",
      {},
    );
    expect(sql).toBe(
      "SELECT count(CASE WHEN uri = 'it''s, (x' THEN 1 END) AS c, count(*) FROM t WHERE m = 'a'''",
    );
  });

  it('leaves a function name inside a string literal alone', () => {
    const { sql } = translateClickHouseSql("SELECT count() FROM t WHERE uri = 'count()'", {});
    expect(sql).toBe("SELECT count(*) FROM t WHERE uri = 'count()'");
  });
});
