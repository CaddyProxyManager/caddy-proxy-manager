/** The overview chart's server-events line: audit rows counted into the traffic buckets. */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
const ch = vi.hoisted(() => ({ enabled: false, timeline: [] as unknown[] }));

const { createTestDb } = await import('../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));
vi.mock('../../src/lib/clickhouse/client', () => ({
  isAnalyticsEnabled: async () => ch.enabled,
  bucketSizeForDuration: (seconds: number) => (seconds <= 3600 ? 300 : 3600),
  querySummary: async () => ({
    totalRequests: 0,
    uniqueIps: 0,
    blockedRequests: 0,
    blockedPercent: 0,
    bytesServed: 0,
  }),
  queryStatusClasses: async () => ({ ok: 0, clientErrors: 0, serverErrors: 0, blocked: 0 }),
  queryWafCount: async () => 0,
  queryTimeline: async () => ch.timeline,
  queryTrafficEvents: async () => [],
}));
vi.mock('../../src/lib/agent/client', () => ({ getAllAgentStatuses: async () => [] }));

import { getOverviewAnalytics } from '../../src/lib/analytics-db';
import { auditEvents } from '../../src/lib/db/schema';

// A 24h window, so buckets are an hour wide.
const FROM = Date.parse('2026-09-29T00:00:00Z') / 1000;
const TO = FROM + 86_400;
const at = (iso: string) => ({
  userId: null,
  action: 'update',
  entityType: 'proxy_host',
  entityId: 1,
  summary: 'Updated proxy host',
  createdAt: iso,
});
const traffic = (ts: number) => ({
  ts,
  total: 100,
  blocked: 0,
  clientErrors: 0,
  serverErrors: 0,
  bytes: 1000,
});

beforeEach(async () => {
  await ctx.db.delete(auditEvents);
  ch.enabled = false;
  ch.timeline = [];
});

describe('server events on the overview timeline', () => {
  it('counts them into the traffic buckets, adding a bucket traffic did not have', async () => {
    ch.enabled = true;
    ch.timeline = [traffic(FROM), traffic(FROM + 3600)];
    await ctx.db.insert(auditEvents).values([
      at('2026-09-29T00:10:00.000Z'),
      at('2026-09-29T00:50:00.000Z'),
      at('2026-09-29T05:30:00.000Z'),
      // Outside the window.
      at('2026-09-28T23:59:00.000Z'),
    ]);

    const { timeline } = await getOverviewAnalytics(FROM, TO, [], 'all', 40);

    expect(timeline.map((b) => [b.ts - FROM, b.total, b.serverEvents])).toEqual([
      [0, 100, 2],
      [3600, 100, 0],
      [5 * 3600, 0, 1],
    ]);
  });

  it('still draws them with analytics off', async () => {
    await ctx.db.insert(auditEvents).values([at('2026-09-29T12:00:00.000Z')]);

    const { timeline, summary } = await getOverviewAnalytics(FROM, TO, [], 'all', 40);

    expect(summary.analyticsDisabled).toBe(true);
    expect(timeline).toEqual([
      {
        ts: FROM + 12 * 3600,
        total: 0,
        blocked: 0,
        clientErrors: 0,
        serverErrors: 0,
        bytes: 0,
        serverEvents: 1,
      },
    ]);
  });
});
