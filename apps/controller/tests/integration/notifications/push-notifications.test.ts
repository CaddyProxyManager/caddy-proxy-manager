/** Browser push beside the notification emails: who gets it, once per batch, and dead endpoints. */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { WebPushError } from 'web-push';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { pushSubscriptions, settings, users } from '../../../src/lib/db/schema';
import { type OutgoingEmail, setEmailDeliveryForTests } from '../../../src/lib/email/transport';
import {
  adminPushTargets,
  forgetPushForRevokedSessions,
  MAX_SUBSCRIPTIONS_PER_USER,
  parsePushSubscription,
  savePushSubscription,
} from '../../../src/lib/models/push-subscriptions';
import { createUser } from '../../../src/lib/models/user';
import {
  flushNotifications,
  getNotificationStatus,
  notify,
  raiseProblem,
  resetNotificationsForTests,
} from '../../../src/lib/notifications';
import { BATCH_MS, RETRY_MS } from '../../../src/lib/notifications/plan';
import {
  type PushPayload,
  pushPayload,
  resetPushKeysForTests,
  setPushDeliveryForTests,
  vapidKeys,
} from '../../../src/lib/notifications/push';
import { invalidateSettingsCache } from '../../../src/lib/settings/resolve';

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

  it("refuses another administrator's endpoint rather than taking it over", async () => {
    const other = await createUser({
      email: 'second@example.com',
      role: 'admin',
      provider: 'credentials',
      subject: 'c',
    });
    await savePushSubscription(adminId, subscription('shared'), 'en', null);

    await expect(
      savePushSubscription(other.id, subscription('shared'), 'en', null),
    ).rejects.toMatchObject({ code: 'pushSubscriptionInvalid' });
    const rows = await ctx.db.select().from(pushSubscriptions);
    expect(rows.map((row) => row.userId)).toEqual([adminId]);
  });

  it('keeps the newest browsers when one administrator passes the cap', async () => {
    for (let index = 0; index < MAX_SUBSCRIPTIONS_PER_USER + 2; index += 1) {
      await savePushSubscription(adminId, subscription(`browser-${index}`), 'en', null);
    }

    const rows = await ctx.db.select().from(pushSubscriptions);
    expect(rows).toHaveLength(MAX_SUBSCRIPTIONS_PER_USER);
    expect(rows.map((row) => row.endpoint)).not.toContain('https://push.example.com/browser-0');
  });

  it('drops the browsers of revoked sessions, keeping the one doing the revoking', async () => {
    await savePushSubscription(adminId, subscription('here'), 'en', null, 1);
    await savePushSubscription(adminId, subscription('there'), 'en', null, 2);
    await savePushSubscription(adminId, subscription('unknown'), 'en', null, null);

    await forgetPushForRevokedSessions(adminId, { all: true, keepSessionId: 1 });
    expect((await ctx.db.select().from(pushSubscriptions)).map((row) => row.endpoint)).toEqual([
      'https://push.example.com/here',
    ]);

    await forgetPushForRevokedSessions(adminId, { all: false, sessionIds: [1] });
    expect(await ctx.db.select().from(pushSubscriptions)).toEqual([]);
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
  const fromBrowser = (endpoint: string) => ({ ...subscription('x'), endpoint });

  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://web.push.apple.com/abc',
  ])('takes a push service endpoint: %s', (endpoint) => {
    expect(parsePushSubscription({ ...fromBrowser(endpoint), expirationTime: null })).toEqual(
      fromBrowser(endpoint),
    );
  });

  it.each([
    ['no keys', { endpoint: 'https://fcm.googleapis.com/fcm/send/x' }],
    ['a plain-http endpoint', fromBrowser('http://fcm.googleapis.com/fcm/send/x')],
    [
      'an empty key',
      { ...fromBrowser('https://fcm.googleapis.com/x'), keys: { p256dh: '', auth: 'a' } },
    ],
    ['an internal address', fromBrowser('https://10.0.0.5/x')],
    ['loopback', fromBrowser('https://[::1]/x')],
    ['a host that is not a push service', fromBrowser('https://clickhouse/x')],
    ['a look-alike host', fromBrowser('https://fcm.googleapis.com.evil.example/x')],
    ['an explicit port', fromBrowser('https://fcm.googleapis.com:8443/x')],
    ['credentials', fromBrowser('https://user:pass@fcm.googleapis.com/x')],
    ['nothing', null],
  ])('refuses %s', (_name, value) => {
    expect(() => parsePushSubscription(value)).toThrow();
  });
});
