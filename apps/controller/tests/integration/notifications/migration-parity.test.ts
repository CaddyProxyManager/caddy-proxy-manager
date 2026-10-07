/**
 * Moving the notification state out of the `admin_notifications` settings row must not change what
 * anyone receives. A row as an older release left it, mid-retry, with switches and per-user choices,
 * goes through a fixed run of events; the emails and pushes are pinned exactly as the row-based
 * engine sent them, before the tables existed.
 */
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
import { setNotificationPreferences } from '../../../src/lib/models/notification-preferences';
import { savePushSubscription } from '../../../src/lib/models/push-subscriptions';
import { createUser } from '../../../src/lib/models/user';
import {
  flushNotifications,
  getNotificationStatus,
  notify,
  raiseProblem,
  recordJobFailure,
  recordJobSuccess,
  resetNotificationsForTests,
  resolveProblem,
} from '../../../src/lib/notifications';
import type { NotificationEvent } from '../../../src/lib/notifications/events';
import {
  resetPushKeysForTests,
  setPushDeliveryForTests,
} from '../../../src/lib/notifications/push';
import { invalidateSettingsCache } from '../../../src/lib/settings/resolve';

const TOUCHED_ENV = ['SMTP_HOST', 'SMTP_FROM', 'EMAIL_ALERT_RECIPIENTS', 'NOTIFY_ADMIN_ADDED'];
const T0 = Date.parse('2026-09-29T12:00:00Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

let log: string[] = [];
let failEmail = false;
let pushUserId = 0;

function legacyRow() {
  const offline: NotificationEvent = { kind: 'agentOffline', agent: 'edge-1', minutes: 5 };
  return {
    pending: [
      {
        id: 'n1',
        key: 'agent-offline:a1',
        at: iso(T0 - 30_000),
        event: offline,
      },
      {
        id: 'n2',
        key: 'crs-plugin-disabled:3:1.2.0',
        at: iso(T0 - 10 * MIN),
        event: { kind: 'crsPluginDisabled', plugin: 'wordpress', version: '1.2.0' },
        delivered: [`push:${pushUserId}`],
      },
    ],
    open: {
      'agent-offline:a1': { at: iso(T0 - 30_000), noticeId: 'n1', event: offline },
      'caddy-apply:all': {
        at: iso(T0 - 60 * MIN),
        noticeId: null,
        event: { kind: 'caddyApplyFailed', agent: null, error: 'bad config' },
      },
    },
    quiet: { 'update:9.0.0': 'never', 'crs-plugin-disabled:3:1.2.0': iso(T0 + 23 * 60 * MIN) },
    streaks: { geoip: 2 },
    lastSentAt: iso(T0 - 24 * 60 * MIN),
    lastError: '421 try later',
    lastErrorAt: iso(T0 - 10 * MIN),
    lastErrorCode: null,
    retryAt: iso(T0 + 2 * MIN),
  };
}

/** What each email and push said, in order, with the flush that sent it. */
async function flush(now: number) {
  const before = log.length;
  await flushNotifications(now);
  for (let i = before; i < log.length; i++) log[i] = `${iso(now)} ${log[i]}`;
}

beforeEach(async () => {
  for (const name of TOUCHED_ENV) delete process.env[name];
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_FROM = 'proxy@example.com';
  process.env.EMAIL_ALERT_RECIPIENTS = 'extra@example.com, quiet@example.com';
  process.env.NOTIFY_ADMIN_ADDED = 'false';
  invalidateSettingsCache();
  log = [];
  failEmail = false;
  setEmailDeliveryForTests(async (_config, message: OutgoingEmail) => {
    if (failEmail) throw new Error('421 try later');
    const items = message.text.split('\n').filter((line) => line.startsWith('- '));
    log.push(`email to=${[message.to].flat().join(',')} | ${message.subject} | ${items.join(' ')}`);
  });
  setPushDeliveryForTests(async (target, payload) => {
    const { title, body } = JSON.parse(payload) as { title: string; body: string };
    log.push(`push ${target.endpoint} | ${title} | ${body.replaceAll('\n', ' / ')}`);
  });
  resetPushKeysForTests();
  await resetNotificationsForTests();
  await ctx.db.delete(pushSubscriptions);
  await ctx.db.delete(settings);
  await ctx.db.delete(users);

  const ops = await createUser({
    email: 'ops@example.com',
    role: 'admin',
    provider: 'credentials',
    subject: 'a',
  });
  const sec = await createUser({
    email: 'sec@example.com',
    role: 'admin',
    provider: 'credentials',
    subject: 'b',
  });
  await createUser({
    email: 'quiet@example.com',
    role: 'admin',
    provider: 'credentials',
    subject: 'c',
  });
  await setNotificationPreferences(ops.id, { email: true, push: true, muted: ['agentOffline'] });
  await setNotificationPreferences(sec.id, { email: false, push: true, muted: [] });
  await savePushSubscription(
    sec.id,
    {
      endpoint: 'https://push.example.com/sec',
      keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
    },
    'en',
    'Firefox',
  );
  pushUserId = sec.id;
  await ctx.db.insert(settings).values({
    key: 'admin_notifications',
    value: JSON.stringify(legacyRow()),
    updatedAt: iso(T0 - 10 * MIN),
  });
});

afterAll(() => {
  setEmailDeliveryForTests(null);
  setPushDeliveryForTests(null);
  for (const name of TOUCHED_ENV) delete process.env[name];
  invalidateSettingsCache();
});

describe('notification state carried over from the settings row', () => {
  it('sends exactly what the row-based engine sent', async () => {
    // Still waiting out the retry the row recorded.
    await flush(T0);
    expect(log).toEqual([]);
    const carried = await getNotificationStatus();
    expect(carried.pending).toBe(2);
    expect(carried.lastError).toBe('421 try later');
    expect(carried.lastSentAt).toBe(iso(T0 - 24 * 60 * MIN));

    // Quiet keys, an open problem and a streak all carried over.
    await notify(
      'update:9.0.0',
      { kind: 'updateAvailable', version: '9.0.0', current: '3.0.0' },
      'forever',
      T0,
    );
    await notify(
      'crs-plugin-disabled:3:1.2.0',
      { kind: 'crsPluginDisabled', plugin: 'wordpress', version: '1.2.0' },
      24 * 60 * MIN,
      T0,
    );
    await raiseProblem(
      'agent-offline:a1',
      { kind: 'agentOffline', agent: 'edge-1', minutes: 5 },
      T0,
    );
    await resolveProblem(
      'caddy-apply:all',
      (raised) =>
        raised?.kind === 'caddyApplyFailed'
          ? { kind: 'caddyApplyRecovered', agent: raised.agent }
          : null,
      T0 + 1_000,
    );
    await recordJobFailure(
      'geoip',
      3,
      (failures) => ({ kind: 'geoipFailed', failures, error: 'HTTP 401' }),
      T0 + 2_000,
    );
    await notify(
      'admin:9',
      { kind: 'adminAdded', email: 'new@example.com', promoted: false },
      0,
      T0 + 2_000,
    );
    await raiseProblem(
      'upstream:5',
      { kind: 'upstreamErrors', host: 'a.test', count: 12, minutes: 5 },
      T0 + 3_000,
    );
    await resolveProblem('upstream:5', { kind: 'upstreamRecovered', host: 'a.test' }, T0 + 4_000);

    await flush(T0 + 2 * MIN);

    await resolveProblem(
      'agent-offline:a1',
      { kind: 'agentOnline', agent: 'edge-1' },
      T0 + 3 * MIN,
    );
    await raiseProblem(
      'backup:1',
      { kind: 'backupFailed', schedule: 'nightly', error: 'Access denied' },
      T0 + 3 * MIN,
    );
    failEmail = true;
    await flush(T0 + 4 * MIN);
    expect((await getNotificationStatus()).lastError).toContain('421 try later');
    await flush(T0 + 5 * MIN);
    failEmail = false;
    await recordJobSuccess('geoip', { kind: 'geoipRecovered' }, T0 + 6 * MIN);
    await flush(T0 + 9 * MIN);

    const after = await getNotificationStatus();
    expect(after).toMatchObject({ pending: 0, lastError: null, lastSentAt: iso(T0 + 9 * MIN) });

    // A day on, the quiet key has lapsed; "forever" has not.
    const later = T0 + 24 * 60 * MIN + 1;
    await notify(
      'update:9.0.0',
      { kind: 'updateAvailable', version: '9.0.0', current: '3.0.0' },
      'forever',
      later,
    );
    await notify(
      'crs-plugin-disabled:3:1.2.0',
      { kind: 'crsPluginDisabled', plugin: 'wordpress', version: '1.2.0' },
      24 * 60 * MIN,
      later,
    );
    await flush(later + MIN);

    expect(log).toEqual(EXPECTED);
  });
});

const EXPECTED: string[] = [
  '2026-09-29T12:02:00.000Z push https://push.example.com/sec | Caddy Proxy Manager: 3 notifications | The agent edge-1 has been disconnected for more than 5 minutes. Its Caddy keeps its last configuration but gets no changes. / Caddy loaded its configuration again. / The GeoIP database update failed 3 times in a row: HTTP 401. Geo-blocking keeps using the databases already downloaded.',
  '2026-09-29T12:02:00.000Z email to=ops@example.com | Caddy Proxy Manager: 3 notifications | - Sep 29, 2026, 11:50 AM UTC: Caddy refused the WAF with the CRS plugin wordpress 1.2.0, so it was switched off and the rest of the configuration loaded. It stays off until it is turned on again from the WAF page. - Sep 29, 2026, 12:00 PM UTC: Caddy loaded its configuration again. - Sep 29, 2026, 12:00 PM UTC: The GeoIP database update failed 3 times in a row: HTTP 401. Geo-blocking keeps using the databases already downloaded.',
  '2026-09-29T12:02:00.000Z email to=quiet@example.com,extra@example.com | Caddy Proxy Manager: 4 notifications | - Sep 29, 2026, 11:59 AM UTC: The agent edge-1 has been disconnected for more than 5 minutes. Its Caddy keeps its last configuration but gets no changes. - Sep 29, 2026, 11:50 AM UTC: Caddy refused the WAF with the CRS plugin wordpress 1.2.0, so it was switched off and the rest of the configuration loaded. It stays off until it is turned on again from the WAF page. - Sep 29, 2026, 12:00 PM UTC: Caddy loaded its configuration again. - Sep 29, 2026, 12:00 PM UTC: The GeoIP database update failed 3 times in a row: HTTP 401. Geo-blocking keeps using the databases already downloaded.',
  '2026-09-29T12:04:00.000Z push https://push.example.com/sec | Caddy Proxy Manager: 2 notifications | The agent edge-1 is connected again. / The scheduled backup nightly failed: Access denied. Earlier backups are untouched.',
  '2026-09-29T12:09:00.000Z push https://push.example.com/sec | Caddy Proxy Manager: GeoIP update works again | The GeoIP database update succeeded again.',
  '2026-09-29T12:09:00.000Z email to=ops@example.com | Caddy Proxy Manager: 2 notifications | - Sep 29, 2026, 12:03 PM UTC: The scheduled backup nightly failed: Access denied. Earlier backups are untouched. - Sep 29, 2026, 12:06 PM UTC: The GeoIP database update succeeded again.',
  '2026-09-29T12:09:00.000Z email to=quiet@example.com,extra@example.com | Caddy Proxy Manager: 3 notifications | - Sep 29, 2026, 12:03 PM UTC: The agent edge-1 is connected again. - Sep 29, 2026, 12:03 PM UTC: The scheduled backup nightly failed: Access denied. Earlier backups are untouched. - Sep 29, 2026, 12:06 PM UTC: The GeoIP database update succeeded again.',
  '2026-09-30T12:01:00.001Z push https://push.example.com/sec | Caddy Proxy Manager: CRS plugin wordpress switched off | Caddy refused the WAF with the CRS plugin wordpress 1.2.0, so it was switched off and the rest of the configuration loaded. It stays off until it is turned on again from the WAF page.',
  '2026-09-30T12:01:00.001Z email to=ops@example.com,quiet@example.com,extra@example.com | Caddy Proxy Manager: CRS plugin wordpress switched off | - Sep 30, 2026, 12:00 PM UTC: Caddy refused the WAF with the CRS plugin wordpress 1.2.0, so it was switched off and the rest of the configuration loaded. It stays off until it is turned on again from the WAF page.',
];
