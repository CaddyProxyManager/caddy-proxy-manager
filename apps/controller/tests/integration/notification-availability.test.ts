/** Events greyed out when the settings rule them out, and what a disabled account is sent. */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { pushSubscriptions, settings, users } from '../../src/lib/db/schema';
import { type OutgoingEmail, setEmailDeliveryForTests } from '../../src/lib/email/transport';
import { savePushSubscription } from '../../src/lib/models/push-subscriptions';
import { createUser, updateUserStatus } from '../../src/lib/models/user';
import {
  flushNotifications,
  raiseProblem,
  resetNotificationsForTests,
} from '../../src/lib/notifications';
import {
  unavailableNotificationCategories,
  unavailableNotificationSettings,
} from '../../src/lib/notifications/availability';
import { BATCH_MS } from '../../src/lib/notifications/plan';
import { resetPushKeysForTests, setPushDeliveryForTests } from '../../src/lib/notifications/push';
import { invalidateSettingsCache } from '../../src/lib/settings/resolve';

const TOUCHED_ENV = [
  'SMTP_HOST',
  'SMTP_FROM',
  'EMAIL_ALERT_RECIPIENTS',
  'ACCOUNT_LOCK_ENABLED',
  'ACCOUNT_LOCK_DISABLE_ENABLED',
  'UPDATE_CHECK_ENABLED',
  'GEOIP_ENABLED',
  'GEOIPUPDATE_ACCOUNT_ID',
  'GEOIPUPDATE_LICENSE_KEY',
  'NOTIFY_DISABLED_ACCOUNT_OWNER',
];
const T0 = Date.parse('2026-09-29T12:00:00Z');

let emails: OutgoingEmail[] = [];
let pushed: string[] = [];

function setEnv(values: Record<string, string>) {
  Object.assign(process.env, values);
  invalidateSettingsCache();
}

beforeEach(async () => {
  for (const name of TOUCHED_ENV) delete process.env[name];
  setEnv({ SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'proxy@example.com' });
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
  await createUser({
    email: 'ops@example.com',
    role: 'admin',
    provider: 'credentials',
    subject: 'a',
  });
});

afterAll(() => {
  setEmailDeliveryForTests(null);
  setPushDeliveryForTests(null);
  for (const name of TOUCHED_ENV) delete process.env[name];
  invalidateSettingsCache();
});

describe('events the settings rule out', () => {
  it('starts with what the defaults leave impossible', async () => {
    expect(await unavailableNotificationCategories()).toEqual({
      upstreamErrors: 'accessLogOff',
      accountDisabled: 'accountDisableOff',
      geoip: 'geoipOff',
    });
  });

  it('follows each setting it depends on', async () => {
    setEnv({
      ACCOUNT_LOCK_ENABLED: 'false',
      ACCOUNT_LOCK_DISABLE_ENABLED: 'true',
      UPDATE_CHECK_ENABLED: 'false',
      GEOIP_ENABLED: 'true',
      GEOIPUPDATE_ACCOUNT_ID: '12345',
      GEOIPUPDATE_LICENSE_KEY: 'secret',
    });

    expect(await unavailableNotificationCategories()).toEqual({
      upstreamErrors: 'accessLogOff',
      adminLocked: 'accountLockOff',
      updateAvailable: 'updateCheckOff',
    });
  });

  it('greys out the numbers that tune an unavailable event too', async () => {
    const fields = await unavailableNotificationSettings();

    expect(fields['config:notify_upstream_errors']).toBe('accessLogOff');
    expect(fields['config:notify_upstream_error_count']).toBe('accessLogOff');
    expect(fields['config:notify_upstream_error_minutes']).toBe('accessLogOff');
    expect(fields['config:notify_agent_offline']).toBeUndefined();
  });
});

describe('a disabled account', () => {
  async function member() {
    return createUser({
      email: 'dana@example.com',
      role: 'user',
      provider: 'credentials',
      subject: 'd',
    });
  }

  it('is told nothing unless Settings says to tell its owner', async () => {
    const user = await member();

    await updateUserStatus(user.id, 'disabled');

    expect(emails).toHaveLength(0);
  });

  it('gets one email when it is disabled, and none for staying so', async () => {
    setEnv({ NOTIFY_DISABLED_ACCOUNT_OWNER: 'true' });
    const user = await member();

    await updateUserStatus(user.id, 'disabled');
    await updateUserStatus(user.id, 'disabled');

    expect(emails).toHaveLength(1);
    expect(emails[0].to).toBe('dana@example.com');
    expect(emails[0].subject).toBe('Your Caddy Proxy Manager account has been disabled');
    expect(emails[0].text).toContain('An administrator disabled it.');
  });

  it('says so when failed sign-ins disabled it', async () => {
    setEnv({ NOTIFY_DISABLED_ACCOUNT_OWNER: 'true' });
    const user = await member();

    await updateUserStatus(user.id, 'disabled', { by: 'failedSignIns', failures: 10 });

    expect(emails[0].text).toContain('after 10 failed sign-ins in a row');
  });

  it('drops a disabled administrator from every notification', async () => {
    const second = await createUser({
      email: 'second@example.com',
      role: 'admin',
      provider: 'credentials',
      subject: 'b',
    });
    await savePushSubscription(
      second.id,
      {
        endpoint: 'https://push.example.com/second',
        keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
      },
      'en',
      null,
    );
    await updateUserStatus(second.id, 'disabled');

    await raiseProblem('agent:1', { kind: 'agentOffline', agent: 'edge-1', minutes: 5 }, T0);
    await flushNotifications(T0 + BATCH_MS);

    expect(emails.flatMap((email) => [email.to].flat())).toEqual(['ops@example.com']);
    expect(pushed).toEqual([]);
  });
});
