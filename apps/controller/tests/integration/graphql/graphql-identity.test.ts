/**
 * Accounts, sessions and forward auth over GraphQL: each write lands in the database and reads
 * back, a non-admin is refused, and sessions stay the caller's own unless they hold users:read.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { capabilitiesOf } from '@/tests/helpers/access';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { eq } from 'drizzle-orm';
import { graphql } from 'graphql';
import { schema } from '../../../src/lib/graphql/schema';
import type { GraphQLContext } from '../../../src/lib/graphql/context';
import { verifyPassword } from '../../../src/lib/auth/password';
import * as db from '../../../src/lib/db/schema';
import { type FakeCaddy, installFakeCaddy } from '../../helpers/caddy-admin';

const NOW = '2026-03-01T00:00:00.000Z';
const LATER = '2099-01-01T00:00:00.000Z';
const ROLE_REFUSED = "This account's role does not allow this request";

/** Ids are the database's own, so the model's inserts never collide with a seeded one. */
let adminId = 0;

function contextFor(role: string | null, userId = adminId): GraphQLContext {
  return {
    viewer: async () => {
      if (!role) throw new Error('Unauthorized');
      return { userId, role, authMethod: 'bearer' as const };
    },
    access: async () => ({
      userId,
      role: role ?? '',
      capabilities: capabilitiesOf(role),
      grants: { proxyHosts: new Map(), l4ProxyHosts: new Map(), agents: new Map() },
    }),
    rawBody: async () => '',
    request: {} as never,
  };
}

async function run(
  document: string,
  role: string | null,
  variableValues?: Record<string, unknown>,
  userId = adminId,
) {
  return await graphql({
    schema,
    source: document,
    contextValue: contextFor(role, userId),
    variableValues,
  });
}

async function ok<T = Record<string, unknown>>(
  document: string,
  variableValues?: Record<string, unknown>,
  userId = adminId,
): Promise<T> {
  const result = await run(document, 'admin', variableValues, userId);
  expect(result.errors).toBeUndefined();
  return result.data as T;
}

