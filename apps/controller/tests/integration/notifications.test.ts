/** Admin notifications against a real database: switches, recipients, batching, retries. */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { settings, users } from '../../src/lib/db/schema';
import { type OutgoingEmail, setEmailDeliveryForTests } from '../../src/lib/email/transport';
import { createUser } from '../../src/lib/models/user';
import {
  flushNotifications,
  getNotificationStatus,
  notify,
  raiseProblem,
  recordJobFailure,
  recordJobSuccess,
  resetNotificationsForTests,
  resolveProblem,
  sendTestNotification,
} from '../../src/lib/notifications';
import { BATCH_MS, RETRY_MS } from '../../src/lib/notifications/plan';
import { invalidateSettingsCache } from '../../src/lib/settings/resolve';

const TOUCHED_ENV = ['SMTP_HOST', 'SMTP_FROM', 'EMAIL_ALERT_RECIPIENTS', 'NOTIFY_AGENT_OFFLINE'];
const T0 = Date.parse('2026-09-29T12:00:00Z');
let sent: OutgoingEmail[] = [];

const capture = () =>
  setEmailDeliveryForTests(async (_config, message) => {
    sent.push(message);
  });

beforeEach(async () => {
  for (const name of TOUCHED_ENV) delete process.env[name];
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_FROM = 'proxy@example.com';
  invalidateSettingsCache();
  sent = [];
  capture();
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
  for (const name of TOUCHED_ENV) delete process.env[name];
  invalidateSettingsCache();
});

describe('admin notifications', () => {
  it('batches a minute of events into one email to the administrators', async () => {
    await raiseProblem('agent:1', { kind: 'agentOffline', agent: 'edge-1', minutes: 5 }, T0);
    await notify(
      'lock:9',
      { kind: 'adminLocked', email: 'root@example.com', failures: 6 },
      60_000,
      T0 + 20_000,
    );

    await flushNotifications(T0 + BATCH_MS - 1);
    expect(sent).toHaveLength(0);

    await flushNotifications(T0 + BATCH_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['ops@example.com']);
    expect(sent[0].subject).toBe('Caddy Proxy Manager: 2 notifications');
    expect(sent[0].text).toContain(
      'Sep 29, 2026, 12:00 PM UTC: The agent edge-1 has been disconnected for more than 5 minutes.',
    );
    expect(sent[0].text).toContain('The administrator account root@example.com was locked');
    expect(sent[0].html).toContain('edge-1');

    // Told once; still offline is no news.
    await raiseProblem(
      'agent:1',
      { kind: 'agentOffline', agent: 'edge-1', minutes: 5 },
      T0 + BATCH_MS,
    );
    await flushNotifications(T0 + 3 * BATCH_MS);
    expect(sent).toHaveLength(1);

    await resolveProblem('agent:1', { kind: 'agentOnline', agent: 'edge-1' }, T0 + 3 * BATCH_MS);
    await flushNotifications(T0 + 4 * BATCH_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toBe('Caddy Proxy Manager: Agent edge-1 is back online');
    expect((await getNotificationStatus()).lastSentAt).toBe(
      new Date(T0 + 4 * BATCH_MS).toISOString(),
    );
  });

  it('queues nothing while email is not set up, or with the switch off', async () => {
    delete process.env.SMTP_HOST;
    invalidateSettingsCache();
    await raiseProblem('agent:1', { kind: 'agentOffline', agent: 'edge-1', minutes: 5 }, T0);

    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.NOTIFY_AGENT_OFFLINE = 'false';
    invalidateSettingsCache();
    await raiseProblem('agent:2', { kind: 'agentOffline', agent: 'edge-2', minutes: 5 }, T0);

    await flushNotifications(T0 + BATCH_MS);
    expect(sent).toHaveLength(0);
    expect((await getNotificationStatus()).pending).toBe(0);
  });

  it('drops what was queued once its switch is turned off before the send', async () => {
    await raiseProblem('agent:1', { kind: 'agentOffline', agent: 'edge-1', minutes: 5 }, T0);
    process.env.NOTIFY_AGENT_OFFLINE = 'false';
    invalidateSettingsCache();
    await flushNotifications(T0 + BATCH_MS);
    expect(sent).toHaveLength(0);
    expect((await getNotificationStatus()).pending).toBe(0);
  });

  it('sends to the configured recipients instead', async () => {
    process.env.EMAIL_ALERT_RECIPIENTS = 'a@example.com, b@example.com';
    invalidateSettingsCache();
    await notify('x', { kind: 'crsPluginDisabled', plugin: 'wordpress', version: '1.2.0' }, 0, T0);
    await flushNotifications(T0 + BATCH_MS);
    expect(sent[0].to).toEqual(['a@example.com', 'b@example.com']);
    expect(sent[0].subject).toBe('Caddy Proxy Manager: CRS plugin wordpress switched off');
  });

  it('keeps a failed send, shows its error, and retries it', async () => {
    setEmailDeliveryForTests(async () => {
      throw new Error('421 try later');
    });
    await notify(
      'x',
      { kind: 'updateAvailable', version: '9.0.0', current: '3.0.0' },
      'forever',
      T0,
    );
    await flushNotifications(T0 + BATCH_MS);
    const failed = await getNotificationStatus();
    expect(failed.lastError).toContain('421 try later');
    expect(failed.pending).toBe(1);

    capture();
    await flushNotifications(T0 + BATCH_MS + 1_000);
    expect(sent).toHaveLength(0);
    await flushNotifications(T0 + BATCH_MS + RETRY_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Release 9.0.0 is available. This instance runs 3.0.0.');
    expect((await getNotificationStatus()).lastError).toBeNull();

    // Once per version, for good.
    await notify('x', { kind: 'updateAvailable', version: '9.0.0', current: '3.0.0' }, 'forever');
    expect((await getNotificationStatus()).pending).toBe(0);
  });

  it('records a batch with nobody to send it to', async () => {
    await ctx.db.delete(users);
    await notify('x', { kind: 'adminAdded', email: 'new@example.com', promoted: false }, 0, T0);
    await flushNotifications(T0 + BATCH_MS);
    expect(sent).toHaveLength(0);
    const status = await getNotificationStatus();
    expect(status.lastErrorCode).toBe('noRecipients');
    expect(status.pending).toBe(0);
  });

  it('tells about a job only once it keeps failing', async () => {
    const failed = (failures: number) =>
      ({ kind: 'geoipFailed', failures, error: 'HTTP 401' }) as const;
    await recordJobFailure('geoip', 3, failed, T0);
    await recordJobFailure('geoip', 3, failed, T0);
    await flushNotifications(T0 + BATCH_MS);
    expect(sent).toHaveLength(0);
    await recordJobFailure('geoip', 3, failed, T0 + BATCH_MS);
    await flushNotifications(T0 + 2 * BATCH_MS);
    expect(sent[0].subject).toBe('Caddy Proxy Manager: GeoIP update keeps failing');
    await recordJobSuccess('geoip', { kind: 'geoipRecovered' }, T0 + 2 * BATCH_MS);
    await flushNotifications(T0 + 3 * BATCH_MS);
    expect(sent[1].subject).toBe('Caddy Proxy Manager: GeoIP update works again');
  });

  it('sends a test notification straight away', async () => {
    expect(await sendTestNotification(T0)).toEqual(['ops@example.com']);
    expect(sent[0].subject).toBe('Caddy Proxy Manager: test notification');
  });
});
