/**
 * A grant is **additive and reaches only an operator**: admins ignore them, users and viewers gain
 * nothing, operators start with nothing. Otherwise a first grant changes existing accounts.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

// Hoisted: an async Bun mock factory never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { setGroupGrants, grantsForUser } from '../../src/lib/models/group-grants';
import {
  mappedExternalKeys,
  mappedGroupNames,
  setGroupMappings,
} from '../../src/lib/models/group-idp-mappings';
import {
  canCreate,
  canManage,
  canView,
  resolveAccess,
  visibleIdFilter,
} from '../../src/lib/permissions';
import * as schema from '../../src/lib/db/schema';

const HOST_A = 1;
const HOST_B = 2;
const AGENT_A = 1;

async function session(role: string, userId = 1) {
  return { user: { id: String(userId), email: 'x@example.com', name: null, role } };
}

async function seedGroup(id: number, name: string, memberIds: number[]) {
  const now = new Date().toISOString();
  await ctx.db.insert(schema.groups).values({
    id,
    name,
    description: null,
    source: 'ui',
    createdAt: now,
    updatedAt: now,
  });
  for (const userId of memberIds) {
    await ctx.db.insert(schema.groupMembers).values({ groupId: id, userId, createdAt: now });
  }
}

beforeEach(async () => {
  await ctx.db.delete(schema.groupGrants);
  await ctx.db.delete(schema.groupIdpMappings);
  await ctx.db.delete(schema.groupMembers);
  await ctx.db.delete(schema.groups);
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.agents);
  await ctx.db.delete(schema.users).catch(() => {});

  const now = new Date().toISOString();
  await ctx.db.insert(schema.users).values([
    {
      id: 1,
      email: 'ops@example.com',
      name: 'Ops',
      role: 'operator',
      provider: 'credentials',
      subject: 'ops',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 2,
      email: 'nobody@example.com',
      name: 'Nobody',
      role: 'user',
      provider: 'credentials',
      subject: 'nobody',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
  ]);
  // Real host rows, because the grant columns are foreign keys.
  await ctx.db.insert(schema.proxyHosts).values([
    {
      id: HOST_A,
      name: 'a',
      domains: '["a.example.com"]',
      upstreams: '["a:80"]',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: HOST_B,
      name: 'b',
      domains: '["b.example.com"]',
      upstreams: '["b:80"]',
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await ctx.db.delete(schema.oauthProviders);
  await ctx.db.insert(schema.oauthProviders).values({
    id: 'authentik',
    name: 'Authentik',
    type: 'oidc',
    clientId: 'cid',
    clientSecret: 'secret',
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert(schema.agents).values({
    id: AGENT_A,
    name: 'edge',
    agentId: 'a'.repeat(32),
    secret: 'x',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
});

describe('grants reach only the operator role', () => {
  beforeEach(async () => {
    await seedGroup(1, 'Networking', [1, 2]);
    await setGroupGrants(1, [
      { resource: { kind: 'proxyHost', id: HOST_A }, capability: 'manage' },
    ]);
  });

  it('gives an admin everything, grant or no grant', async () => {
    const access = await resolveAccess(await session('admin', 1));
    expect(canManage(access, 'proxyHost', HOST_B)).toBe(true);
    expect(canManage(access, 'agent', AGENT_A)).toBe(true);
    expect(canCreate(access)).toBe(true);
    // No restriction at all, which is what null means to the list queries.
    expect(visibleIdFilter(access, 'proxyHost')).toBeNull();
  });

  it('gives a user nothing, even in a granted group', async () => {
    // User 2 is in the granted group and must not gain a single host.
    const access = await resolveAccess(await session('user', 2));
    expect(canView(access, 'proxyHost', HOST_A)).toBe(false);
    expect(canManage(access, 'proxyHost', HOST_A)).toBe(false);
    expect(canCreate(access)).toBe(false);
    expect([...(visibleIdFilter(access, 'proxyHost') ?? [])]).toEqual([]);
  });

  it('gives a viewer nothing either', async () => {
    const access = await resolveAccess(await session('viewer', 1));
    expect(canView(access, 'proxyHost', HOST_A)).toBe(false);
  });

  it('gives an operator exactly what the grant named', async () => {
    const access = await resolveAccess(await session('operator', 1));
    expect(canManage(access, 'proxyHost', HOST_A)).toBe(true);
    expect(canView(access, 'proxyHost', HOST_B)).toBe(false);
    expect(canManage(access, 'agent', AGENT_A)).toBe(false);
    // A grant names an existing host, so it says nothing about creating.
    expect(canCreate(access)).toBe(false);
    expect([...(visibleIdFilter(access, 'proxyHost') ?? [])]).toEqual([HOST_A]);
  });
});

describe('capability', () => {
  it('lets a view grant see but not change', async () => {
    await seedGroup(1, 'Auditors', [1]);
    await setGroupGrants(1, [{ resource: { kind: 'proxyHost', id: HOST_A }, capability: 'view' }]);

    const access = await resolveAccess(await session('operator', 1));
    expect(canView(access, 'proxyHost', HOST_A)).toBe(true);
    expect(canManage(access, 'proxyHost', HOST_A)).toBe(false);
  });

  it('takes the most permissive grant when two groups reach the same host', async () => {
    // Otherwise the answer would depend on which row the database happened to return first.
    await seedGroup(1, 'Auditors', [1]);
    await seedGroup(2, 'Networking', [1]);
    await setGroupGrants(1, [{ resource: { kind: 'proxyHost', id: HOST_A }, capability: 'view' }]);
    await setGroupGrants(2, [
      { resource: { kind: 'proxyHost', id: HOST_A }, capability: 'manage' },
    ]);

    const access = await resolveAccess(await session('operator', 1));
    expect(canManage(access, 'proxyHost', HOST_A)).toBe(true);
  });
});

describe('setGroupGrants', () => {
  it('replaces the whole set, so removing one takes it away', async () => {
    await seedGroup(1, 'Networking', [1]);
    await setGroupGrants(1, [
      { resource: { kind: 'proxyHost', id: HOST_A }, capability: 'manage' },
      { resource: { kind: 'proxyHost', id: HOST_B }, capability: 'manage' },
    ]);
    await setGroupGrants(1, [
      { resource: { kind: 'proxyHost', id: HOST_B }, capability: 'manage' },
    ]);

    const effective = await grantsForUser(1);
    expect([...effective.proxyHosts.keys()]).toEqual([HOST_B]);
  });

  it('grants nothing for a user in no groups', async () => {
    const effective = await grantsForUser(1);
    expect(effective.proxyHosts.size).toBe(0);
    expect(effective.agents.size).toBe(0);
  });

  it('cascades away with the host it named', async () => {
    // Why these are foreign keys: a dangling grant would revive when the id was reused.
    await seedGroup(1, 'Networking', [1]);
    await setGroupGrants(1, [
      { resource: { kind: 'proxyHost', id: HOST_A }, capability: 'manage' },
    ]);
    await ctx.db.delete(schema.proxyHosts).where(eq(schema.proxyHosts.id, HOST_A));

    const effective = await grantsForUser(1);
    expect(effective.proxyHosts.size).toBe(0);
  });
});

describe('IdP group mappings', () => {
  beforeEach(async () => {
    await seedGroup(1, 'Networking', [1]);
  });

  it('resolves a claimed name to the CPM group it was mapped onto', async () => {
    await setGroupMappings(1, [{ providerId: null, externalName: 'AD-Infra-Proxy-Admins' }]);
    expect(await mappedGroupNames(['AD-Infra-Proxy-Admins'], 'authentik')).toEqual(['Networking']);
  });

  it('matches case-insensitively and through a Keycloak path', async () => {
    await setGroupMappings(1, [{ providerId: null, externalName: 'Infra' }]);
    expect(await mappedGroupNames(['/company/INFRA'], 'authentik')).toEqual(['Networking']);
  });

  it('applies a provider-scoped mapping only to that provider', async () => {
    await setGroupMappings(1, [{ providerId: 'authentik', externalName: 'Infra' }]);
    expect(await mappedGroupNames(['Infra'], 'authentik')).toEqual(['Networking']);
    expect(await mappedGroupNames(['Infra'], 'okta')).toEqual([]);
  });

  it('reports the mapped names so the prefix convention can skip them', async () => {
    // A claimed group that already resolved by mapping must not also be mirrored under its raw
    // IdP name, or one claim puts the user in two groups.
    await setGroupMappings(1, [{ providerId: null, externalName: 'Infra' }]);
    expect([...(await mappedExternalKeys('authentik'))]).toEqual(['infra']);
  });

  it('replaces the set and drops blank entries', async () => {
    await setGroupMappings(1, [
      { providerId: null, externalName: 'Infra' },
      { providerId: null, externalName: '   ' },
      { providerId: null, externalName: 'infra' },
    ]);
    expect(await mappedGroupNames(['Infra'], 'authentik')).toEqual(['Networking']);

    await setGroupMappings(1, []);
    expect(await mappedGroupNames(['Infra'], 'authentik')).toEqual([]);
  });
});
