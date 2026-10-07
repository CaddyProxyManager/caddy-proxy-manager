/** The notification state in the alert tables, with `now` injected: dedupe, quiet periods, batches. */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { eq } from 'drizzle-orm';
import { alertDeliveries, alertEvents, settings, users } from '../../../src/lib/db/schema';
import { type OutgoingEmail, setEmailDeliveryForTests } from '../../../src/lib/email/transport';
import { createUser } from '../../../src/lib/models/user';
import {
  flushNotifications,
  getNotificationStatus,
  notify,
  openProblemKeys,
  raiseProblem,
  recordJobFailure,
  recordJobSuccess,
  resetNotificationsForTests,
  resolveProblem,
} from '../../../src/lib/notifications';
import type { NotificationEvent } from '../../../src/lib/notifications/events';
import { EMPTY_LEGACY_STATE, normalizeLegacyState } from '../../../src/lib/notifications/legacy';
import {
  BATCH_MS,
  MAX_BATCH,
  MAX_PENDING,
  MAX_PENDING_AGE_MS,
  RETRY_MS,
} from '../../../src/lib/notifications/plan';
import { invalidateSettingsCache } from '../../../src/lib/settings/resolve';

const T0 = Date.parse('2026-09-29T12:00:00Z');
const OFFLINE: NotificationEvent = { kind: 'agentOffline', agent: 'edge', minutes: 5 };
const ONLINE: NotificationEvent = { kind: 'agentOnline', agent: 'edge' };
let sent: OutgoingEmail[] = [];
let failing = false;

beforeEach(async () => {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_FROM = 'proxy@example.com';
  invalidateSettingsCache();
  sent = [];
  failing = false;
  setEmailDeliveryForTests(async (_config, message) => {
    if (failing) throw new Error('421 try later');
    sent.push(message);
  });
  await resetNotificationsForTests();
  await ctx.db.delete(settings);
  await ctx.db.delete(users);
  await createUser({
    email: 'ops@example.com',
    role: 'admin',
    provider: 'credentials',
    subject: 'a',
  });
});

afterAll(() => {
  setEmailDeliveryForTests(null);
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;
  invalidateSettingsCache();
});

