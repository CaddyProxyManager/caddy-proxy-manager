/**
 * The combined analytics queries against a real ClickHouse, where GROUPING SETS and WITH TOTALS
 * run. Opt-in: TEST_CLICKHOUSE_URL (with TEST_CLICKHOUSE_USER, _PASSWORD and _DB, else `default`)
 * names a throwaway server, whose analytics tables this empties.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { compareCombinedQueries, comparisonFilters } from '@/tests/helpers/analytics-comparisons';
import type { TestDb } from '../../helpers/db';

const URL = process.env.TEST_CLICKHOUSE_URL;

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
const { createTestDb } = await import('../../helpers/db');
ctx.db = await createTestDb();
vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

const client = await import('../../../src/lib/clickhouse/client');
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

describe.if(Boolean(URL))('combined analytics queries in ClickHouse', () => {
  beforeAll(async () => {
    process.env.CLICKHOUSE_URL = URL;
    process.env.CLICKHOUSE_USER = process.env.TEST_CLICKHOUSE_USER ?? 'default';
    process.env.CLICKHOUSE_PASSWORD = process.env.TEST_CLICKHOUSE_PASSWORD ?? '';
    process.env.CLICKHOUSE_DB = process.env.TEST_CLICKHOUSE_DB ?? 'default';
    await client.invalidateClickHouseConfig();
    await client.initClickHouse();
    await client.clearAnalyticsEvents();
    await client.insertTrafficEvents(traffic, 'test');
    await client.insertWafEvents(waf, 'test');
    // Inserts are async on the server; wait until they are all readable.
    for (let i = 0; i < 50; i++) {
      const row = await client.queryRow<{ n: string }>('SELECT count() AS n FROM traffic_events');
      if (Number(row?.n) >= traffic.length) break;
      await Bun.sleep(200);
    }
  });

  afterAll(async () => {
    for (const key of [
      'CLICKHOUSE_URL',
      'CLICKHOUSE_USER',
      'CLICKHOUSE_PASSWORD',
      'CLICKHOUSE_DB',
    ]) {
      delete process.env[key];
    }
    await client.invalidateClickHouseConfig();
  });

  it('answers as the separate queries do', async () => {
    for (const window of [
      { from: NOW - 86400, to: NOW },
      { from: NOW - 2 * 86400, to: NOW - 3600 },
    ]) {
      for (const filters of comparisonFilters(ruleId)) {
        for (const [name, combined, separate] of await compareCombinedQueries(window, filters)) {
          expect({ name, value: combined }).toEqual({ name, value: separate });
        }
      }
    }
  });

  it('gives the report every list the one-list query gives', async () => {
    const report = await getAnalyticsReport(DEFAULT_EXPLORE_STATE, NOW);
    for (const dimension of TOP_DIMENSIONS) {
      expect(report.top[dimension]).toEqual(
        await queryExploreTop(report.window, [], dimension, 10),
      );
    }
    expect(report.countries).toEqual(await queryExploreTop(report.window, [], 'country', 300));
  });
});
