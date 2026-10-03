/**
 * Upstream errors from the counts agents relay: ingested with analytics off, matched to a proxy
 * host, raised at the threshold within the window, recovered after a quiet one.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { ingestAnalytics } from '../../src/lib/agent/analytics-ingest';
import { currentFleetConfig } from '../../src/lib/agent/fleet-config';
import { proxyHosts, settings, users } from '../../src/lib/db/schema';
import { type OutgoingEmail, setEmailDeliveryForTests } from '../../src/lib/email/transport';
import { createUser } from '../../src/lib/models/user';
import { flushNotifications, resetNotificationsForTests } from '../../src/lib/notifications';
import { BATCH_MS } from '../../src/lib/notifications/plan';
import {
  parseUpstreamErrorRow,
  recordUpstreamErrors,
  resetUpstreamErrorsForTests,
  watchUpstreamErrors,
} from '../../src/lib/notifications/upstream-errors';
import { invalidateSettingsCache } from '../../src/lib/settings/resolve';

const MINUTE = 60_000;
const T0 = Date.parse('2026-09-29T12:00:00Z');
let sent: OutgoingEmail[] = [];

const at = (ms: number) => Math.floor(ms / 1000 / 60) * 60;
const errors = (host: string, count: number, ms: number) => ({
  minute: at(ms),
  host,
  status: 502,
  count,
});

async function host(domains: string[]) {
  const now = new Date().toISOString();
  const [row] = await ctx.db
    .insert(proxyHosts)
    .values({
      name: domains[0],
      domains: JSON.stringify(domains),
      upstreams: JSON.stringify(['10.0.0.9:8080']),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row.id;
}

async function flush(now: number) {
  const before = sent.length;
  await flushNotifications(now + BATCH_MS);
  return sent.slice(before);
}

beforeEach(async () => {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_FROM = 'proxy@example.com';
  invalidateSettingsCache();
  sent = [];
  setEmailDeliveryForTests(async (_config, message) => {
    sent.push(message);
  });
  resetUpstreamErrorsForTests();
  await ctx.db.delete(proxyHosts);
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
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;
  invalidateSettingsCache();
});

describe('upstream error notifications', () => {
  it('raises a host at the threshold within the window, once, and recovers after a quiet one', async () => {
    await host(['app.example.com']);
    await recordUpstreamErrors([errors('app.example.com', 6, T0)], T0);
    expect(await flush(T0)).toEqual([]);

    await recordUpstreamErrors([errors('app.example.com:443', 4, T0 + MINUTE)], T0 + MINUTE);
    const alert = await flush(T0 + MINUTE);
    expect(alert.map((message) => message.subject)).toEqual([
      'Caddy Proxy Manager: Upstream errors on app.example.com',
    ]);
    expect(alert[0].text).toContain(
      'app.example.com answered 10 requests with 502, 503 or 504 within 5 minutes',
    );

    await recordUpstreamErrors([errors('app.example.com', 50, T0 + 2 * MINUTE)], T0 + 2 * MINUTE);
    await watchUpstreamErrors(T0 + 6 * MINUTE);
    expect(await flush(T0 + 6 * MINUTE)).toEqual([]);

    await watchUpstreamErrors(T0 + 8 * MINUTE);
    expect((await flush(T0 + 8 * MINUTE)).map((message) => message.subject)).toEqual([
      'Caddy Proxy Manager: app.example.com has recovered',
    ]);
  });

  it('counts only the window, and follows the settings', async () => {
    process.env.NOTIFY_UPSTREAM_ERROR_COUNT = '3';
    process.env.NOTIFY_UPSTREAM_ERROR_MINUTES = '2';
    invalidateSettingsCache();
    try {
      await host(['*.example.com']);
      await recordUpstreamErrors([errors('a.example.com', 2, T0)], T0);
      // Two minutes on, the first two fell out of the window.
      await recordUpstreamErrors([errors('a.example.com', 2, T0 + 3 * MINUTE)], T0 + 3 * MINUTE);
      expect(await flush(T0 + 3 * MINUTE)).toEqual([]);
      await recordUpstreamErrors([errors('a.example.com', 1, T0 + 3 * MINUTE)], T0 + 3 * MINUTE);
      const [message] = await flush(T0 + 3 * MINUTE);
      expect(message.text).toContain('a.example.com answered 3 requests');
      expect(message.text).toContain('within 2 minutes');
    } finally {
      delete process.env.NOTIFY_UPSTREAM_ERROR_COUNT;
      delete process.env.NOTIFY_UPSTREAM_ERROR_MINUTES;
      invalidateSettingsCache();
    }
  });

  it('ignores a host no proxy host serves, and a backlog older than the window', async () => {
    await host(['app.example.com']);
    await recordUpstreamErrors(
      [errors('evil.example.net', 100, T0), errors('app.example.com', 100, T0 - 30 * MINUTE)],
      T0,
    );
    expect(await flush(T0)).toEqual([]);
  });

  it('waits a whole window after a restart before calling anything recovered', async () => {
    await host(['app.example.com']);
    await recordUpstreamErrors([errors('app.example.com', 20, T0)], T0);
    expect(await flush(T0)).toHaveLength(1);
    resetUpstreamErrorsForTests();
    await watchUpstreamErrors(T0 + 10 * MINUTE);
    await watchUpstreamErrors(T0 + 14 * MINUTE);
    expect(await flush(T0 + 14 * MINUTE)).toEqual([]);
    await watchUpstreamErrors(T0 + 15 * MINUTE);
    expect(await flush(T0 + 15 * MINUTE)).toHaveLength(1);
  });

  it('is ingested with analytics off, and asked of the agents only while wanted', async () => {
    await host(['app.example.com']);
    const now = Date.now();
    const result = await ingestAnalytics('agent-1', 'upstream-errors', [
      errors('app.example.com', 12, now),
      { minute: 1, host: 'x', status: 200, count: 1 },
      'nonsense',
    ]);
    expect(result).toEqual({ accepted: 1, rejected: 2 });
    // The count was raised at its own Date.now(), a moment after `now`.
    expect(await flush(Date.now())).toHaveLength(1);

    expect((await currentFleetConfig()).upstreamErrors).toBe(true);
    process.env.NOTIFY_UPSTREAM_ERRORS = 'false';
    invalidateSettingsCache();
    try {
      expect((await currentFleetConfig()).upstreamErrors).toBe(false);
    } finally {
      delete process.env.NOTIFY_UPSTREAM_ERRORS;
      invalidateSettingsCache();
    }
    delete process.env.SMTP_HOST;
    invalidateSettingsCache();
    expect((await currentFleetConfig()).upstreamErrors).toBe(false);
  });

  it('parses a row field by field', () => {
    expect(parseUpstreamErrorRow({ minute: 60, host: 'a', status: 503, count: 2 })).toEqual({
      minute: 60,
      host: 'a',
      status: 503,
      count: 2,
    });
    expect(parseUpstreamErrorRow({ minute: 60, host: 'a', status: 503, count: 0 })).toBeNull();
    expect(parseUpstreamErrorRow({ minute: 1.5, host: 'a', status: 503, count: 1 })).toBeNull();
    expect(parseUpstreamErrorRow({ minute: 60, host: 7, status: 503, count: 1 })).toBeNull();
  });
});
