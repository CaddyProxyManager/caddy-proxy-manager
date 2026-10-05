/** Access lists' country, continent and ASN rules, rule expiry, deny response and stats. */
import { beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));
vi.mock('../../../src/lib/caddy', () => ({ applyCaddyConfig: vi.fn(async () => {}) }));

import * as schema from '../../../src/lib/db/schema';
import {
  createAccessList,
  getAccessList,
  getAccessListStats,
  listL4AccessListOptions,
  pruneExpiredAccessListRules,
  setAccessListIpRules,
  updateAccessList,
} from '../../../src/lib/models/access-lists';

const NOW = new Date().toISOString();

beforeEach(async () => {
  await ctx.db.delete(schema.auditEvents);
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.accessListIpRules);
  await ctx.db.delete(schema.accessListEntries);
  await ctx.db.delete(schema.accessLists);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    provider: 'credentials',
    subject: 'admin',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
});

describe('geo rules', () => {
  it('store a country, continent or ASN in order beside address rules', async () => {
    const list = await createAccessList({ name: 'travel' }, 1);
    const updated = await setAccessListIpRules(
      list.id,
      [
        { action: 'deny', cidr: '192.0.2.7' },
        { action: 'allow', country: 'pt', note: 'Offsite', expiresAt: '2099-01-01T00:00:00Z' },
        { action: 'deny', continent: 'EU' },
        { action: 'allow', asn: 'AS64501' },
      ],
      1,
    );
    expect(
      updated.ipRules.map(({ action, cidr, country, continent, asn, note, expiresAt }) => ({
        action,
        cidr,
        country,
        continent,
        asn,
        note,
        expiresAt,
      })),
    ).toEqual([
      {
        action: 'deny',
        cidr: '192.0.2.7/32',
        country: null,
        continent: null,
        asn: null,
        note: null,
        expiresAt: null,
      },
      {
        action: 'allow',
        cidr: null,
        country: 'PT',
        continent: null,
        asn: null,
        note: 'Offsite',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      {
        action: 'deny',
        cidr: null,
        country: null,
        continent: 'EU',
        asn: null,
        note: null,
        expiresAt: null,
      },
      {
        action: 'allow',
        cidr: null,
        country: null,
        continent: null,
        asn: 64501,
        note: null,
        expiresAt: null,
      },
    ]);
    // Layer 4 counts every rule, since a country rule applies there too.
    expect((await listL4AccessListOptions()).find((o) => o.id === list.id)?.ipRuleCount).toBe(4);
  });

  it('refuses a rule naming two targets, writing nothing', async () => {
    const list = await createAccessList({ name: 'office' }, 1);
    await expect(
      setAccessListIpRules(list.id, [{ action: 'deny', country: 'DE', asn: 1 }], 1),
    ).rejects.toMatchObject({ code: 'ipRuleInvalid' });
    expect((await getAccessList(list.id))?.ipRules).toEqual([]);
  });
});

describe('expiry', () => {
  it('prunes expired rules, keeps the rest, audits once per list and applies once', async () => {
    const list = await createAccessList({ name: 'contractors' }, 1);
    await setAccessListIpRules(
      list.id,
      [
        { action: 'allow', cidr: '198.51.100.1', expiresAt: '2030-01-01T00:00:00Z' },
        { action: 'allow', country: 'NL', expiresAt: '2030-01-01T00:00:00Z' },
        { action: 'allow', cidr: '198.51.100.2' },
      ],
      1,
    );
    await ctx.db.delete(schema.auditEvents);
    const apply = vi.fn(async () => {});

    expect(await pruneExpiredAccessListRules(Date.parse('2029-12-31T00:00:00Z'), apply)).toBe(0);
    expect(apply).not.toHaveBeenCalled();

    expect(await pruneExpiredAccessListRules(Date.parse('2030-01-01T00:00:00Z'), apply)).toBe(2);
    expect(apply).toHaveBeenCalledTimes(1);
    expect((await getAccessList(list.id))?.ipRules.map((r) => r.cidr)).toEqual(['198.51.100.2/32']);
    const audit = await ctx.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityType, 'access_list'));
    expect(audit.map((row) => row.summary)).toEqual([
      'Expired rules removed from access list contractors (2)',
    ]);
  });
});

describe('deny response and fail closed', () => {
  it('round-trip, and null restores the plain 403', async () => {
    const list = await createAccessList(
      { name: 'staging', denyResponse: { status: 451, body: 'Not here' }, failClosed: true },
      1,
    );
    expect(list.denyResponse).toEqual({ status: 451, body: 'Not here', redirectUrl: null });
    expect(list.failClosed).toBe(true);

    const redirected = await updateAccessList(
      list.id,
      { denyResponse: { redirectUrl: 'https://example.com/denied' } },
      1,
    );
    expect(redirected.denyResponse).toEqual({
      status: 302,
      body: null,
      redirectUrl: 'https://example.com/denied',
    });
    // Leaving it out keeps it.
    expect((await updateAccessList(list.id, { name: 'staging 2' }, 1)).denyResponse).toEqual(
      redirected.denyResponse,
    );
    const plain = await updateAccessList(list.id, { denyResponse: null, failClosed: false }, 1);
    expect(plain.denyResponse).toBeNull();
    expect(plain.failClosed).toBe(false);
  });

  it('refuses a status outside 400-599 and a redirect that is not a URL', async () => {
    const list = await createAccessList({ name: 'staging' }, 1);
    await expect(
      updateAccessList(list.id, { denyResponse: { status: 200 } }, 1),
    ).rejects.toMatchObject({ code: 'accessListDenyStatusInvalid' });
    await expect(
      updateAccessList(list.id, { denyResponse: { redirectUrl: 'ftp://example.com' } }, 1),
    ).rejects.toMatchObject({ code: 'accessListDenyRedirectInvalid' });
  });
});

describe('stats', () => {
  it('count the hosts using a list, and leave traffic out with analytics off', async () => {
    const list = await createAccessList({ name: 'office' }, 1);
    await ctx.db.insert(schema.proxyHosts).values({
      name: 'app',
      domains: JSON.stringify(['app.example.com']),
      upstreams: JSON.stringify(['app:80']),
      accessListId: list.id,
      createdAt: NOW,
      updatedAt: NOW,
    } as typeof schema.proxyHosts.$inferInsert);
    expect(await getAccessListStats(list.id)).toEqual({ hosts: 1, traffic: null });
  });
});
