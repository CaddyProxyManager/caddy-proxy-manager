/** Access-list model: IP rules, options, and refusing to delete a list something still uses. */
import { beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));
vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));
vi.mock('../../../src/lib/caddy', () => ({ applyCaddyConfig: vi.fn(async () => {}) }));

import * as schema from '../../../src/lib/db/schema';
import {
  createAccessList,
  deleteAccessList,
  getAccessList,
  getAccessListUsageMap,
  removeAccessListEntry,
  setAccessListIpRules,
  updateAccessList,
} from '../../../src/lib/models/access-lists';
import { DomainError } from '../../../src/lib/errors/domain-error';
import { saveDashboardSettings } from '../../../src/lib/settings';
import { EMPTY_DASHBOARD_HOST_OPTIONS } from '../../../src/lib/dashboard-host';
import { createL4ProxyHost, updateL4ProxyHost } from '../../../src/lib/models/l4-proxy-hosts';
import { setHostnameResolver } from '../../../src/lib/access-lists/dns';

// Every lookup in this file is answered here; a test that forgets a name gets ENOTFOUND.
const lookups: string[] = [];
setHostnameResolver(async (name) => {
  lookups.push(name);
  if (name === 'home.example.com') {
    return [
      { address: '203.0.113.7', ttl: 300 },
      { address: '2001:db8:5:6::99', ttl: 300 },
    ];
  }
  throw new Error(`queryA ENOTFOUND ${name}`);
});

const NOW = new Date().toISOString();