async function seedUser(name: string, role = 'user'): Promise<number> {
  const [row] = await ctx.db
    .insert(db.users)
    .values({
      email: `${name}@example.com`,
      name,
      role,
      passwordHash: 'hash-that-must-not-leak',
      subject: `subject-${name}`,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning({ id: db.users.id });
  return row.id;
}

async function seedSession(userId: number, token: string) {
  const [row] = await ctx.db
    .insert(db.sessions)
    .values({ userId, token, expiresAt: LATER, createdAt: NOW, updatedAt: NOW })
    .returning({ id: db.sessions.id });
  return row.id;
}

async function createHost(name: string) {
  const data = await ok<{ createProxyHost: { id: number } }>(
    'mutation ($input: JSON!) { createProxyHost(input: $input) { id } }',
    { input: { name, domains: [`${name}.example.com`], upstreams: ['backend:8080'] } },
  );
  return data.createProxyHost.id;
}

async function seedForwardAuthSession(userId: number, proxyHostId: number, tokenHash: string) {
  const [row] = await ctx.db
    .insert(db.forwardAuthSessions)
    .values({
      userId,
      proxyHostId,
      audienceOrigin: 'https://app.example.com',
      tokenHash,
      expiresAt: LATER,
      createdAt: NOW,
    })
    .returning({ id: db.forwardAuthSessions.id });
  return row.id;
}

let caddy: FakeCaddy;

beforeEach(async () => {
  caddy = installFakeCaddy();
  for (const table of [
    db.forwardAuthSessions,
    db.forwardAuthAccess,
    db.proxyHosts,
    db.groupMembers,
    db.groups,
    db.sessions,
    db.users,
  ]) {
    await ctx.db.delete(table);
  }
  adminId = await seedUser('admin', 'admin');
});

describe('the admin gate', () => {
  it('refuses an operator every new field, writing nothing', async () => {
    const other = await seedUser('other');
    await seedSession(other, 'theirs');
    for (const document of [
      `{ sessions(userId: ${other}) { id } }`,
      '{ forwardAuthSessions { id } }',
      '{ forwardAuthAccess(proxyHostId: 1) { id } }',
      'mutation { createUser(input: { email: "x@example.com", password: "Correct-Horse-1!" }) { id } }',
      'mutation { revokeForwardAuthSession(id: 1) }',
      `mutation { setForwardAuthAccess(proxyHostId: 1, input: { userIds: [${other}] }) { id } }`,
    ]) {
      const result = await run(document, 'operator');
      expect(result.errors?.[0]?.message, document).toBe(ROLE_REFUSED);
    }
    expect(await ctx.db.select().from(db.users)).toHaveLength(2);
    expect(await ctx.db.select().from(db.forwardAuthAccess)).toEqual([]);
    expect(await ctx.db.select().from(db.sessions)).toHaveLength(1);
    expect(caddy.loads).toEqual([]);
  });
});

describe('createUser', () => {
  const CREATE =
    'mutation ($input: JSON!) { createUser(input: $input) { id email name role status } }';

  it('creates a local account with a hashed password and reads it back', async () => {
    const data = await ok<{ createUser: Record<string, unknown> }>(CREATE, {
      input: {
        email: 'Alice@Example.com',
        password: 'Correct-Horse-1!',
        name: 'Alice',
        role: 'viewer',
        username: 'alice',
      },
    });
    expect(data.createUser).toMatchObject({
      email: 'alice@example.com',
      name: 'Alice',
      role: 'viewer',
      status: 'active',
    });
    const [row] = await ctx.db
      .select()
      .from(db.users)
      .where(eq(db.users.id, data.createUser.id as number));
    expect(row).toMatchObject({ provider: 'credentials', username: 'alice', role: 'viewer' });
    expect(await verifyPassword('Correct-Horse-1!', row.passwordHash ?? '')).toBe(true);
  });

  it('defaults the role to user and never answers with the hash', async () => {
    const data = await ok<{ createUser: { role: string } }>(CREATE, {
      input: { email: 'bob@example.com', password: 'Correct-Horse-1!' },
    });
    expect(data.createUser.role).toBe('user');
    const field = await run(
      'mutation { createUser(input: { email: "c@example.com", password: "Correct-Horse-1!" }) { passwordHash } }',
      'admin',
    );
    expect(field.errors?.[0]?.message).toContain('passwordHash');
  });

  it('refuses what POST /api/v1/users refuses, creating nothing', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ email: 'a@example.com' }, 'Email and password are required'],
      [{ email: 'not-an-email', password: 'Correct-Horse-1!' }, 'valid email address'],
      [{ email: 'a@example.com', password: 'short' }, 'Password must be'],
      [{ email: 'a@example.com', password: 'Correct-Horse-1!', role: 'emperor' }, 'valid role'],
      [{ email: 'a@example.com', password: 'Correct-Horse-1!', username: 42 }, 'Username must be'],
    ];
    for (const [input, message] of cases) {
      const result = await run(CREATE, 'admin', { input });
      expect(result.errors?.[0]?.message, JSON.stringify(input)).toContain(message);
    }
    expect(await ctx.db.select().from(db.users)).toHaveLength(1);
  });
});

describe('sessions', () => {
  it("lists the caller's own unless they hold users:read and ask for another's", async () => {
    const viewerId = await seedUser('viewer', 'viewer');
    const mine = await seedSession(adminId, 'mine');
    const theirs = await seedSession(viewerId, 'theirs');

    const own = await ok<{ sessions: { id: number; current: boolean }[] }>(
      '{ sessions { id current } }',
    );
    expect(own.sessions).toEqual([{ id: mine, current: false }]);

    const other = await ok<{ sessions: { id: number }[] }>(
      'query ($userId: Int!) { sessions(userId: $userId) { id } }',
      { userId: viewerId },
    );
    expect(other.sessions.map((s) => s.id)).toEqual([theirs]);

    const viewerOwn = await run('{ sessions { id } }', 'viewer', undefined, viewerId);
    expect(viewerOwn.errors).toBeUndefined();
    expect((viewerOwn.data as { sessions: { id: number }[] }).sessions.map((s) => s.id)).toEqual([
      theirs,
    ]);

    const viewerOther = await run(
      'query ($userId: Int!) { sessions(userId: $userId) { id } }',
      'viewer',
      { userId: adminId },
      viewerId,
    );
    expect(viewerOther.errors?.[0]?.message).toBe(ROLE_REFUSED);
    expect((await run('{ sessions { token } }', 'admin')).errors?.[0]?.message).toContain('token');
  });

  it("revokes the caller's own session and finds nobody else's", async () => {
    const other = await seedUser('other');
    const mine = await seedSession(adminId, 'mine');
    const theirs = await seedSession(other, 'theirs');

    const refused = await run('mutation ($id: Int!) { revokeSession(id: $id) }', 'admin', {
      id: theirs,
    });
    expect(refused.errors?.[0]?.message).toBe('Session not found');

    const data = await ok<{ revokeSession: boolean }>(
      'mutation ($id: Int!) { revokeSession(id: $id) }',
      { id: mine },
    );
    expect(data.revokeSession).toBe(true);
    const rows = await ctx.db.select({ id: db.sessions.id }).from(db.sessions);
    expect(rows).toEqual([{ id: theirs }]);
  });
});

