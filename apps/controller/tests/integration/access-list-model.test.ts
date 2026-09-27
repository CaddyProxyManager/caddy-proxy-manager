/** Location rules name access lists with no foreign key, so deleting a list must clear them. */
import { beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => ({
  default: ctx.db,
  sqlite: undefined,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null =>
    !value ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
  runInTransaction: async (build: (tx: TestDb) => { execute?: () => unknown }[]) => {
    for (const statement of build(ctx.db)) await statement;
  },
}));
vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));
vi.mock('../../src/lib/caddy', () => ({ applyCaddyConfig: vi.fn(async () => {}) }));

import * as schema from '../../src/lib/db/schema';
import {
  createAccessList,
  deleteAccessList,
  getAccessList,
  getAccessListUsageMap,
  removeAccessListEntry,
  setAccessListIpRules,
  updateAccessList,
} from '../../src/lib/models/access-lists';

const NOW = new Date().toISOString();

beforeEach(async () => {
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
      { action: 'deny', cidr: '10.0.0.9/32', note: null },
      { action: 'allow', cidr: '10.0.0.0/8', note: 'LAN' },
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

  it('are set to no list, not left dangling, when the list is deleted', async () => {
    const list = await createAccessList({ name: 'admins' }, 1);
    const host = await hostWithLocationList(list.id);
    await deleteAccessList(list.id, 1);
    const [row] = await ctx.db
      .select()
      .from(schema.proxyHosts)
      .where(eq(schema.proxyHosts.id, host.id));
    expect(JSON.parse(row.meta ?? '{}').location_rules[0].access_list_id).toBeNull();
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
