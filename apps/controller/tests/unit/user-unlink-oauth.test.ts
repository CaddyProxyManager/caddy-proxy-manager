/**
 * POST /api/user/unlink-oauth leaves a signed-in user with only their password. Like
 * remove-password from the other side, it asks for that password again: a borrowed session must
 * not be enough to strip the owner's single sign-on.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { nextIntlServerMock, testTranslator } from '../helpers/next-intl';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb, userId: 0 }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

// Hoisted out of the factory below: createTestDb is async, and a Bun mock factory must be
// synchronous - an async one never resolves and the file hangs.
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

vi.mock('@/src/lib/models/audit', () => ({ createAuditEvent: vi.fn() }));
vi.mock('next-intl/server', () => nextIntlServerMock());

import type { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { POST } from '@/src/app/api/user/unlink-oauth/route';
import { auth } from '@/src/lib/auth';
import { createUser } from '../../src/lib/models/user';
import { hashPassword } from '../../src/lib/password';
import { accounts, users } from '../../src/lib/db/schema';

const PASSWORD = 'CorrectHorse2026!';

// setup.bun.ts pins the session to a fixed admin; each test names the user it seeded instead.
vi.mocked(auth).mockImplementation(
  async () => ({ user: { id: String(ctx.userId), email: 'u@example.com', role: 'user' } }) as any,
);

let seq = 0;

async function seedLinkedUser() {
  seq += 1;
  const email = `unlink-${seq}@example.com`;
  const user = await createUser({
    email,
    provider: 'credential',
    subject: email,
    passwordHash: await hashPassword(PASSWORD),
  });
  const now = new Date().toISOString();
  await ctx.db.insert(accounts).values({
    userId: user.id,
    accountId: `sub-${seq}`,
    providerId: 'authentik',
    createdAt: now,
    updatedAt: now,
  });
  ctx.userId = user.id;
  return user;
}

/** A same-origin POST, shaped by hand: a real Request drops the Host header checkSameOrigin reads. */
function post(body: unknown) {
  return POST({
    method: 'POST',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'origin' ? 'http://localhost:3000' : 'localhost:3000',
    },
    json: async () => body,
  } as unknown as NextRequest);
}

async function providersOf(userId: number) {
  const rows = await ctx.db.select().from(accounts).where(eq(accounts.userId, userId));
  return rows.map((row) => row.providerId).sort();
}

beforeEach(() => {
  ctx.userId = 0;
});

describe('POST /api/user/unlink-oauth', () => {
  it('unlinks the provider when the current password is given', async () => {
    const user = await seedLinkedUser();

    const response = await post({ currentPassword: PASSWORD });

    expect(response.status).toBe(200);
    expect(await providersOf(user.id)).toEqual(['credential']);
  });

  it('refuses without the current password, so a session alone cannot unlink', async () => {
    const user = await seedLinkedUser();

    const response = await post({});

    expect(response.status).toBe(400);
    expect(await providersOf(user.id)).toEqual(['authentik', 'credential']);
  });

  it('refuses a wrong current password and unlinks nothing', async () => {
    const user = await seedLinkedUser();

    const response = await post({ currentPassword: 'NotThePassword1!' });

    expect(response.status).toBe(401);
    expect(await providersOf(user.id)).toEqual(['authentik', 'credential']);
  });

  it('refuses while the login page has no username to sign them in with', async () => {
    const user = await seedLinkedUser();
    await ctx.db.update(users).set({ username: null }).where(eq(users.id, user.id));

    const response = await post({ currentPassword: PASSWORD });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(
      testTranslator('profile')('unlinkSignInUnavailable'),
    );
    expect(await providersOf(user.id)).toEqual(['authentik', 'credential']);
  });

  it('checks the password a self-registered user keeps on the credential account only', async () => {
    const user = await seedLinkedUser();
    await ctx.db.update(users).set({ passwordHash: null }).where(eq(users.id, user.id));

    expect((await post({ currentPassword: 'NotThePassword1!' })).status).toBe(401);
    const response = await post({ currentPassword: PASSWORD });

    expect(response.status).toBe(200);
    expect(await providersOf(user.id)).toEqual(['credential']);
  });
});