async function failure(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

beforeEach(async () => {
  await ctx.db.delete(schema.l4ProxyHosts);
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.accessListIpRules);
  await ctx.db.delete(schema.accessListDnsCache);
  lookups.length = 0;
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

describe('IP rules', () => {
  it('replaces the set, keeping its order', async () => {
    const list = await createAccessList({ name: 'office' }, 1);
    await setAccessListIpRules(
      list.id,
      [
        { action: 'deny', cidr: '10.0.0.9' },
        { action: 'allow', cidr: '10.0.0.0/8', note: 'LAN' },
      ],
      1,
    );
    expect((await getAccessList(list.id))?.ipRules).toEqual([
      { action: 'deny', cidr: '10.0.0.9/32', hostname: null, note: null },
      { action: 'allow', cidr: '10.0.0.0/8', hostname: null, note: 'LAN' },
    ]);

    await setAccessListIpRules(list.id, [{ action: 'allow', cidr: '192.168.0.0/16' }], 1);
    expect((await getAccessList(list.id))?.ipRules.map((r) => r.cidr)).toEqual(['192.168.0.0/16']);
  });

  it('writes nothing when a rule is bad', async () => {
    const list = await createAccessList({ name: 'office' }, 1);
    await setAccessListIpRules(list.id, [{ action: 'allow', cidr: '10.0.0.0/8' }], 1);
    await expect(
      setAccessListIpRules(list.id, [{ action: 'allow', cidr: 'not-an-ip' }], 1),
    ).rejects.toMatchObject({ code: 'ipRuleInvalid' });
    expect((await getAccessList(list.id))?.ipRules).toHaveLength(1);
  });
});

describe('hostname rules', () => {
  it('looks a new name up on save and shows the ranges it stands for', async () => {
    const list = await createAccessList({ name: 'home' }, 1);
    await setAccessListIpRules(
      list.id,
      [
        { action: 'allow', hostname: 'Home.Example.com' },
        { action: 'deny', hostname: 'gone.example.com' },
      ],
      1,
    );
    expect(lookups.sort()).toEqual(['gone.example.com', 'home.example.com']);
    const [home, gone] = (await getAccessList(list.id))?.ipRules ?? [];
    expect(home).toMatchObject({
      action: 'allow',
      cidr: null,
      hostname: 'home.example.com',
      resolved: { ranges: ['2001:db8:5:6::/64', '203.0.113.7/32'], lastError: null },
    });
    expect(gone.resolved?.ranges).toEqual([]);
    expect(gone.resolved?.lastError).toContain('ENOTFOUND');

    // Known names are the refresher's business, not the next save's.
    await setAccessListIpRules(list.id, [{ action: 'allow', hostname: 'home.example.com/128' }], 1);
    expect(lookups).toHaveLength(2);
    expect((await getAccessList(list.id))?.ipRules[0].resolved?.ranges).toEqual([
      '2001:db8:5:6::99/128',
      '203.0.113.7/32',
    ]);
  });

  it('keeps an L4 host on a list whose only rule is a hostname', async () => {
    const list = await createAccessList(
      { name: 'home', ipRules: [{ action: 'allow', hostname: 'home.example.com' }] },
      1,
    );
    const host = await createL4ProxyHost(
      {
        name: 'ssh',
        protocol: 'tcp',
        listenAddress: ':2222',
        upstreams: ['box:22'],
        accessListId: list.id,
      },
      1,
    );
    expect(host.accessListId).toBe(list.id);
    expect((await failure(setAccessListIpRules(list.id, [], 1))).code).toBe(
      'accessListIpRulesNeededByL4Hosts',
    );
  });
});

describe('list options', () => {
  it('defaults new lists to deny, all, and not passing auth', async () => {
    const list = await createAccessList({ name: 'new' }, 1);
    expect([list.ipDefault, list.satisfy, list.passAuth]).toEqual(['deny', 'all', false]);
  });

  it('updates each option and refuses a value outside its set', async () => {
    const list = await createAccessList({ name: 'new', description: 'x' }, 1);
    const updated = await updateAccessList(
      list.id,
      { satisfy: 'any', ipDefault: 'allow', passAuth: true, description: null },
      1,
    );
    expect([updated.satisfy, updated.ipDefault, updated.passAuth]).toEqual(['any', 'allow', true]);
    // Guards against `null ?? existing`, which kept the old description.
    expect(updated.description).toBeNull();
    await expect(updateAccessList(list.id, { satisfy: 'some' }, 1)).rejects.toMatchObject({
      code: 'accessListSatisfyInvalid',
    });
  });
});

describe('location rules naming a list', () => {
  async function hostWithLocationList(listId: number) {
    const [host] = await ctx.db
      .insert(schema.proxyHosts)
      .values({
        name: 'app',
        domains: '["app.example.com"]',
        upstreams: '["app:80"]',
        meta: JSON.stringify({
          location_rules: [{ path: '/admin/*', upstreams: ['admin:80'], access_list_id: listId }],
        }),
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning();
    return host;
  }

  it('count as using the list', async () => {
    const list = await createAccessList({ name: 'admins' }, 1);
    const host = await hostWithLocationList(list.id);
    expect((await getAccessListUsageMap()).get(list.id)?.map((h) => h.id)).toEqual([host.id]);
  });

  it('keep the list from being deleted', async () => {
    const list = await createAccessList({ name: 'admins' }, 1);
    const host = await hostWithLocationList(list.id);
    const error = await failure(deleteAccessList(list.id, 1));
    expect(error.code).toBe('accessListInUseByHosts');
    expect(await getAccessList(list.id)).not.toBeNull();
    const [row] = await ctx.db
      .select()
      .from(schema.proxyHosts)
      .where(eq(schema.proxyHosts.id, host.id));
    expect(JSON.parse(row.meta ?? '{}').location_rules[0].access_list_id).toBe(list.id);
  });
});

describe('deleteAccessList', () => {
  async function insertHost(name: string, accessListId: number | null) {
    await ctx.db.insert(schema.proxyHosts).values({
      name,
      domains: JSON.stringify([`${name}.example.com`]),
      upstreams: '["app:80"]',
      accessListId,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  it('refuses while a host uses it, naming the hosts, and changes nothing', async () => {
    const list = await createAccessList({ name: 'office' }, 1);
    await insertHost('alpha', list.id);
    await insertHost('beta', list.id);

    const error = await failure(deleteAccessList(list.id, 1));
    expect(error.code).toBe('accessListInUseByHosts');
    expect(error.status).toBe(409);
    expect([...(error.params.hosts as string[])].sort()).toEqual(['alpha', 'beta']);
    const hosts = await ctx.db.select().from(schema.proxyHosts);
    expect(hosts.every((h) => h.accessListId === list.id)).toBe(true);
  });

  it('refuses while the dashboard host or one of its location rules uses it', async () => {
    const own = await createAccessList({ name: 'own' }, 1);
    const path = await createAccessList({ name: 'path' }, 1);
    await saveDashboardSettings({
      enabled: false,
      domain: '',
      tls: false,
      options: {
        ...EMPTY_DASHBOARD_HOST_OPTIONS,
        accessListId: own.id,
        meta: JSON.stringify({
          location_rules: [{ path: '/x/*', upstreams: [], access_list_id: path.id }],
        }),
      },
    });
    try {
      for (const list of [own, path]) {
        const error = await failure(deleteAccessList(list.id, 1));
        expect(error.code).toBe('accessListInUseByDashboard');
        expect(error.status).toBe(409);
      }
    } finally {
      await ctx.db.delete(schema.settings);
    }
  });

  it('deletes one nothing uses', async () => {
    const used = await createAccessList({ name: 'used' }, 1);
    const unused = await createAccessList({ name: 'unused' }, 1);
    await insertHost('alpha', used.id);
    await insertHost('gamma', null);

    await deleteAccessList(unused.id, 1);
    expect(await getAccessList(unused.id)).toBeNull();
    expect(await getAccessList(used.id)).not.toBeNull();
  });
});

describe('entries', () => {
  it('can only be removed through the list they belong to', async () => {
    const a = await createAccessList({ name: 'a', users: [{ username: 'u', password: 'p' }] }, 1);
    const b = await createAccessList({ name: 'b' }, 1);
    const entryId = a.entries[0].id;
    await expect(removeAccessListEntry(b.id, entryId, 1)).rejects.toMatchObject({
      code: 'accessListEntryNotFound',
    });
    expect((await getAccessList(a.id))?.entries).toHaveLength(1);
  });
});

describe('L4 hosts using a list', () => {
  const OFFICE = [{ action: 'allow', cidr: '10.0.0.0/8' }];

  async function l4Host(accessListId: number | null) {
    return await createL4ProxyHost(
      {
        name: 'postgres',
        protocol: 'tcp',
        listenAddress: ':5432',
        upstreams: ['db:5432'],
        accessListId,
      },
      1,
    );
  }

  it('store the list, and can clear it', async () => {
    const list = await createAccessList({ name: 'office', ipRules: OFFICE }, 1);
    const host = await l4Host(list.id);
    expect(host.accessListId).toBe(list.id);
    expect((await updateL4ProxyHost(host.id, { accessListId: null }, 1)).accessListId).toBeNull();
  });

  it('refuse a list with only passwords, and one that does not exist', async () => {
    const accounts = await createAccessList(
      { name: 'people', users: [{ username: 'u', password: 'p' }] },
      1,
    );
    const onlyPasswords = await failure(l4Host(accounts.id));
    expect(onlyPasswords.code).toBe('l4AccessListNeedsIpRules');
    expect(onlyPasswords.status).toBe(400);
    expect((await failure(l4Host(9999))).code).toBe('accessListNotFound');
    expect(await ctx.db.select().from(schema.l4ProxyHosts)).toHaveLength(0);

    const office = await createAccessList({ name: 'office', ipRules: OFFICE }, 1);
    const host = await l4Host(office.id);
    const onUpdate = await failure(updateL4ProxyHost(host.id, { accessListId: accounts.id }, 1));
    expect(onUpdate.code).toBe('l4AccessListNeedsIpRules');
  });

  it('count as using the list, which then cannot be deleted', async () => {
    const list = await createAccessList({ name: 'office', ipRules: OFFICE }, 1);
    const host = await l4Host(list.id);
    expect((await getAccessListUsageMap()).get(list.id)).toEqual([
      { id: host.id, kind: 'l4', name: 'postgres', domains: [':5432'], enabled: true },
    ]);

    const error = await failure(deleteAccessList(list.id, 1));
    expect(error.code).toBe('accessListInUseByHosts');
    expect(error.params.hosts).toEqual(['postgres']);
    expect(await getAccessList(list.id)).not.toBeNull();
  });

  it('keep the list from losing its last IP rule', async () => {
    const list = await createAccessList({ name: 'office', ipRules: OFFICE }, 1);
    await l4Host(list.id);
    const error = await failure(setAccessListIpRules(list.id, [], 1));
    expect(error.code).toBe('accessListIpRulesNeededByL4Hosts');
    expect(error.status).toBe(409);
    expect((await getAccessList(list.id))?.ipRules).toHaveLength(1);
    // Changing the rules is fine; only emptying them is refused.
    await setAccessListIpRules(list.id, [{ action: 'deny', cidr: '10.9.0.0/16' }], 1);
    expect((await getAccessList(list.id))?.ipRules.map((r) => r.cidr)).toEqual(['10.9.0.0/16']);
  });
});
