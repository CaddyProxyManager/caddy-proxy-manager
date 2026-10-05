/** The signal queries group by the client's Host header, so they are capped in time and rows. */
import { describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';

const ctx = vi.hoisted(() => ({
  queries: [] as { sql: string; params: Record<string, unknown> }[],
}));

const actual = await import('@/src/lib/clickhouse/client');
vi.mock('@/src/lib/clickhouse/client', () => ({
  ...actual,
  isAnalyticsEnabled: async () => true,
  queryRows: async (sql: string, params: Record<string, unknown>) => {
    ctx.queries.push({ sql, params });
    return [];
  },
  timeFilter: () => 'ts >= toDateTime({p_from:UInt32}) AND ts <= toDateTime({p_to:UInt32})',
  timeParams: (from: number, to: number) => ({ p_from: from, p_to: to }),
}));

const { MAX_SIGNAL_WINDOW_SECONDS, detectTrafficSignals } = await import(
  '@/src/lib/analytics/signals'
);

describe('detectTrafficSignals bounds', () => {
  it('caps the window at 92 days and limits every host grouping', async () => {
    ctx.queries = [];
    const to = 1_800_000_000;
    const result = await detectTrafficSignals({ window: { from: 0, to }, now: to });
    expect(result.window).toEqual({ from: to - MAX_SIGNAL_WINDOW_SECONDS, to });
    expect(ctx.queries).toHaveLength(3);
    for (const { sql, params } of ctx.queries) {
      expect(sql).toContain('LIMIT {p_limit:UInt32}');
      expect(params.p_from).toBe(to - MAX_SIGNAL_WINDOW_SECONDS);
    }
  });
});

describe('queryWafEventsByHost bounds', () => {
  it('returns only the busiest Host groups', async () => {
    const { queryWafEventsByHost } = await import('@/src/lib/clickhouse/security');
    ctx.queries = [];
    await queryWafEventsByHost(0, 100);
    expect(ctx.queries[0]?.sql).toMatch(/ORDER BY events DESC LIMIT \{p_limit:UInt32\}/);
    expect(ctx.queries[0]?.params.p_limit).toBeGreaterThan(0);
  });
});
