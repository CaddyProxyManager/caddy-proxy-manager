/**
 * The inverse of unlink-oauth: never without a linked provider or passkey, or the current password, and
 * nothing changes when either check fails.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';
import { nextIntlServerMock } from '../helpers/next-intl';

vi.mock('next-intl/server', () => nextIntlServerMock());

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb, userId: 0 }));

const { createTestDb } = await import('../helpers/db');

// Hoisted: a Bun mock factory must be synchronous, and an async one hangs the file.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('@/src/lib/models/audit', () => ({ createAuditEvent: vi.fn() }));

import type { NextRequest } from 'next/server';
import { POST } from '@/src/app/api/user/remove-password/route';
import { auth } from '@/src/lib/auth';
import { createUser, getUserById } from '../../src/lib/models/user';
import { hashPassword } from '../../src/lib/password';
import { accounts, passkeys } from '../../src/lib/db/schema';
import { eq } from 'drizzle-orm';

const PASSWORD = 'CorrectHorse2026!';

// setup.bun.ts pins the session to a fixed admin; each test names the user it seeded instead.
vi.mocked(auth).mockImplementation(
  async () => ({ user: { id: String(ctx.userId), email: 'u@example.com', role: 'user' } }) as any,
);

let seq = 0;

async function seedUser(options: { linkProvider: boolean }) {
  seq += 1;
  const email = `remove-${seq}@example.com`;
  const user = await createUser({
    email,
    provider: 'credential',
    subject: email,
    passwordHash: await hashPassword(PASSWORD),
  });
  if (options.linkProvider) {
    const now = new Date().toISOString();
    await ctx.db.insert(accounts).values({
      userId: user.id,
      accountId: `sub-${seq}`,
      providerId: 'authentik',
      createdAt: now,
      updatedAt: now,
    });
  }
  ctx.userId = user.id;
  return user;
}

/** By hand: a real Request drops the Host header checkSameOrigin compares Origin against. */
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

describe('POST /api/user/remove-password', () => {
  it('drops the password and credential account when a provider is linked', async () => {
    const user = await seedUser({ linkProvider: true });

    const response = await post({ currentPassword: PASSWORD });

    expect(response.status).toBe(200);
    expect(await providersOf(user.id)).toEqual(['authentik']);
    const after = await getUserById(user.id);
    expect(after?.passwordHash).toBeNull();
    // The cached projection follows the accounts table rather than still claiming "credentials".
    expect(after?.provider).toBe('authentik');
  });

  it('refuses when no provider is linked, so the account is never left with no way in', async () => {
    const user = await seedUser({ linkProvider: false });

    const response = await post({ currentPassword: PASSWORD });

    expect(response.status).toBe(400);
    expect(await providersOf(user.id)).toEqual(['credential']);
    expect((await getUserById(user.id))?.passwordHash).not.toBeNull();
  });

  it('drops the password of an account that signs in with a passkey instead', async () => {
    const user = await seedUser({ linkProvider: false });
    await ctx.db.insert(passkeys).values({
      userId: user.id,
      publicKey: 'cose',
      credentialID: `credential-${user.id}`,
      counter: 0,
      deviceType: 'multiDevice',
      backedUp: true,
      createdAt: new Date().toISOString(),
    });

    const response = await post({ currentPassword: PASSWORD });

    expect(response.status).toBe(200);
    expect(await providersOf(user.id)).toEqual([]);
    expect((await getUserById(user.id))?.passwordHash).toBeNull();
  });

  it('refuses a wrong current password and changes nothing', async () => {
    const user = await seedUser({ linkProvider: true });

    const response = await post({ currentPassword: 'NotThePassword1!' });

    expect(response.status).toBe(401);
    expect(await providersOf(user.id)).toEqual(['authentik', 'credential']);
    expect((await getUserById(user.id))?.passwordHash).not.toBeNull();
  });

  it('requires the current password', async () => {
    const user = await seedUser({ linkProvider: true });

    const response = await post({});

    expect(response.status).toBe(400);
    expect((await getUserById(user.id))?.passwordHash).not.toBeNull();
  });
});
