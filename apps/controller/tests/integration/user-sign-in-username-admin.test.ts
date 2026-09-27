/**
 * Administrators set a user's sign-in username explicitly - PUT and POST /api/v1/users and the
 * Users page's edit action - against a real database. It must be usable by the login page and not
 * another account's username, email or portal name; the change is audited, nobody else can make
 * it, and a refused username or email leaves every other field of the request unchanged.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  caller: { userId: 1, role: 'admin' },
}));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => ({
  default: ctx.db,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null =>
    !value ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
  runInTransaction: async (build: (tx: TestDb) => unknown[]) => {
    for (const statement of build(ctx.db)) await statement;
  },
}));
vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const actualAuth = await import('@/src/lib/auth');
vi.mock('@/src/lib/auth', () => ({
  ...actualAuth,
  requireAdmin: vi.fn(async () => {
    if (ctx.caller.role !== 'admin') throw new Error('adminRequired');
    return { user: { id: String(ctx.caller.userId), role: ctx.caller.role } };
  }),
}));
const actualApiAuth = await import('@/src/lib/api-auth');
vi.mock('@/src/lib/api-auth', () => {
  const result = () => ({
    userId: ctx.caller.userId,
    role: ctx.caller.role,
    authMethod: 'bearer' as const,
  });
  return {
    ...actualApiAuth,
    requireApiUser: vi.fn(async () => result()),
    requireApiAdmin: vi.fn(async () => {
      if (ctx.caller.role !== 'admin') {
        throw new actualApiAuth.ApiAuthError('Administrator privileges required', 403);
      }
      return result();
    }),
  };
});

import { eq } from 'drizzle-orm';
import { POST as createUserRoute } from '@/src/app/api/v1/users/route';
import { PUT as updateUserRoute } from '@/src/app/api/v1/users/[id]/route';
import { updateUserInfoAction } from '@/src/app/(dashboard)/users/actions';
import { logAuditEvent } from '@/src/lib/audit';
import { domainErrorMessage } from '@/src/lib/domain-error';
import { signInUsernameRulesMessage } from '@/src/lib/user-admin';
import { settings, users } from '../../src/lib/db/schema';

const NOW = '2026-02-01T00:00:00.000Z';
const TAKEN = domainErrorMessage('signInNameTaken');
const RULES = signInUsernameRulesMessage();

async function seedUser(email: string, username: string | null, role = 'user') {
  const [row] = await ctx.db
    .insert(users)
    .values({
      email,
      username,
      displayUsername: username,
      name: null,
      role,
      provider: 'credentials',
      subject: email,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning();
  return row.id;
}

async function stored(userId: number) {
  const [row] = await ctx.db
    .select({
      username: users.username,
      displayUsername: users.displayUsername,
      role: users.role,
      status: users.status,
      name: users.name,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, userId));
  return row;
}

/** setup.bun.ts replaces logAuditEvent with a mock. */
function auditRows() {
  return vi.mocked(logAuditEvent).mock.calls.map(([event]) => event);
}

function request(body: unknown): never {
  return { headers: { get: () => null }, json: async () => body } as never;
}

function put(userId: number, body: unknown) {
  return updateUserRoute(request(body), { params: Promise.resolve({ id: String(userId) }) });
}

let adminId: number;

beforeEach(async () => {
  vi.mocked(logAuditEvent).mockClear();
  await ctx.db.delete(settings);
  await ctx.db.delete(users);
  adminId = await seedUser('admin@example.com', 'admin', 'admin');
  // A second admin: the role and status checks below must not trip the last-admin guard.
  await seedUser('root@example.com', 'root', 'admin');
  ctx.caller.userId = adminId;
  ctx.caller.role = 'admin';
});

