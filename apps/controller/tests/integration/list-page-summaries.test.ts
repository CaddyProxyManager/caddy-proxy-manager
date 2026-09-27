/**
 * The aggregates list-page headers show for the whole set while the table shows one page. Run
 * against a real database: sum-of-case counts, count(distinct), hour-prefix grouping on text.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { createTestDb, currentDb, type TestDb } from '../helpers/db';

let db: TestDb;

// currentDb: the factory runs once, so a captured handle would pin every test to the first db.
vi.mock('../../src/lib/db', () => ({
  default: currentDb(() => db),
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null => {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  },
}));

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { countProxyHostsByState } from '../../src/lib/models/proxy-hosts';
import { countL4ProxyHostsByProtocol } from '../../src/lib/models/l4-proxy-hosts';
import {
  auditActivityByHour,
  auditActivitySummary,
  auditFilterOptions,
  countAuditEvents,
  listAuditEvents,
} from '../../src/lib/models/audit';
import { lastSessionByUser } from '../../src/lib/models/user';
import * as schema from '../../src/lib/db/schema';

function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

beforeEach(async () => {
  db = await createTestDb();
});

async function insertProxyHost(name: string, enabled: boolean) {
  const now = iso();
  const [row] = await db
    .insert(schema.proxyHosts)
    .values({
      name,
      domains: JSON.stringify([`${name}.example.com`]),
      upstreams: JSON.stringify(['10.0.0.1:80']),
      enabled,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}

async function insertL4Host(name: string, protocol: 'tcp' | 'udp', enabled = true) {
  const now = iso();
  const [row] = await db
    .insert(schema.l4ProxyHosts)
    .values({
      name,
      protocol,
      listenAddress: ':5432',
      upstreams: JSON.stringify(['10.0.0.1:5432']),
      matcherType: 'none',
      matcherValue: null,
      tlsTermination: false,
      proxyProtocolVersion: null,
      proxyProtocolReceive: false,
      enabled,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}

describe('proxy host state counts', () => {
  it('counts enabled and disabled across the whole set', async () => {
    await insertProxyHost('a', true);
    await insertProxyHost('b', true);
    await insertProxyHost('c', false);

    expect(await countProxyHostsByState()).toEqual({ total: 3, enabled: 2, disabled: 1 });
  });

  it('narrows to the search, so the tabs agree with the list beneath them', async () => {
    await insertProxyHost('alpha', true);
    await insertProxyHost('alpha-two', false);
    await insertProxyHost('beta', true);

    expect(await countProxyHostsByState('alpha')).toEqual({ total: 2, enabled: 1, disabled: 1 });
  });

  it('counts nothing for a viewer granted nothing', async () => {
    await insertProxyHost('a', true);

    // An empty grant list is "sees nothing", not "no restriction".
    expect(await countProxyHostsByState(undefined, [])).toEqual({
      total: 0,
      enabled: 0,
      disabled: 0,
    });
  });

  it('reports zeroes rather than nulls on an empty table', async () => {
    expect(await countProxyHostsByState()).toEqual({ total: 0, enabled: 0, disabled: 0 });
  });
});

describe('l4 protocol counts', () => {
  it('splits tcp from udp and counts enabled separately', async () => {
    await insertL4Host('pg', 'tcp');
    await insertL4Host('mail', 'tcp');
    await insertL4Host('game', 'udp');
    await insertL4Host('syslog', 'udp', false);

    expect(await countL4ProxyHostsByProtocol()).toEqual({
      total: 4,
      tcp: 2,
      udp: 2,
      enabled: 3,
    });
  });

  it('reports zeroes rather than nulls on an empty table', async () => {
    expect(await countL4ProxyHostsByProtocol()).toEqual({ total: 0, tcp: 0, udp: 0, enabled: 0 });
  });
});

describe('audit activity', () => {
  async function insertEvent(createdAt: string, action = 'create', userId: number | null = null) {
    await db.insert(schema.auditEvents).values({
      action,
      entityType: 'proxy_host',
      entityId: 1,
      summary: 'something happened',
      data: null,
      userId,
      createdAt,
    });
  }

  it('buckets events by the hour and leaves quiet hours out', async () => {
    const base = new Date('2026-09-10T14:20:00.000Z');
    await insertEvent(base.toISOString());
    await insertEvent(new Date(base.getTime() + 5 * 60_000).toISOString());
    await insertEvent(new Date(base.getTime() + 2 * 60 * 60_000).toISOString());

    const buckets = await auditActivityByHour('2026-09-10T00:00:00.000Z');
    const byHour = new Map(buckets.map((bucket) => [bucket.hour, bucket.count]));

    expect(byHour.get('2026-09-10T14')).toBe(2);
    expect(byHour.get('2026-09-10T16')).toBe(1);
    // Absent, not zero: only the page knows how many bars the strip has.
    expect(byHour.has('2026-09-10T15')).toBe(false);
  });

  it('ignores anything before the window', async () => {
    await insertEvent('2026-09-01T00:00:00.000Z');
    await insertEvent('2026-09-10T14:00:00.000Z');

    const buckets = await auditActivityByHour('2026-09-10T00:00:00.000Z');
    expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(1);
  });

  it('summarises distinct actors and resource kinds in the window', async () => {
    const now = iso();
    const [alice] = await db
      .insert(schema.users)
      .values({
        email: 'alice@example.com',
        name: 'Alice',
        role: 'admin',
        status: 'active',
        provider: 'local',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await insertEvent(iso(), 'create', alice.id);
    await insertEvent(iso(), 'update', alice.id);
    await db.insert(schema.auditEvents).values({
      action: 'delete',
      entityType: 'certificate',
      entityId: 2,
      summary: 'removed a certificate',
      data: null,
      userId: null,
      createdAt: iso(),
    });

    const summary = await auditActivitySummary(iso(-60 * 60 * 1000));
    expect(summary.events).toBe(3);
    // A system event (null actor) is not a person.
    expect(summary.actors).toBe(1);
    expect(summary.entityTypes).toBe(2);
  });

  it('filters the log on actor, resource and action together, and lists what can be filtered on', async () => {
    const now = iso();
    const [alice] = await db
      .insert(schema.users)
      .values({
        email: 'alice@example.com',
        name: 'Alice',
        role: 'admin',
        status: 'active',
        provider: 'local',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await insertEvent(iso(), 'create', alice.id);
    await insertEvent(iso(), 'update', alice.id);
    await insertEvent(iso(), 'update', null);
    await db.insert(schema.auditEvents).values({
      action: 'update',
      entityType: 'certificate',
      entityId: 2,
      summary: 'renewed a certificate',
      data: null,
      userId: alice.id,
      createdAt: iso(),
    });

    const aliceUpdates = { userId: alice.id, entityType: 'proxy_host', action: 'update' };
    expect(await countAuditEvents(aliceUpdates)).toBe(1);
    // null is the system actor, not "no filter".
    expect(await countAuditEvents({ userId: null })).toBe(1);
    expect(await countAuditEvents({ search: 'renewed', userId: alice.id })).toBe(1);
    expect((await listAuditEvents(10, 0, { action: 'update' })).length).toBe(3);

    expect(await auditFilterOptions()).toEqual({
      entityTypes: ['certificate', 'proxy_host'],
      actions: ['create', 'update'],
    });
  });
});

describe('last session per user', () => {
  it('keeps the most recent session and omits users with none', async () => {
    const now = iso();
    const [user] = await db
      .insert(schema.users)
      .values({
        email: 'bob@example.com',
        name: 'Bob',
        role: 'user',
        status: 'active',
        provider: 'local',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [other] = await db
      .insert(schema.users)
      .values({
        email: 'carol@example.com',
        name: 'Carol',
        role: 'user',
        status: 'active',
        provider: 'local',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const older = '2026-09-01T10:00:00.000Z';
    const newer = '2026-09-09T08:30:00.000Z';
    await db.insert(schema.sessions).values({
      userId: user.id,
      token: 'token-old',
      expiresAt: iso(60_000),
      createdAt: older,
      updatedAt: older,
    });
    await db.insert(schema.sessions).values({
      userId: user.id,
      token: 'token-new',
      expiresAt: iso(60_000),
      createdAt: newer,
      updatedAt: newer,
    });

    const byUser = await lastSessionByUser();
    expect(byUser.get(user.id)).toBe(newer);
    // Absent, so the page says "no active session" rather than inventing a date.
    expect(byUser.has(other.id)).toBe(false);
  });
});
