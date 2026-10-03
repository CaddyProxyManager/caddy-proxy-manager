/** With analytics off, the overview must not query a ClickHouse that is not there and 500. */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '@/tests/helpers/db';
import { dbModuleMock } from '@/tests/helpers/db-module';

const ch = vi.hoisted(() => ({
  isAnalyticsEnabled: vi.fn(),
  querySummary: vi.fn(),
  queryStatusClasses: vi.fn(),
  queryWafCount: vi.fn(),
  queryTimeline: vi.fn(),
  queryTrafficEvents: vi.fn(),
  bucketSizeForDuration: (seconds: number) => (seconds <= 3600 ? 300 : 3600),
}));

vi.mock('@/src/lib/db', () => dbModuleMock(() => ({}) as TestDb));
vi.mock('@/src/lib/clickhouse/client', () => ch);
vi.mock('@/src/lib/agent/client', () => ({
  getAllAgentStatuses: vi
    .fn()
    .mockResolvedValue([
      { agent: 'a', ok: true, value: { analytics: { accessLogPresent: true } } },
    ]),
}));

import { getOverviewAnalytics } from '@/src/lib/analytics-db';

beforeEach(() => {
  for (const fn of Object.values(ch)) if ('mockReset' in fn) fn.mockReset();
});

describe('getOverviewAnalytics', () => {
  it('asks ClickHouse nothing when analytics is off, and says so', async () => {
    ch.isAnalyticsEnabled.mockResolvedValue(false);

    const result = await getOverviewAnalytics(0, 3600, [], 'all', 40);

    expect(result.summary.analyticsDisabled).toBe(true);
    expect(result.summary.totalRequests).toBe(0);
    expect(result.events).toEqual([]);
    expect(result.timeline).toEqual([]);
    for (const query of [
      ch.querySummary,
      ch.queryStatusClasses,
      ch.queryWafCount,
      ch.queryTimeline,
      ch.queryTrafficEvents,
    ]) {
      expect(query).not.toHaveBeenCalled();
    }
  });

  it('queries as before when analytics is on', async () => {
    ch.isAnalyticsEnabled.mockResolvedValue(true);
    ch.querySummary.mockResolvedValue({
      totalRequests: 5,
      uniqueIps: 1,
      blockedRequests: 0,
      blockedPercent: 0,
      bytesServed: 10,
    });
    ch.queryStatusClasses.mockResolvedValue({
      ok: 5,
      clientErrors: 0,
      serverErrors: 0,
      blocked: 0,
    });
    ch.queryWafCount.mockResolvedValue(0);
    ch.queryTimeline.mockResolvedValue([]);
    ch.queryTrafficEvents.mockResolvedValue([]);

    const result = await getOverviewAnalytics(0, 3600, [], 'all', 40);

    expect(result.summary.totalRequests).toBe(5);
    expect(result.summary.analyticsDisabled).toBe(false);
    expect(ch.queryTrafficEvents).toHaveBeenCalledWith(0, 3600, [], 'all', 40);
  });
});
