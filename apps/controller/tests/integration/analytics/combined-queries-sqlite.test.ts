/**
 * The analytics and security pages fold several scans into one. The demo's SQLite store answers
 * them too - by the fallback, where it has no GROUPING SETS or WITH TOTALS - and every answer must
 * be exactly what the queries they replace return. combined-queries-clickhouse.test.ts runs the
 * same comparisons against a real ClickHouse.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { compareCombinedQueries, comparisonFilters } from '@/tests/helpers/analytics-comparisons';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
const { createTestDb } = await import('../../helpers/db');
ctx.db = await createTestDb();
vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

const client = await import('../../../src/lib/clickhouse/client');
const { translateClickHouseSql } = await import('../../../src/lib/clickhouse/sqlite-store');
const { queryExploreTop } = await import('../../../src/lib/clickhouse/explore');
const { getAnalyticsReport } = await import('../../../src/lib/analytics/explore');
const { DEFAULT_EXPLORE_STATE, TOP_DIMENSIONS } = await import(
  '../../../src/lib/analytics/explore-state'
);
const { generateTraffic, trafficShares } = await import('../../../src/lib/demo/traffic');

const NOW = Math.floor(Date.now() / 1000);
const HOSTS = ['jellyfin.example.com', 'photos.example.com', 'new.example.com'];
const { traffic, waf } = generateTraffic(NOW - 3 * 86400, NOW, trafficShares(HOSTS));
const ruleId = waf.find((event) => event.rule_id)?.rule_id ?? 942100;

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

describe('combined analytics queries in the SQLite store', () => {
  it('translates uniqIf to a distinct count of the matching rows', () => {
    expect(translateClickHouseSql("SELECT uniqIf(client_ip, outcome != 'served')", {}).sql).toBe(
      "SELECT count(DISTINCT CASE WHEN outcome != 'served' THEN client_ip END)",
    );
  });

  for (const window of [
    { from: NOW - 86400, to: NOW },
    { from: NOW - 2 * 86400, to: NOW - 3600 },
  ]) {
    it(`answers as the separate queries do, ${window.to - window.from}s`, async () => {
      for (const filters of comparisonFilters(ruleId)) {
        for (const [name, combined, separate] of await compareCombinedQueries(window, filters)) {
          expect({ name, value: combined }).toEqual({ name, value: separate });
        }
      }
    });
  }

  it('gives the report every list the one-list query gives', async () => {
    const report = await getAnalyticsReport(DEFAULT_EXPLORE_STATE, NOW);
    expect(report.totals.requests).toBeGreaterThan(0);
    for (const dimension of TOP_DIMENSIONS) {
      expect(report.top[dimension]).toEqual(
        await queryExploreTop(report.window, [], dimension, 10),
      );
    }
    expect(report.countries).toEqual(await queryExploreTop(report.window, [], 'country', 300));
  });
});