describe('PUT /api/v1/users/{id} username', () => {
  it('sets the username, returns it and audits the change', async () => {
    const userId = await seedUser('alice+cpm@example.com', 'alice+cpm@example.com');

    const res = await put(userId, { username: ' alice.cpm ' });

    expect(res.status).toBe(200);
    expect((await res.json()).username).toBe('alice.cpm');
    expect(await stored(userId)).toMatchObject({
      username: 'alice.cpm',
      displayUsername: 'alice.cpm',
    });
    const [event] = auditRows();
    expect(event).toMatchObject({
      userId: adminId,
      action: 'update',
      entityType: 'user',
      entityId: userId,
    });
    expect(event.summary).toContain('alice.cpm');
    expect(event.data).toEqual({
      previousUsername: 'alice+cpm@example.com',
      username: 'alice.cpm',
    });
  });

  it.each([['Alice'], ['alice+cpm@example.com'], ['ab'], [''], ['bad name'], [42]])(
    'answers %p with 400 and changes nothing',
    async (username) => {
      const userId = await seedUser('alice@example.com', 'alice');

      const res = await put(userId, { username, name: 'Changed', role: 'viewer' });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(RULES);
      expect(await stored(userId)).toMatchObject({ username: 'alice', name: null, role: 'user' });
      expect(auditRows()).toEqual([]);
    },
  );

  it("answers another account's username, email or portal name, in any case, with 400", async () => {
    await seedUser('Holder@Example.com', 'holder');
    // The forward-auth portal reads "ops" as ops@localhost.
    await seedUser('Ops@localhost', 'ops@localhost');
    const userId = await seedUser('alice@example.com', 'alice');

    for (const username of [
      'holder',
      'holder@example.com',
      'admin',
      'admin@example.com',
      'ops',
      'ops@localhost',
    ]) {
      const res = await put(userId, { username });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(TAKEN);
    }
    expect((await stored(userId))?.username).toBe('alice');
    expect(auditRows()).toEqual([]);
  });

  it('does not audit setting the username the user already has', async () => {
    const userId = await seedUser('alice@example.com', 'alice');
    const res = await put(userId, { username: 'alice' });
    expect(res.status).toBe(200);
    expect(auditRows()).toEqual([]);
  });

  it('treats a null username as no change, as a GET body sent back carries it', async () => {
    const userId = await seedUser('alice@example.com', 'alice');

    const res = await put(userId, { username: null, name: 'Changed' });

    expect(res.status).toBe(200);
    expect(await stored(userId)).toMatchObject({ username: 'alice', name: 'Changed' });
  });

  it('answers 404 for a user that does not exist', async () => {
    const res = await put(999_999, { username: 'nobody' });
    expect(res.status).toBe(404);
  });

  it('refuses a caller who is not an administrator, including for their own account', async () => {
    const userId = await seedUser('alice@example.com', 'alice');
    ctx.caller.userId = userId;
    ctx.caller.role = 'user';

    for (const target of [userId, adminId]) {
      const res = await put(target, { username: 'someone' });
      expect(res.status).toBe(403);
    }
    expect((await stored(userId))?.username).toBe('alice');
    expect((await stored(adminId))?.username).toBe('admin');
    expect(auditRows()).toEqual([]);
  });

  it('leaves the username alone when only the email changes', async () => {
    const userId = await seedUser('alice+cpm@example.com', null);
    const res = await put(userId, { email: 'alice@example.com' });
    expect(res.status).toBe(200);
    expect((await stored(userId))?.username).toBeNull();
  });

  it('stores an email trimmed and lowercased', async () => {
    const userId = await seedUser('alice@example.com', 'alice');
    const res = await put(userId, { email: '  Alice.New@Example.COM ' });
    expect(res.status).toBe(200);
    expect((await stored(userId))?.email).toBe('alice.new@example.com');
  });

  it('refuses an email that lowercasing would turn into another address', async () => {
    const userId = await seedUser('alice@example.com', 'alice');
    const kelvin = String.fromCodePoint(0x212a);
    const res = await put(userId, { email: `${kelvin}ate@example.com` });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(domainErrorMessage('emailLowercasesIntoAscii'));
    expect((await stored(userId))?.email).toBe('alice@example.com');
  });

  it('answers an email address another account signs in with with 400 and changes nothing', async () => {
    await seedUser('anna@example.com', 'boss@example.com');
    await seedUser('erin@example.com', 'ops');
    const userId = await seedUser('ben@example.com', 'ben');

    for (const email of ['boss@example.com', 'Boss@Example.com', 'ops@localhost']) {
      const res = await put(userId, {
        email,
        username: 'benjamin',
        name: 'Changed',
        role: 'viewer',
        status: 'disabled',
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/^Another account signs in with/);
    }
    expect(await stored(userId)).toMatchObject({
      email: 'ben@example.com',
      username: 'ben',
      name: null,
      role: 'user',
      status: 'active',
    });
    expect(auditRows()).toEqual([]);
  });

  it("refuses a change to the caller's own role or status before changing the username", async () => {
    for (const body of [
      { username: 'boss', role: 'viewer' },
      { username: 'boss', status: 'disabled' },
    ]) {
      const res = await put(adminId, body);
      expect(res.status).toBe(400);
    }
    expect(await stored(adminId)).toMatchObject({
      username: 'admin',
      role: 'admin',
      status: 'active',
    });
    expect(auditRows()).toEqual([]);
  });

  it('applies a valid username together with the other fields', async () => {
    const userId = await seedUser('alice@example.com', 'alice');

    const res = await put(userId, { username: 'alice.a', name: 'Alice', role: 'viewer' });

    expect(res.status).toBe(200);
    expect(await stored(userId)).toMatchObject({
      username: 'alice.a',
      name: 'Alice',
      role: 'viewer',
    });
  });
});

describe('POST /api/v1/users username', () => {
  const PASSWORD = 'Compliant-Pass-2026';

  function create(body: Record<string, unknown>) {
    return createUserRoute(request({ email: 'new@example.com', password: PASSWORD, ...body }));
  }

  async function newUsers() {
    return ctx.db.select().from(users).where(eq(users.email, 'new@example.com'));
  }

  it('uses an explicit username', async () => {
    const res = await create({ email: 'new+tag@example.com', username: 'newbie' });
    expect(res.status).toBe(201);
    expect((await res.json()).username).toBe('newbie');
  });

  it('gives an email the login page refuses no username instead of a made-up one', async () => {
    const res = await create({ email: 'new+tag@example.com' });
    expect(res.status).toBe(201);
    expect((await res.json()).username).toBeNull();
  });

  it('gives a qualifying email itself as the username', async () => {
    const res = await create({ email: 'New@Example.com' });
    expect(res.status).toBe(201);
    expect((await res.json()).username).toBe('new@example.com');
  });

  it('refuses an unusable or taken username with 400 and creates nobody', async () => {
    await seedUser('holder@example.com', 'holder');
    await seedUser('ops@localhost', 'ops@localhost');
    for (const [username, error] of [
      ['New', RULES],
      [7, RULES],
      ['holder', TAKEN],
      ['holder@example.com', TAKEN],
      ['ops', TAKEN],
    ] as const) {
      const res = await create({ username });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(error);
    }
    expect(await newUsers()).toEqual([]);
  });

  it('refuses an email address another account has or signs in with, with 400', async () => {
    await seedUser('holder@example.com', 'new@example.com');
    const res = await create({});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(domainErrorMessage('emailIsAnotherUsername'));

    const duplicate = await create({ email: 'Holder@Example.com' });
    expect(duplicate.status).toBe(400);
    expect((await duplicate.json()).error).toBe(domainErrorMessage('emailTaken'));
    expect(await ctx.db.select().from(users)).toHaveLength(3);
  });

  it('refuses a caller who is not an administrator', async () => {
    ctx.caller.role = 'user';
    const res = await create({ username: 'newbie' });
    expect(res.status).toBe(403);
    expect(await newUsers()).toEqual([]);
  });
});

describe('updateUserInfoAction username', () => {
  function edit(userId: number, fields: Record<string, string>) {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return updateUserInfoAction(userId, data);
  }

  it('sets the username with the other fields and audits the change', async () => {
    const userId = await seedUser('alice+cpm@example.com', null);

    const result = await edit(userId, {
      name: 'Alice',
      email: 'alice+cpm@example.com',
      username: ' alice ',
    });

    expect(result.status).toBe('success');
    expect(await stored(userId)).toMatchObject({
      username: 'alice',
      displayUsername: 'alice',
      name: 'Alice',
    });
    const usernameEvent = auditRows().find((event) => event.data);
    expect(usernameEvent).toMatchObject({
      userId: adminId,
      action: 'update',
      entityType: 'user',
      entityId: userId,
    });
    expect(usernameEvent?.data).toEqual({ previousUsername: null, username: 'alice' });
  });

  it('returns the reason a username or email address cannot be used and saves nothing', async () => {
    await seedUser('holder@example.com', 'holder');
    const userId = await seedUser('alice@example.com', 'alice');

    for (const [fields, error] of [
      [{ username: 'Alice' }, RULES],
      [{ username: 'holder@example.com' }, TAKEN],
      [{ username: 'alice2', email: 'holder@example.com' }, domainErrorMessage('emailTaken')],
    ] as const) {
      const result = await edit(userId, { name: 'Changed', ...fields });
      expect(result).toMatchObject({ status: 'error', message: error });
    }
    expect(await edit(999_999, { username: 'nobody' })).toMatchObject({ status: 'error' });
    expect(await stored(userId)).toMatchObject({
      username: 'alice',
      name: null,
      email: 'alice@example.com',
    });
    expect(auditRows()).toEqual([]);
  });

  it('saves the other fields when the username field holds the unusable one the user has', async () => {
    const userId = await seedUser('bob@example.com', 'Bob');

    expect((await edit(userId, { name: 'Bob B.', username: 'Bob' })).status).toBe('success');

    expect(await stored(userId)).toMatchObject({ username: 'Bob', name: 'Bob B.' });
    expect(auditRows().filter((event) => event.data)).toEqual([]);
  });

  it('refuses a caller who is not an administrator', async () => {
    const userId = await seedUser('alice@example.com', 'alice');
    ctx.caller.userId = userId;
    ctx.caller.role = 'user';

    expect((await edit(userId, { username: 'someone' })).status).toBe('error');

    expect((await stored(userId))?.username).toBe('alice');
    expect(auditRows()).toEqual([]);
  });
});
