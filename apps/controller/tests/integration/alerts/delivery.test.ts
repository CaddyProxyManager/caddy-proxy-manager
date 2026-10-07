/**
 * Alert channels against a receiver on this machine, through the real outbound client: each kind
 * delivers, retries back off, rate limits are honoured, a claim sends once, and a failing channel
 * is told about on the others.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Webhook } from 'standardwebhooks';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { eq } from 'drizzle-orm';
import {
  alertDeliveries,
  alertRules,
  notificationChannels,
  settings,
} from '../../../src/lib/db/schema';
import { getChannel } from '../../../src/lib/alerts/channel-store';
import { setSleepForTests } from '../../../src/lib/alerts/channels/send';
import { generateSigningSecret } from '../../../src/lib/alerts/channels/webhook';
import { flushChannel } from '../../../src/lib/alerts/deliver';
import {
  flushNotifications,
  notify,
  resetNotificationsForTests,
} from '../../../src/lib/notifications';
import { builtins } from '../../../src/lib/notifications/builtins';
import { BATCH_MS } from '../../../src/lib/notifications/plan';
import { encryptSecret } from '../../../src/lib/secrets';
import { invalidateSettingsCache } from '../../../src/lib/settings/resolve';

type Hit = { path: string; search: string; headers: Record<string, string>; body: string };
type Answer = { status: number; body?: string; headers?: Record<string, string> };

let hits: Hit[] = [];
/** Answers per path, used up in order; then 200. */
let answers: Record<string, Answer[]> = {};
let server: ReturnType<typeof Bun.serve>;
let base = '';
let slept: number[] = [];
const SECRET = generateSigningSecret();
const LOCKED = { kind: 'adminLocked', email: 'root@example.com', failures: 6 } as const;

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      hits.push({
        path: url.pathname,
        search: url.search,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      const answer = answers[url.pathname]?.shift() ?? { status: 200, body: '{}' };
      return new Response(answer.body ?? '', { status: answer.status, headers: answer.headers });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  setSleepForTests(null);
});

beforeEach(async () => {
  delete process.env.SMTP_HOST;
  invalidateSettingsCache();
  hits = [];
  answers = {};
  slept = [];
  setSleepForTests(async (ms) => {
    slept.push(ms);
  });
  await resetNotificationsForTests();
  await ctx.db.delete(settings);
});