describe('forward-auth sessions', () => {
  it('lists every live one or one user’s, and revokes by id', async () => {
    const other = await seedUser('other');
    const hostId = await createHost('app');
    const first = await seedForwardAuthSession(adminId, hostId, 'hash-1');
    const second = await seedForwardAuthSession(other, hostId, 'hash-2');

    const all = await ok<{ forwardAuthSessions: Record<string, unknown>[] }>(
      '{ forwardAuthSessions { id userId proxyHostId audienceOrigin } }',
    );
    expect(all.forwardAuthSessions).toEqual([
      {
        id: first,
        userId: adminId,
        proxyHostId: hostId,
        audienceOrigin: 'https://app.example.com',
      },
      { id: second, userId: other, proxyHostId: hostId, audienceOrigin: 'https://app.example.com' },
    ]);
    const one = await ok<{ forwardAuthSessions: { id: number }[] }>(
      'query ($userId: Int!) { forwardAuthSessions(userId: $userId) { id } }',
      { userId: other },
    );
    expect(one.forwardAuthSessions).toEqual([{ id: second }]);
    expect(
      (await run('{ forwardAuthSessions { tokenHash } }', 'admin')).errors?.[0]?.message,
    ).toContain('tokenHash');

    await ok('mutation ($id: Int!) { revokeForwardAuthSession(id: $id) }', { id: first });
    const rows = await ctx.db
      .select({ id: db.forwardAuthSessions.id })
      .from(db.forwardAuthSessions);
    expect(rows).toEqual([{ id: second }]);
  });
});

describe('forward-auth access', () => {
  it('replaces the whole set for a host and reads it back', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    const [group] = await ctx.db
      .insert(db.groups)
      .values({ name: 'ops', source: 'ui', createdAt: NOW, updatedAt: NOW })
      .returning({ id: db.groups.id });
    const hostId = await createHost('app');

    const set = await ok<{ setForwardAuthAccess: Record<string, unknown>[] }>(
      'mutation ($id: Int!, $input: JSON!) { setForwardAuthAccess(proxyHostId: $id, input: $input) { userId groupId } }',
      { id: hostId, input: { userIds: [alice, bob], groupIds: [group.id] } },
    );
    expect(set.setForwardAuthAccess).toEqual([
      { userId: alice, groupId: null },
      { userId: bob, groupId: null },
      { userId: null, groupId: group.id },
    ]);

    const replaced = await ok<{ setForwardAuthAccess: { userId: number | null }[] }>(
      'mutation ($id: Int!, $input: JSON!) { setForwardAuthAccess(proxyHostId: $id, input: $input) { userId } }',
      { id: hostId, input: { userIds: [bob] } },
    );
    expect(replaced.setForwardAuthAccess).toEqual([{ userId: bob }]);
    const rows = await ctx.db.select().from(db.forwardAuthAccess);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ proxyHostId: hostId, userId: bob, groupId: null });

    const read = await ok<{ forwardAuthAccess: { proxyHostId: number; userId: number }[] }>(
      'query ($id: Int!) { forwardAuthAccess(proxyHostId: $id) { proxyHostId userId } }',
      { id: hostId },
    );
    expect(read.forwardAuthAccess).toEqual([{ proxyHostId: hostId, userId: bob }]);
  });

  it('refuses a host that does not exist and a malformed set', async () => {
    const hostId = await createHost('app');
    for (const [document, variables, message] of [
      ['{ forwardAuthAccess(proxyHostId: 99999) { id } }', {}, 'Proxy host not found'],
      [
        'mutation { setForwardAuthAccess(proxyHostId: 99999, input: { userIds: [] }) { id } }',
        {},
        'Proxy host not found',
      ],
      [
        'mutation ($id: Int!) { setForwardAuthAccess(proxyHostId: $id, input: { userIds: "2" }) { id } }',
        { id: hostId },
        'userIds must be a list of user ids',
      ],
    ] as const) {
      const result = await run(document, 'admin', { ...variables });
      expect(result.errors?.[0]?.message, document).toBe(message);
    }
    expect(await ctx.db.select().from(db.forwardAuthAccess)).toEqual([]);
  });
});
