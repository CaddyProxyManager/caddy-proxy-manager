/**
 * The daily digest: what it collects with and without ClickHouse, how it reads in each
 * recipient's time zone, that its chat forms keep to their limits, and that a slot is sent once.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';
import type { AttentionItem } from '../../../src/lib/attention/types';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  analytics: false,
  attention: [] as AttentionItem[],
  queries: [] as string[],
}));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));
const realClient = await import('../../../src/lib/clickhouse/client');
vi.mock('../../../src/lib/clickhouse/client', () => ({
  ...realClient,
  isAnalyticsEnabled: async () => ctx.analytics,
  queryRows: async (sql: string) => {
    ctx.queries.push(sql);
    if (sql.includes('count() AS requests, countIf')) return [{ requests: 1200, mitigated: 85 }];
    if (sql.includes('GROUP BY outcome')) {
      return [
        { outcome: 'waf', n: 50 },
        { outcome: 'rate_limit', n: 35 },
      ];
    }
    if (sql.includes('GROUP BY host, path'))
      return [{ host: 'shop.example.com', path: '/wp-login.php', n: 40 }];
    if (sql.includes('GROUP BY host ORDER BY n')) return [{ host: 'shop.example.com', n: 60 }];
    if (sql.includes('FROM waf_events'))
      return [{ rule_id: 942100, message: 'SQL Injection Attack', n: 30 }];
    if (sql.includes('country_code AS country')) return [{ country: 'BR' }];
    if (sql.includes('any(asn_org)')) return [{ asn: 64500, org: 'Example Net' }];
    return [];
  },
}));
const realAttention = await import('../../../src/lib/attention');
vi.mock('../../../src/lib/attention', () => ({
  ...realAttention,
  collectAttention: async () => ({ items: ctx.attention, skipped: [], truncated: 0 }),
}));

import { eq } from 'drizzle-orm';
import { alertDigestRuns, notificationChannels, settings, users } from '../../../src/lib/db/schema';
import { discordPayload, DISCORD_LIMITS } from '../../../src/lib/alerts/channels/discord';
import { teamsPayload, teamsSize, TEAMS_MAX_BYTES } from '../../../src/lib/alerts/channels/teams';
import { collectDigest, type DigestData } from '../../../src/lib/alerts/digest-content';
import { digestBatch, renderDigest } from '../../../src/lib/alerts/digest-render';
import {
  catchUpDigests,
  runDigest,
  setDigestCollectorForTests,
} from '../../../src/lib/alerts/digest-runner';
import { createDigest } from '../../../src/lib/alerts/digests';
import { alertBatch } from '../../../src/lib/alerts/message';
import { type OutgoingEmail, setEmailDeliveryForTests } from '../../../src/lib/email/transport';
import { createUser } from '../../../src/lib/models/user';
import { resetNotificationsForTests } from '../../../src/lib/notifications';
import { builtins } from '../../../src/lib/notifications/builtins';
import { encryptSecret } from '../../../src/lib/secrets';
import { invalidateSettingsCache } from '../../../src/lib/settings/resolve';

const NOW = Date.parse('2026-10-26T07:00:00Z');
let emails: OutgoingEmail[] = [];
let server: ReturnType<typeof Bun.serve>;
let posts: string[] = [];

const certificate: AttentionItem = {
  id: 'certificate:1',
  provider: 'certificates',
  code: 'certificateExpiring',
  severity: 'warning',
  values: { name: 'shop.example.com', days: 6, date: '2026-11-01T00:00:00.000Z' },
  href: '/certificates',
  at: null,
  scope: {},
};

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      posts.push(await request.text());
      return new Response('ok');
    },
  });
});

afterAll(() => {
  server.stop(true);
  setEmailDeliveryForTests(null);
  setDigestCollectorForTests(null);
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;
  invalidateSettingsCache();
});

beforeEach(async () => {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_FROM = 'proxy@example.com';
  invalidateSettingsCache();
  ctx.analytics = false;
  ctx.attention = [certificate];
  ctx.queries = [];
  emails = [];
  posts = [];
  setEmailDeliveryForTests(async (_config, message) => {
    emails.push(message);
  });
  setDigestCollectorForTests(null);
  await resetNotificationsForTests();
  await ctx.db.delete(settings);
  await ctx.db.delete(users);
});

describe('what a digest collects', () => {
  it('reports traffic, new countries and networks with ClickHouse', async () => {
    ctx.analytics = true;
    const data = await collectDigest(NOW);
    expect(data.traffic).toMatchObject({
      requests: 1200,
      mitigated: 85,
      outcomes: [
        { outcome: 'waf', count: 50 },
        { outcome: 'rate_limit', count: 35 },
      ],
      hosts: [{ host: 'shop.example.com', count: 60 }],
      newCountries: ['BR'],
      newAsns: [{ asn: 64500, org: 'Example Net' }],
    });
    expect(data.certificates).toEqual([{ name: 'shop.example.com', days: 6, expired: false }]);
    const text = (await renderDigest(data, { timeZone: 'UTC' })).sections
      .flatMap((section) => [section.title, ...section.lines])
      .join('\n');
    expect(text).toContain('1,200 requests, 85 mitigated');
    expect(text).toContain('Rate limit: 35');
    expect(text).toContain('shop.example.com/wp-login.php: 40');
    expect(text).toContain('942100 SQL Injection Attack: 30');
    expect(text).toContain('Brazil (BR)');
    expect(text).toContain('AS64500 Example Net');
    expect(text).toContain('shop.example.com: 6 days left');
  });

  it('degrades without ClickHouse, asking it nothing', async () => {
    const data = await collectDigest(NOW);
    expect(data.analyticsOn).toBe(false);
    expect(data.traffic).toBeNull();
    expect(ctx.queries).toEqual([]);
    const rendered = await renderDigest(data, { timeZone: 'UTC' });
    expect(rendered.sections[0].lines).toEqual([
      'Analytics are off, so there is no traffic to report.',
    ]);
    expect(rendered.sections.map((section) => section.title)).toContain('Needs attention');
  });

  it('renders every section from a catalog key that exists', async () => {
    ctx.analytics = true;
    const data: DigestData = {
      ...(await collectDigest(NOW)),
      changes: {
        total: 2,
        recent: [
          {
            action: 'create',
            entityType: 'alert_rule',
            summary: 'Created alert rule prod',
            at: '2026-10-26T06:00:00Z',
          },
          { action: 'odd', entityType: 'thing', summary: null, at: '2026-10-26T05:00:00Z' },
        ],
      },
      backups: [
        { name: 'nightly', status: 'succeeded', at: '2026-10-26T02:00:00Z' },
        { name: 'weekly', status: null, at: null },
      ],
      traffic: {
        ...(await collectDigest(NOW)).traffic!,
        outcomes: [
          'served',
          'waf',
          'geo',
          'access',
          'auth',
          'rate_limit',
          'crowdsec',
          'blocked',
        ].map((outcome) => ({ outcome, count: 1 })),
      },
    };
    const rendered = await renderDigest(data, { timeZone: 'Europe/Berlin' });
    const text = JSON.stringify(rendered);
    for (const raw of ['email.', 'digest.', 'analytics.outcomes', 'attention.items', 'auditLog.']) {
      expect(text).not.toContain(raw);
    }
    expect(text).toContain('Created alert rule prod');
    expect(text).toContain('weekly: not run yet');
  });
});

describe('who reads a digest, and how', () => {
  it("renders each recipient's copy in their own time zone", async () => {
    setDigestCollectorForTests(async (now) => ({
      from: now - 86_400_000,
      to: now,
      analyticsOn: false,
      traffic: null,
      certificates: [],
      changes: { total: 0, recent: [] },
      backups: [],
      attention: { total: 0, items: [] },
    }));
    const tokyo = await createUser({
      email: 'tokyo@example.com',
      role: 'admin',
      provider: 'credentials',
      subject: 't',
    });
    await ctx.db.update(users).set({ timeZone: 'Asia/Tokyo' }).where(eq(users.id, tokyo.id));
    await createUser({
      email: 'ny@example.com',
      role: 'admin',
      provider: 'credentials',
      subject: 'n',
    });
    const { email } = await builtins();
    const digest = await createDigest(
      { name: 'morning', time: '08:00', timeZone: 'America/New_York', channelIds: [email] },
      1,
    );
    expect(await runDigest(digest.id, NOW, 'schedule', () => NOW)).not.toBeNull();
    expect(emails).toHaveLength(2);
    const to = (address: string) => emails.find((mail) => [mail.to].flat().includes(address))!;
    expect(to('tokyo@example.com').text).toContain('Oct 26, 2026, 04:00 PM GMT+9');
    expect(to('ny@example.com').text).toContain('Oct 26, 2026, 03:00 AM EDT');
    expect(to('ny@example.com').subject).toBe('Caddy Proxy Manager: daily digest for Oct 26, 2026');
  });
});

describe('chat forms', () => {
  it('stay inside the Discord and Teams limits however much there is', async () => {
    const huge = await renderDigest(
      {
        from: NOW - 86_400_000,
        to: NOW,
        analyticsOn: true,
        traffic: {
          requests: 1,
          mitigated: 1,
          outcomes: [],
          hosts: Array.from({ length: 5 }, (_, i) => ({
            host: `${'h'.repeat(200)}${i}`,
            count: i,
          })),
          paths: Array.from({ length: 5 }, (_, i) => ({
            host: 'x',
            path: `/${'p'.repeat(1500)}${i}`,
            count: i,
          })),
          rules: [],
          newCountries: [],
          newAsns: Array.from({ length: 20 }, (_, i) => ({ asn: i + 1, org: 'o'.repeat(300) })),
        },
        certificates: Array.from({ length: 40 }, (_, i) => ({
          name: `${'c'.repeat(100)}${i}`,
          days: 3,
          expired: false,
        })),
        changes: {
          total: 10,
          recent: Array.from({ length: 10 }, () => ({
            action: 'x',
            entityType: 'y',
            summary: 's'.repeat(900),
            at: '2026-10-26T05:00:00Z',
          })),
        },
        backups: [],
        attention: { total: 0, items: [] },
      },
      { timeZone: 'UTC' },
    );
    const batch = digestBatch(huge, await alertBatch([]), NOW);
    const discord = discordPayload(batch);
    expect(discord.embeds.length).toBeLessThanOrEqual(DISCORD_LIMITS.embeds);
    const total = discord.embeds.reduce(
      (sum, embed) =>
        sum + embed.title.length + embed.description.length + embed.footer.text.length,
      0,
    );
    expect(total).toBeLessThanOrEqual(DISCORD_LIMITS.total);
    expect(discord.content.length).toBeLessThanOrEqual(DISCORD_LIMITS.content);
    expect(discord.embeds.every((embed) => embed.fields.length === 0)).toBe(true);
    expect(teamsSize(teamsPayload(batch))).toBeLessThan(TEAMS_MAX_BYTES);
  });

  it('posts the compact form to a chat channel, as a digest to a webhook', async () => {
    setDigestCollectorForTests(async (now) => collectDigest(now));
    const at = new Date().toISOString();
    const [hook] = await ctx.db
      .insert(notificationChannels)
      .values({
        name: 'hook',
        kind: 'webhook',
        secret: encryptSecret(
          JSON.stringify({
            url: `http://127.0.0.1:${server.port}/hook`,
            signingSecret: `whsec_${Buffer.alloc(32, 7).toString('base64')}`,
          }),
        ),
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    const digest = await createDigest(
      { name: 'ops', time: '07:00', timeZone: 'UTC', channelIds: [hook.id] },
      1,
    );
    await runDigest(digest.id, NOW, 'manual', () => NOW);
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0]);
    expect(body.type).toBe('digest');
    expect(body.data.alerts.map((item: { title: string }) => item.title)).toContain(
      'Needs attention',
    );
    const [run] = await ctx.db.select().from(alertDigestRuns);
    expect(run.status).toBe('sent');
    expect(JSON.parse(run.results)).toEqual([{ channelId: hook.id, name: 'hook', ok: true }]);
  });
});

describe('one send per slot', () => {
  it('claims a slot once, however many workers fire it, and catches up only the latest', async () => {
    await createUser({
      email: 'ops@example.com',
      role: 'admin',
      provider: 'credentials',
      subject: 'a',
    });
    const { email } = await builtins();
    const digest = await createDigest(
      { name: 'daily', time: '07:00', timeZone: 'UTC', channelIds: [email] },
      1,
    );
    const ran = await Promise.all([
      runDigest(digest.id, NOW, 'schedule', () => NOW),
      runDigest(digest.id, NOW, 'schedule', () => NOW),
    ]);
    expect(ran.filter((id) => id !== null)).toHaveLength(1);
    expect(emails).toHaveLength(1);

    // A leader taking over two days on owes the latest slot only, and only once.
    await ctx.db
      .update((await import('../../../src/lib/db/schema')).alertDigests)
      .set({ scheduledSince: new Date(NOW - 5 * 86_400_000).toISOString() });
    const [loaded] = await (await import('../../../src/lib/alerts/digests')).listEnabledDigests();
    expect(await catchUpDigests([loaded], NOW + 2 * 86_400_000 + 60_000)).toEqual([digest.id]);
    expect(await catchUpDigests([loaded], NOW + 2 * 86_400_000 + 120_000)).toEqual([]);
    const slots = (await ctx.db.select().from(alertDigestRuns)).map((run) => run.slot).sort();
    expect(slots).toEqual([NOW, NOW + 2 * 86_400_000]);
  });
});
