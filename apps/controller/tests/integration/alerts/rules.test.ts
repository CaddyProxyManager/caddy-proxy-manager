/**
 * Rules: a metric threshold over (mocked) ClickHouse raises and resolves per host, a tag scope
 * matches only tagged hosts, a quiet period and a silence suppress, Needs attention items are
 * raised and cleared, and the history shows each delivery.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';
import type { AttentionItem } from '../../../src/lib/attention/types';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  attention: [] as AttentionItem[],
}));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));
const realAttention = await import('../../../src/lib/attention');
vi.mock('../../../src/lib/attention', () => ({
  ...realAttention,
  collectAttention: async () => ({ items: ctx.attention, skipped: [], truncated: 0 }),
}));

import {
  alertEvents,
  notificationChannels,
  proxyHosts,
  settings,
} from '../../../src/lib/db/schema';
import { listHistory } from '../../../src/lib/alerts/history';
import {
  createRule,
  deleteRule,
  listRules,
  silenceRule,
  testRule,
  updateRule,
} from '../../../src/lib/alerts/rule-store';
import {
  type HostCounts,
  resetRuleWatchForTests,
  setHostMetricCountsForTests,
  watchRuleSources,
} from '../../../src/lib/alerts/watch';
import {
  flushNotifications,
  raiseProblem,
  resetNotificationsForTests,
} from '../../../src/lib/notifications';
import { forgetScopeHosts } from '../../../src/lib/notifications/rules';
import { BATCH_MS } from '../../../src/lib/notifications/plan';
import { encryptSecret } from '../../../src/lib/secrets';
import { invalidateSettingsCache } from '../../../src/lib/settings/resolve';

let server: ReturnType<typeof Bun.serve>;
let posts: { body: string }[] = [];
let channelId = 0;
let counts = new Map<string, HostCounts>();
const MIN = 60_000;

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      posts.push({ body: await request.text() });
      return new Response('ok');
    },
  });
  setHostMetricCountsForTests(async () => counts);
});

afterAll(() => {
  server.stop(true);
  setHostMetricCountsForTests(null);
});

beforeEach(async () => {
  delete process.env.SMTP_HOST;
  invalidateSettingsCache();
  posts = [];
  counts = new Map();
  ctx.attention = [];
  resetRuleWatchForTests();
  forgetScopeHosts();
  await resetNotificationsForTests();
  await ctx.db.delete(settings);
  await ctx.db.delete(proxyHosts);
  const now = new Date().toISOString();
  for (const [name, tags] of [
    ['shop', ['prod']],
    ['blog', []],
  ] as const) {
    await ctx.db.insert(proxyHosts).values({
      name,
      domains: JSON.stringify([`${name}.example.com`]),
      tags: JSON.stringify(tags),
      upstreams: JSON.stringify(['app:80']),
      createdAt: now,
      updatedAt: now,
    } as typeof proxyHosts.$inferInsert);
  }
  const [row] = await ctx.db
    .insert(notificationChannels)
    .values({
      name: 'chat',
      kind: 'slack',
      secret: encryptSecret(JSON.stringify({ url: `http://127.0.0.1:${server.port}/slack` })),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  channelId = row.id;
});

const texts = () => posts.map((post) => JSON.parse(post.body).text as string);
const t0 = Date.parse('2026-09-29T12:00:00Z');

async function tick(at: number) {
  resetRuleWatchForTests();
  await watchRuleSources(at);
  await flushNotifications(at);
}

describe('metric rules', () => {
  it('raise when a host crosses the threshold and resolve when it is back', async () => {
    await createRule(
      {
        name: '5xx share',
        source: 'metric',
        metric: 'serverErrorShare',
        comparison: 'above',
        threshold: 10,
        minutes: 5,
        channelIds: [channelId],
      },
      1,
    );
    counts.set('shop.example.com', { requests: 100, serverErrors: 30, mitigated: 0 });
    counts.set('blog.example.com', { requests: 100, serverErrors: 1, mitigated: 0 });
    await tick(t0);
    await tick(t0 + BATCH_MS);
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('shop.example.com: the 5xx share was 30% in the last 5 minutes');
    expect(texts()[0]).not.toContain('blog.example.com');

    // Still over: told once.
    await tick(t0 + 2 * BATCH_MS);
    expect(texts()).toHaveLength(1);

    counts.set('shop.example.com', { requests: 100, serverErrors: 2, mitigated: 0 });
    await tick(t0 + 3 * BATCH_MS);
    await tick(t0 + 4 * BATCH_MS);
    expect(texts()).toHaveLength(2);
    expect(texts()[1]).toContain('shop.example.com is back within the rule');
  });

  it('match only tagged hosts when scoped to a tag', async () => {
    await createRule(
      {
        name: 'prod traffic',
        source: 'metric',
        metric: 'requests',
        comparison: 'below',
        threshold: 10,
        minutes: 15,
        scope: 'tags',
        tags: ['PROD'],
        channelIds: [channelId],
      },
      1,
    );
    await tick(t0);
    await tick(t0 + BATCH_MS);
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('shop.example.com: 0 requests were served');
    expect(texts()[0]).not.toContain('blog.example.com');
  });

  it('stay quiet for their quiet period, and say nothing while silenced', async () => {
    const rule = await createRule(
      {
        name: 'errors',
        source: 'metric',
        metric: 'serverErrors',
        threshold: 5,
        minutes: 5,
        scope: 'hosts',
        hostIds: [(await ctx.db.select().from(proxyHosts))[0].id],
        quietMinutes: 30,
        channelIds: [channelId],
      },
      1,
    );
    counts.set('shop.example.com', { requests: 50, serverErrors: 9, mitigated: 0 });
    await tick(t0);
    await tick(t0 + BATCH_MS);
    counts.set('shop.example.com', { requests: 50, serverErrors: 0, mitigated: 0 });
    await tick(t0 + 2 * BATCH_MS);
    counts.set('shop.example.com', { requests: 50, serverErrors: 9, mitigated: 0 });
    await tick(t0 + 3 * BATCH_MS);
    await tick(t0 + 5 * BATCH_MS);
    // The alert and its recovery, but not the flap inside the quiet period.
    expect(texts().filter((text) => text.includes('were answered with 5xx'))).toHaveLength(1);

    counts.set('shop.example.com', { requests: 50, serverErrors: 0, mitigated: 0 });
    await tick(t0 + 31 * MIN);
    await silenceRule(rule.id, new Date(t0 + 120 * MIN).toISOString(), 1);
    counts.set('shop.example.com', { requests: 50, serverErrors: 9, mitigated: 0 });
    const before = texts().length;
    await tick(t0 + 40 * MIN);
    await tick(t0 + 41 * MIN);
    expect(texts()).toHaveLength(before);

    await silenceRule(rule.id, null, 1);
    await tick(t0 + 42 * MIN);
    await tick(t0 + 43 * MIN);
    expect(texts().at(-1)).toContain('were answered with 5xx');
  });
});

describe('event rules', () => {
  it('match an event on a host in scope, and not one outside it', async () => {
    await createRule(
      {
        name: 'prod upstreams',
        source: 'event',
        kinds: ['upstreamErrors'],
        scope: 'tags',
        tags: ['prod'],
        channelIds: [channelId],
        severity: 'critical',
      },
      1,
    );
    await raiseProblem(
      'upstream:1',
      { kind: 'upstreamErrors', host: 'shop.example.com', count: 12, minutes: 5 },
      t0,
    );
    await raiseProblem(
      'upstream:2',
      { kind: 'upstreamErrors', host: 'blog.example.com', count: 12, minutes: 5 },
      t0,
    );
    await flushNotifications(t0 + BATCH_MS);
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('shop.example.com answered 12 requests');
    expect(texts()[0]).not.toContain('blog.example.com');
  });

  it('are silenced until a time, then heard again', async () => {
    const rule = await createRule(
      { name: 'upstreams', source: 'event', kinds: ['upstreamErrors'], channelIds: [channelId] },
      1,
    );
    await silenceRule(rule.id, new Date(Date.now() + 60 * MIN).toISOString(), 1);
    await raiseProblem('upstream:1', {
      kind: 'upstreamErrors',
      host: 'shop.example.com',
      count: 12,
      minutes: 5,
    });
    await flushNotifications(Date.now() + BATCH_MS);
    expect(texts()).toHaveLength(0);
  });
});

describe('what is worth watching', () => {
  it('counts upstream errors for a rule on an added channel, with no email or push', async () => {
    const { upstreamErrorsWanted } = await import('../../../src/lib/notifications/upstream-errors');
    expect(await upstreamErrorsWanted()).toBe(false);
    await createRule(
      { name: 'upstreams', source: 'event', kinds: ['upstreamErrors'], channelIds: [channelId] },
      1,
    );
    expect(await upstreamErrorsWanted()).toBe(true);
  });
});

describe('attention and signal rules', () => {
  it('raise each matching item once and resolve it when it is gone', async () => {
    await createRule(
      { name: 'bursts', source: 'signal', signals: ['serverErrorBurst'], channelIds: [channelId] },
      1,
    );
    ctx.attention = [
      {
        id: 'burst:shop.example.com:1',
        provider: 'traffic',
        code: 'serverErrorBurst',
        severity: 'critical',
        values: {
          host: 'shop.example.com',
          errors: 40,
          share: 0.4,
          from: '2026-09-29T11:50:00.000Z',
          to: '2026-09-29T11:58:00.000Z',
          ongoing: 'yes',
        },
        href: '/proxy-hosts/1',
        at: '2026-09-29T11:58:00.000Z',
        scope: { proxyHosts: [1] },
      },
      {
        id: 'certificate:1',
        provider: 'certificates',
        code: 'certificateExpiring',
        severity: 'warning',
        values: { name: 'x', days: 3, date: '2026-10-02T00:00:00.000Z' },
        href: null,
        at: null,
        scope: {},
      },
    ];
    await tick(t0);
    await tick(t0 + BATCH_MS);
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('shop.example.com');
    ctx.attention = [];
    await tick(t0 + 2 * BATCH_MS);
    await tick(t0 + 3 * BATCH_MS);
    expect(texts()).toHaveLength(2);
    expect(texts()[1]).toContain('No longer needs attention');
  });
});

describe('managing rules and reading the history', () => {
  it('keeps built-in rules to their source, and lists every delivery', async () => {
    const rules = await listRules();
    const offline = rules.find((rule) => rule.builtin === 'agentOffline')!;
    expect(offline).toMatchObject({
      source: 'event',
      on: true,
      settingKey: 'config:notify_agent_offline',
    });
    await expect(updateRule(offline.id, { source: 'metric' }, 1)).rejects.toThrow();
    await expect(deleteRule(offline.id, 1)).rejects.toThrow();
    await updateRule(offline.id, { channelIds: [channelId], severity: 'info' }, 1);

    await expect(
      createRule({ name: 'x', source: 'event', kinds: [], channelIds: [channelId] }, 1),
    ).rejects.toThrow();
    await expect(
      createRule({ name: 'x', source: 'event', kinds: ['agentOffline'], channelIds: [999] }, 1),
    ).rejects.toThrow();

    const queued = await testRule(offline.id, 'Agent offline');
    expect(queued).toBeGreaterThan(0);
    const [event] = await ctx.db.select().from(alertEvents);
    await flushNotifications(Date.parse(event.at) + BATCH_MS);
    expect(texts()[0]).toContain('This is a test alert queued through the rule Agent offline');

    const history = await listHistory({ ruleId: offline.id });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      kind: 'ruleTest',
      severity: 'info',
      ruleBuiltin: 'agentOffline',
    });
    expect(history[0].deliveries).toMatchObject([
      { channelName: 'chat', status: 'sent', attempts: 1 },
    ]);
    expect(await listHistory({ status: 'failed' })).toHaveLength(0);
  });
});
