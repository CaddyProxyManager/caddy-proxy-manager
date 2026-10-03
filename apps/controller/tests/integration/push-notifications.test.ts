/** Browser push beside the notification emails: who gets it, once per batch, and dead endpoints. */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { WebPushError } from 'web-push';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { pushSubscriptions, settings, users } from '../../src/lib/db/schema';
import { type OutgoingEmail, setEmailDeliveryForTests } from '../../src/lib/email/transport';
import {
  adminPushTargets,
  parsePushSubscription,
  savePushSubscription,
} from '../../src/lib/models/push-subscriptions';
import { createUser } from '../../src/lib/models/user';
import {
  flushNotifications,
  getNotificationStatus,
  notify,
  raiseProblem,
  resetNotificationsForTests,
} from '../../src/lib/notifications';
import { BATCH_MS, RETRY_MS } from '../../src/lib/notifications/plan';
import {
  type PushPayload,
  pushPayload,
  resetPushKeysForTests,
  setPushDeliveryForTests,
  vapidKeys,
} from '../../src/lib/notifications/push';
import { invalidateSettingsCache } from '../../src/lib/settings/resolve';

const TOUCHED_ENV = ['SMTP_HOST', 'SMTP_FROM', 'EMAIL_ALERT_RECIPIENTS'];
const T0 = Date.parse('2026-09-29T12:00:00Z');
const OFFLINE = { kind: 'agentOffline', agent: 'edge-1', minutes: 5 } as const;

let pushed: { endpoint: string; payload: PushPayload }[] = [];
let emails: OutgoingEmail[] = [];
let pushFailure: Error | null = null;
let adminId: number;

function subscription(name: string) {
  return {
    endpoint: `https://push.example.com/${name}`,
    keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
  };
}

beforeEach(async () => {
  for (const name of TOUCHED_ENV) delete process.env[name];
  invalidateSettingsCache();
  pushed = [];
  emails = [];
  pushFailure = null;
  setEmailDeliveryForTests(async (_config, message) => {
    emails.push(message);
  });
  setPushDeliveryForTests(async (target, payload) => {
    if (pushFailure) throw pushFailure;
    pushed.push({ endpoint: target.endpoint, payload: JSON.parse(payload) });
  });
  resetPushKeysForTests();
  await ctx.db.delete(pushSubscriptions);
  await ctx.db.delete(settings);
  await ctx.db.delete(users);
  await resetNotificationsForTests();
  const admin = await createUser({
    email: 'ops@example.com',
    role: 'admin',
    provider: 'credentials',
    subject: 'a',
  });
  adminId = admin.id;
});

afterAll(() => {
  setEmailDeliveryForTests(null);
  setPushDeliveryForTests(null);
  for (const name of TOUCHED_ENV) delete process.env[name];
  invalidateSettingsCache();
});

describe('browser push notifications', () => {
  it('carries notifications on its own when email is not set up', async () => {
    await savePushSubscription(adminId, subscription('ops'), 'en', 'Firefox');

    await raiseProblem('agent:1', OFFLINE, T0);
    await flushNotifications(T0 + BATCH_MS);

    expect(emails).toHaveLength(0);
    expect(pushed).toEqual([
      {
        endpoint: 'https://push.example.com/ops',
        payload: {
          title: 'Caddy Proxy Manager: Agent edge-1 is offline',
          body: expect.stringMatching(
            /^The agent edge-1 has been disconnected for more than 5 minutes\./,
          ),
          url: expect.any(String),
          tag: 'cpm-notifications',
        },
      },
    ]);
    const status = await getNotificationStatus();
    expect(status.pending).toBe(0);
    expect(status.lastSentAt).toBe(new Date(T0 + BATCH_MS).toISOString());
  });

  it('pushes a batch once, though its email is retried', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_FROM = 'proxy@example.com';
    invalidateSettingsCache();
    await savePushSubscription(adminId, subscription('ops'), 'en', null);
    setEmailDeliveryForTests(async () => {
      throw new Error('connection refused');
    });

    await raiseProblem('agent:1', OFFLINE, T0);
    await flushNotifications(T0 + BATCH_MS);
    expect(pushed).toHaveLength(1);
    expect((await getNotificationStatus()).pending).toBe(1);

    setEmailDeliveryForTests(async (_config, message) => {
      emails.push(message);
    });
    await flushNotifications(T0 + BATCH_MS + RETRY_MS);
    expect(emails).toHaveLength(1);
    expect(pushed).toHaveLength(1);
  });

  it('goes only to active administrators', async () => {
    const operator = await createUser({
      email: 'op@example.com',
      role: 'operator',
      provider: 'credentials',
      subject: 'b',
    });
    await savePushSubscription(operator.id, subscription('operator'), 'en', null);
    expect(await adminPushTargets()).toEqual([]);

    await notify('lock:1', { kind: 'adminLocked', email: 'x@example.com', failures: 6 }, 0, T0);
    await flushNotifications(T0 + BATCH_MS);
    expect(pushed).toHaveLength(0);
  });

  it('forgets a subscription the push service says is gone', async () => {
    await savePushSubscription(adminId, subscription('ops'), 'en', null);
    pushFailure = new WebPushError('Gone', 410, {}, '', 'https://push.example.com/ops');

    await raiseProblem('agent:1', OFFLINE, T0);
    await flushNotifications(T0 + BATCH_MS);

    expect(await ctx.db.select().from(pushSubscriptions)).toHaveLength(0);
  });

  it('keeps a long batch short', async () => {
    const notices = [1, 2, 3, 4, 5].map((n) => ({
      id: String(n),
      key: `agent:${n}`,
      at: new Date(T0).toISOString(),
      event: { kind: 'agentOnline' as const, agent: `edge-${n}` },
    }));

    const payload = await pushPayload(notices);

    expect(payload.title).toBe('Caddy Proxy Manager: 5 notifications');
    expect(payload.body.split('\n')).toHaveLength(4);
    expect(payload.body).toEndWith('…and 2 more');
  });

  it('moves an endpoint to whoever subscribes it last', async () => {
    const other = await createUser({
      email: 'second@example.com',
      role: 'admin',
      provider: 'credentials',
      subject: 'c',
    });
    await savePushSubscription(adminId, subscription('shared'), 'en', null);
    await savePushSubscription(other.id, subscription('shared'), 'en', null);

    const rows = await ctx.db.select().from(pushSubscriptions);
    expect(rows.map((row) => row.userId)).toEqual([other.id]);
  });
});

describe('VAPID keys', () => {
  it('are made once, and the private half is stored encrypted', async () => {
    const first = await vapidKeys();
    resetPushKeysForTests();
    const again = await vapidKeys();

    expect(again).toEqual(first);
    const rows = await ctx.db.select().from(settings);
    const stored = rows.find((row) => row.key === 'web_push_vapid');
    expect(stored?.value).toContain(first.publicKey);
    expect(stored?.value).not.toContain(first.privateKey);
  });
});

describe('subscriptions from the browser', () => {
  it('takes what PushSubscription.toJSON() gives', () => {
    expect(parsePushSubscription({ ...subscription('ok'), expirationTime: null })).toEqual(
      subscription('ok'),
    );
  });

  it.each([
    ['no keys', { endpoint: 'https://push.example.com/x' }],
    ['a plain-http endpoint', { ...subscription('x'), endpoint: 'http://push.example.com/x' }],
    ['an empty key', { ...subscription('x'), keys: { p256dh: '', auth: 'a' } }],
    ['nothing', null],
  ])('refuses %s', (_name, value) => {
    expect(() => parsePushSubscription(value)).toThrow();
  });
});