async function channel(
  name: string,
  kind: string,
  secret: Record<string, unknown>,
  config: Record<string, unknown> = {},
): Promise<number> {
  const at = new Date().toISOString();
  const [row] = await ctx.db
    .insert(notificationChannels)
    .values({
      name,
      kind,
      config: JSON.stringify(config),
      secret: encryptSecret(JSON.stringify(secret)),
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  return row.id;
}

async function rule(channelIds: number[], kinds: string[] = ['adminLocked']): Promise<number> {
  const at = new Date().toISOString();
  const [row] = await ctx.db
    .insert(alertRules)
    .values({
      name: 'locks',
      source: 'event',
      sourceConfig: JSON.stringify({ kinds }),
      severity: 'critical',
      channelIds: JSON.stringify(channelIds),
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  return row.id;
}

async function deliveries(channelId: number) {
  return ctx.db.select().from(alertDeliveries).where(eq(alertDeliveries.channelId, channelId));
}

describe('alert channels', () => {
  it('each kind delivers to a local receiver through the outbound client', async () => {
    const ids = [
      await channel('hook', 'webhook', {
        url: `${base}/hook`,
        signingSecret: SECRET,
        headers: [{ name: 'X-Team', value: 'ops' }],
      }),
      await channel('discord', 'discord', { url: `${base}/discord?thread_id=4` }),
      await channel('slack', 'slack', { url: `${base}/slack` }),
      await channel('teams', 'teams', { url: `${base}/teams` }),
      await channel('ntfy', 'ntfy', { token: 'tk_1' }, { server: base, topic: 'cpm' }),
    ];
    await rule(ids);
    const now = Date.now();
    await notify('lock:1', LOCKED, 0, now);
    await flushNotifications(now + BATCH_MS);

    const by = (path: string) => hits.find((hit) => hit.path === path)!;
    expect(hits.map((hit) => hit.path).sort()).toEqual([
      '/',
      '/discord',
      '/hook',
      '/slack',
      '/teams',
    ]);

    const hook = by('/hook');
    expect(new Webhook(SECRET).verify(hook.body, hook.headers)).toMatchObject({
      type: 'alerts',
      data: { alerts: [{ kind: 'adminLocked', severity: 'critical' }] },
    });
    expect(hook.headers['x-team']).toBe('ops');

    expect(by('/discord').search).toBe('?thread_id=4&wait=true');
    expect(JSON.parse(by('/discord').body).embeds[0].title).toBe('Administrator account locked');
    expect(JSON.parse(by('/slack').body).text).toContain('root@example.com');
    expect(JSON.parse(by('/teams').body).attachments[0].content.type).toBe('AdaptiveCard');
    const ntfy = by('/');
    expect(ntfy.headers.authorization).toBe('Bearer tk_1');
    expect(JSON.parse(ntfy.body)).toMatchObject({ topic: 'cpm', priority: 5 });

    for (const id of ids) {
      const [row] = await deliveries(id);
      expect(row).toMatchObject({ status: 'sent', attempts: 1, lastError: null });
    }
  });

  it('retries with growing waits, recording attempts and the last error', async () => {
    const id = await channel('hook', 'webhook', { url: `${base}/hook`, signingSecret: SECRET });
    await rule([id]);
    answers['/hook'] = [
      { status: 500, body: 'down' },
      { status: 503, body: 'still down' },
    ];
    const t0 = Date.now();
    await notify('lock:1', LOCKED, 0, t0);
    await flushNotifications(t0 + BATCH_MS);
    let [row] = await deliveries(id);
    expect(row).toMatchObject({ status: 'pending', attempts: 1, lastError: 'HTTP 500 down' });
    const failed = (await getChannel(id))!;
    expect(failed.failures).toBe(1);
    expect(Date.parse(failed.retryAt!)).toBe(t0 + BATCH_MS + 30_000);

    await flushNotifications(t0 + BATCH_MS + 29_000);
    expect(hits).toHaveLength(1);
    await flushNotifications(t0 + BATCH_MS + 30_000);
    expect(hits).toHaveLength(2);
    expect(Date.parse((await getChannel(id))!.retryAt!)).toBe(t0 + BATCH_MS + 30_000 + 60_000);
    // The same deliveries keep their id, so the receiver can drop a replay.
    expect(hits[1].headers['webhook-id']).toBe(hits[0].headers['webhook-id']);

    await flushNotifications(t0 + BATCH_MS + 90_000);
    [row] = await deliveries(id);
    expect(row).toMatchObject({ status: 'sent', attempts: 3, lastError: null });
    expect((await getChannel(id))!).toMatchObject({ failures: 0, retryAt: null });
  });

  it("waits Discord's float retry_after, and Slack's and Teams' Retry-After", async () => {
    const discord = await channel('discord', 'discord', { url: `${base}/discord` });
    const slack = await channel('slack', 'slack', { url: `${base}/slack` });
    const teams = await channel('teams', 'teams', { url: `${base}/teams` });
    await rule([discord, slack, teams]);
    answers['/discord'] = [
      {
        status: 429,
        body: '{"message":"You are being rate limited.","retry_after":0.347,"global":false}',
        headers: { 'retry-after': '1', 'content-type': 'application/json' },
      },
    ];
    answers['/slack'] = [{ status: 429, headers: { 'retry-after': '2' } }];
    answers['/teams'] = [{ status: 429, headers: { 'retry-after': '120' } }];
    const now = Date.now();
    await notify('lock:1', LOCKED, 0, now);
    await flushNotifications(now + BATCH_MS);

    expect(slept.sort((a, b) => a - b)).toEqual([347, 2000]);
    expect((await deliveries(discord))[0].status).toBe('sent');
    expect((await deliveries(slack))[0].status).toBe('sent');
    // Too long to wait inline: the channel backs off for as long as Teams asked.
    expect((await deliveries(teams))[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(Date.parse((await getChannel(teams))!.retryAt!)).toBe(now + BATCH_MS + 120_000);
  });

  it('sends a delivery once though two workers flush it together', async () => {
    const id = await channel('hook', 'webhook', { url: `${base}/hook`, signingSecret: SECRET });
    await rule([id]);
    const now = Date.now();
    await notify('lock:1', LOCKED, 0, now);
    const loaded = (await getChannel(id))!;
    await Promise.all([flushChannel(loaded, now + BATCH_MS), flushChannel(loaded, now + BATCH_MS)]);
    expect(hits).toHaveLength(1);
    expect((await deliveries(id))[0]).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('tells the other channels when one keeps failing, then that it works again', async () => {
    const discord = await channel('team-discord', 'discord', { url: `${base}/discord` });
    const slack = await channel('team-slack', 'slack', { url: `${base}/slack` });
    await rule([discord]);
    const { rules } = await builtins();
    await ctx.db
      .update(alertRules)
      .set({ channelIds: JSON.stringify([discord, slack]) })
      .where(eq(alertRules.id, rules.get('channels')!.id));
    answers['/discord'] = [
      { status: 500, body: 'a' },
      { status: 500, body: 'b' },
      { status: 500, body: 'c' },
    ];

    const t0 = Date.now();
    await notify('lock:1', LOCKED, 0, t0);
    let at = t0 + BATCH_MS;
    for (let i = 0; i < 2; i++) {
      await flushNotifications(at);
      at = Date.parse((await getChannel(discord))!.retryAt!);
    }
    await flushNotifications(at);
    const third = at;
    // Told on Slack once its batch window passes, before Discord is tried again.
    await flushNotifications(third + BATCH_MS);
    const told = hits.filter((hit) => hit.path === '/slack');
    expect(told).toHaveLength(1);
    expect(JSON.parse(told[0].body).text).toContain(
      'Alerts to team-discord failed 3 times in a row: HTTP 500 c.',
    );
    expect(hits.filter((hit) => hit.path === '/discord')).toHaveLength(3);

    await flushNotifications(Date.parse((await getChannel(discord))!.retryAt!));
    const discordHits = hits.filter((hit) => hit.path === '/discord');
    expect(discordHits).toHaveLength(4);
    expect(discordHits[3].body).not.toContain('failed 3 times');
    await flushNotifications(Date.parse((await getChannel(discord))!.lastSentAt!) + BATCH_MS);
    const recovered = hits.filter((hit) => hit.path === '/slack');
    expect(recovered).toHaveLength(2);
    expect(JSON.parse(recovered[1].body).text).toContain('Alerts reach team-discord again.');
  });
});