describe('problems', () => {
  it('tells once however often a problem is raised, then its recovery once', async () => {
    await raiseProblem('agent:1', OFFLINE, T0);
    await raiseProblem('agent:1', OFFLINE, T0 + 1);
    await flushNotifications(T0 + BATCH_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('Agent edge is offline');

    await resolveProblem('agent:1', ONLINE, T0 + 2 * BATCH_MS);
    await resolveProblem('agent:1', ONLINE, T0 + 2 * BATCH_MS);
    await flushNotifications(T0 + 3 * BATCH_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toContain('back online');
    expect(await openProblemKeys('agent:')).toEqual([]);
  });

  it('withdraws an alert still waiting for its batch, and sends neither', async () => {
    await raiseProblem('agent:1', OFFLINE, T0);
    await resolveProblem('agent:1', ONLINE, T0 + 1_000);
    await flushNotifications(T0 + 5 * BATCH_MS);
    expect(sent).toHaveLength(0);
    const statuses = await ctx.db.select({ status: alertDeliveries.status }).from(alertDeliveries);
    expect(new Set(statuses.map((row) => row.status))).toEqual(new Set(['withdrawn']));
    const [event] = await ctx.db.select().from(alertEvents);
    expect(event.resolvedAt).toBe(new Date(T0 + 1_000).toISOString());
  });

  it('withdraws only the new alert when a told problem comes back before its recovery is sent', async () => {
    await raiseProblem('k', OFFLINE, T0);
    await flushNotifications(T0 + BATCH_MS);
    await resolveProblem('k', ONLINE, T0 + BATCH_MS + 1);
    await raiseProblem('k', OFFLINE, T0 + BATCH_MS + 2);
    await resolveProblem('k', ONLINE, T0 + BATCH_MS + 3);
    await flushNotifications(T0 + 3 * BATCH_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toContain('back online');
  });

  it('raises a job failure only once the streak reaches the threshold, and clears it on success', async () => {
    const failed = (failures: number): NotificationEvent => ({
      kind: 'geoipFailed',
      failures,
      error: 'HTTP 401',
    });
    for (let i = 0; i < 2; i++) await recordJobFailure('geoip', 3, failed, T0);
    await flushNotifications(T0 + BATCH_MS);
    expect(sent).toHaveLength(0);
    await recordJobFailure('geoip', 3, failed, T0);
    await recordJobFailure('geoip', 3, failed, T0);
    await flushNotifications(T0 + BATCH_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('failed 3 times in a row');

    await recordJobSuccess('geoip', { kind: 'geoipRecovered' }, T0 + BATCH_MS);
    await recordJobSuccess('geoip', { kind: 'geoipRecovered' }, T0 + BATCH_MS);
    await flushNotifications(T0 + 2 * BATCH_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toContain('GeoIP update works again');
  });
});

describe('one-off notices', () => {
  const event: NotificationEvent = { kind: 'adminLocked', email: 'a@example.com', failures: 6 };

  it('stay quiet for their period, and "forever" for good', async () => {
    await notify('lock:1', event, 60_000, T0);
    await notify('lock:1', event, 60_000, T0 + 59_000);
    await notify('lock:1', event, 60_000, T0 + 60_000);
    const update: NotificationEvent = {
      kind: 'updateAvailable',
      version: '3.1.0',
      current: '3.0.0',
    };
    await notify('update:3.1.0', update, 'forever', T0);
    await notify('update:3.1.0', update, 'forever', T0 + 365 * 86_400_000);
    expect((await getNotificationStatus()).pending).toBe(3);
  });

  it('are never deduplicated with a quiet period of 0', async () => {
    for (let i = 0; i < 3; i++) await notify('k', event, 0, T0);
    expect((await getNotificationStatus()).pending).toBe(3);
  });
});

describe('batches', () => {
  it('wait for the oldest notice to be a minute old, and take everything queued since', async () => {
    await raiseProblem('a', OFFLINE, T0);
    await raiseProblem('b', { ...OFFLINE, agent: 'core' }, T0 + 30_000);
    await flushNotifications(T0 + BATCH_MS - 1);
    expect(sent).toHaveLength(0);
    await flushNotifications(T0 + BATCH_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Caddy Proxy Manager: 2 notifications');
  });

  it('keep a failed send for a retry after RETRY_MS, with the error', async () => {
    failing = true;
    await raiseProblem('a', OFFLINE, T0);
    await flushNotifications(T0 + BATCH_MS);
    const failed = await getNotificationStatus();
    expect(failed.lastError).toContain('421 try later');
    expect(failed.pending).toBe(1);
    const [delivery] = await ctx.db
      .select()
      .from(alertDeliveries)
      .where(eq(alertDeliveries.status, 'pending'));
    expect(delivery.attempts).toBe(1);
    expect(delivery.lastError).toContain('421 try later');

    failing = false;
    await flushNotifications(T0 + BATCH_MS + RETRY_MS - 1);
    expect(sent).toHaveLength(0);
    await flushNotifications(T0 + BATCH_MS + RETRY_MS);
    expect(sent).toHaveLength(1);
    const status = await getNotificationStatus();
    expect(status.lastError).toBeNull();
    expect(status.lastSentAt).toBe(new Date(T0 + BATCH_MS + RETRY_MS).toISOString());
  });

  it('drop notices a day old, and keep each queue bounded, oldest first', async () => {
    await raiseProblem('a', OFFLINE, T0);
    await flushNotifications(T0 + MAX_PENDING_AGE_MS);
    expect(sent).toHaveLength(0);
    expect((await getNotificationStatus()).pending).toBe(0);

    for (let i = 0; i < MAX_PENDING + 5; i++) {
      await notify(`k${i}`, { kind: 'agentOnline', agent: `a${i}` }, 0, T0 + i);
    }
    await flushNotifications(T0 + MAX_PENDING + BATCH_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('The agent a5 is connected again.');
    expect(sent[0].text).not.toContain('The agent a4 is connected again.');
    expect((await getNotificationStatus()).pending).toBe(MAX_PENDING - MAX_BATCH);
  });

  it('record a batch dropped for want of recipients', async () => {
    await ctx.db.delete(users);
    await raiseProblem('a', OFFLINE, T0);
    await flushNotifications(T0 + BATCH_MS);
    const status = await getNotificationStatus();
    expect(status.lastErrorCode).toBe('noRecipients');
    expect(status.pending).toBe(0);
  });
});

describe('normalizeLegacyState', () => {
  it('reads a missing or damaged row as empty, and keeps what is well formed', () => {
    expect(normalizeLegacyState(null)).toEqual(EMPTY_LEGACY_STATE);
    expect(normalizeLegacyState('nonsense')).toEqual(EMPTY_LEGACY_STATE);
    const notice = { id: 'x', key: 'a', at: new Date(T0).toISOString(), event: OFFLINE };
    const damaged = { ...EMPTY_LEGACY_STATE, pending: [notice, { id: 1 }], lastErrorCode: 'what' };
    expect(normalizeLegacyState(JSON.parse(JSON.stringify(damaged)))).toEqual({
      ...EMPTY_LEGACY_STATE,
      pending: [notice],
    });
  });
});
