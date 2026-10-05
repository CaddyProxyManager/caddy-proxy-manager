/** Each administrator's own notification choices, beside the Recipients list's extra addresses. */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
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
  getNotificationPreferences,
  parseNotificationPreferences,
  setNotificationPreferences,
} from '../../../src/lib/models/notification-preferences';
import { savePushSubscription } from '../../../src/lib/models/push-subscriptions';
import { createUser } from '../../../src/lib/models/user';
import {
  flushNotifications,
  raiseProblem,
  resetNotificationsForTests,
  sendTestNotification,
} from '../../../src/lib/notifications';
import { notificationProfileView } from '../../../src/lib/notifications/audience';
import { BATCH_MS, RETRY_MS } from '../../../src/lib/notifications/plan';
import {
  resetPushKeysForTests,
  setPushDeliveryForTests,
} from '../../../src/lib/notifications/push';
import { invalidateSettingsCache } from '../../../src/lib/settings/resolve';

const TOUCHED_ENV = ['SMTP_HOST', 'SMTP_FROM', 'EMAIL_ALERT_RECIPIENTS'];
const T0 = Date.parse('2026-09-29T12:00:00Z');
const OFFLINE = { kind: 'agentOffline', agent: 'edge-1', minutes: 5 } as const;
const LOCKED = { kind: 'adminLocked', email: 'x@example.com', failures: 6 } as const;

let emails: OutgoingEmail[] = [];
let pushed: string[] = [];
let ops: number;
let dev: number;

const browser = (name: string) => ({
  endpoint: `https://push.example.com/${name}`,
  keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
});
const recipientsOf = (email: OutgoingEmail) => [email.to].flat().sort();

async function raiseBoth() {
  await raiseProblem('agent:1', OFFLINE, T0);
  await raiseProblem('lock:1', LOCKED, T0);
  await flushNotifications(T0 + BATCH_MS);
}

beforeEach(async () => {
  for (const name of TOUCHED_ENV) delete process.env[name];
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_FROM = 'proxy@example.com';
  invalidateSettingsCache();
  emails = [];
  pushed = [];
  setEmailDeliveryForTests(async (_config, message) => {
    emails.push(message);
  });
  setPushDeliveryForTests(async (target) => {
    pushed.push(target.endpoint);
  });
  resetPushKeysForTests();
  await ctx.db.delete(pushSubscriptions);
  await ctx.db.delete(settings);
  await ctx.db.delete(users);
  await resetNotificationsForTests();
  ops = (
    await createUser({
      email: 'ops@example.com',
      role: 'admin',
      provider: 'credentials',
      subject: 'a',
    })
  ).id;
  dev = (
    await createUser({
      email: 'dev@example.com',
      role: 'admin',
      provider: 'credentials',
      subject: 'b',
    })
  ).id;
});

afterAll(() => {
  setEmailDeliveryForTests(null);
  setPushDeliveryForTests(null);
  for (const name of TOUCHED_ENV) delete process.env[name];
  invalidateSettingsCache();
});

describe('per-administrator notifications', () => {
  it('emails every administrator by default, in one email', async () => {
    await raiseBoth();

    expect(emails).toHaveLength(1);
    expect(recipientsOf(emails[0])).toEqual(['dev@example.com', 'ops@example.com']);
  });

  it("leaves a muted event out of that administrator's copy only", async () => {
    await setNotificationPreferences(dev, { email: true, push: true, muted: ['agentOffline'] });

    await raiseBoth();

    expect(emails).toHaveLength(2);
    const both = emails.find((email) => recipientsOf(email).includes('ops@example.com'));
    const devs = emails.find((email) => recipientsOf(email).includes('dev@example.com'));
    expect(both?.subject).toBe('Caddy Proxy Manager: 2 notifications');
    expect(devs?.subject).toBe('Caddy Proxy Manager: Administrator account locked');
  });

  it('pushes instead of emailing an administrator who turned email off', async () => {
    await setNotificationPreferences(dev, { email: false, push: true, muted: [] });
    await savePushSubscription(dev, browser('dev'), 'en', null);

    await raiseBoth();

    expect(emails.flatMap(recipientsOf)).toEqual(['ops@example.com']);
    expect(pushed).toEqual(['https://push.example.com/dev']);
  });

  it('does not push to an administrator who turned browser notifications off', async () => {
    await setNotificationPreferences(dev, { email: true, push: false, muted: [] });
    await savePushSubscription(dev, browser('dev'), 'en', null);

    await raiseBoth();

    expect(pushed).toEqual([]);
  });

  it('treats the Recipients list as extras, and as who is emailed until someone chooses', async () => {
    process.env.EMAIL_ALERT_RECIPIENTS = 'team@example.com, ops@example.com';
    invalidateSettingsCache();

    await raiseBoth();
    expect(emails.flatMap(recipientsOf).sort()).toEqual(['ops@example.com', 'team@example.com']);

    // Listed, yet their own choice decides.
    await setNotificationPreferences(ops, { email: false, push: true, muted: [] });
    await setNotificationPreferences(dev, { email: true, push: true, muted: [] });
    emails = [];
    await raiseProblem('agent:2', { ...OFFLINE, agent: 'edge-2' }, T0 + BATCH_MS);
    await flushNotifications(T0 + 2 * BATCH_MS);
    expect(emails.flatMap(recipientsOf).sort()).toEqual(['dev@example.com', 'team@example.com']);
  });

  it('retries only to whoever did not get the batch', async () => {
    await setNotificationPreferences(dev, { email: true, push: true, muted: ['agentOffline'] });
    let failOps = true;
    setEmailDeliveryForTests(async (_config, message) => {
      if (failOps && recipientsOf(message).includes('ops@example.com')) {
        throw new Error('mailbox busy');
      }
      emails.push(message);
    });

    await raiseBoth();
    expect(emails.flatMap(recipientsOf)).toEqual(['dev@example.com']);

    failOps = false;
    await flushNotifications(T0 + BATCH_MS + RETRY_MS);
    expect(emails.flatMap(recipientsOf)).toEqual(['dev@example.com', 'ops@example.com']);
  });

  it('sends the test notification to everyone notifications are emailed to', async () => {
    process.env.EMAIL_ALERT_RECIPIENTS = 'team@example.com';
    invalidateSettingsCache();
    await setNotificationPreferences(dev, { email: true, push: true, muted: [] });

    expect((await sendTestNotification()).sort()).toEqual(['dev@example.com', 'team@example.com']);
  });
});

describe('Profile → Notifications', () => {
  it('fills in the defaults the Recipients list implies', async () => {
    process.env.EMAIL_ALERT_RECIPIENTS = 'team@example.com';
    invalidateSettingsCache();

    const view = await notificationProfileView({ id: ops, email: 'ops@example.com' });

    expect(view.preferences).toEqual({ email: false, push: true, muted: [] });
    expect(view.emailState).toBe('ready');
    expect(view.categories.map((category) => category.category)).toContain('agentOffline');
  });

  it('says when email is not set up', async () => {
    delete process.env.SMTP_HOST;
    invalidateSettingsCache();

    expect((await notificationProfileView({ id: ops, email: 'ops@example.com' })).emailState).toBe(
      'off',
    );
  });

  it('keeps only known categories from a stored row', async () => {
    await setNotificationPreferences(ops, {
      email: true,
      push: false,
      muted: ['agentOffline', 'nope'],
    });

    expect(await getNotificationPreferences(ops)).toEqual({
      email: true,
      push: false,
      muted: ['agentOffline'],
    });
    expect(parseNotificationPreferences('not json')).toEqual({
      email: null,
      push: true,
      muted: [],
    });
  });
});
