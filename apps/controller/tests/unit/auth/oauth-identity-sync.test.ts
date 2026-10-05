/**
 * #261: `accounts` is the source of truth; `users.provider`/`subject` are re-derived from it by
 * the account hooks and after unlinking, and the Profile page reads `accounts` directly.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { nextIntlServerMock } from '../../helpers/next-intl';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb, unlinkUserId: 0 }));

const { createTestDb } = await import('../../helpers/db');

// Outside the factory: an async Bun mock factory never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('next-intl/server', () => nextIntlServerMock());

// Hands back the raw options, so their databaseHooks are the real functions CPM wired.
vi.mock('better-auth', () => ({
  betterAuth: (options: any) => ({ options }),
}));
vi.mock('better-auth/plugins', () => ({
  genericOAuth: () => ({}),
  username: () => ({}),
}));

import { getAuth } from '../../../src/lib/auth/server';
import {
  createUser,
  getUserById,
  syncUserOAuthIdentity,
  listUserOAuthProviders,
} from '../../../src/lib/models/user';
import { accounts, oauthProviders, users } from '../../../src/lib/db/schema';
import { auth } from '@/src/lib/auth';
import { eq } from 'drizzle-orm';

// setup.bun.ts pins a fixed admin; the unlink route needs the test's own user.
vi.mocked(auth).mockImplementation(
  async () =>
    ({
      user: { id: String(ctx.unlinkUserId), email: 'unlink@example.com', role: 'user' },
    }) as any,
);

const db = () => ctx.db;

const NOW = '2026-02-01T00:00:00.000Z';

async function seedProvider(id: string, issuer: string) {
  await db()
    .insert(oauthProviders)
    .values({
      id,
      name: `IdP ${id}`,
      type: 'oidc',
      clientId: 'cid',
      clientSecret: 'secret',
      issuer,
      scopes: 'openid email profile',
      autoLink: true,
      enabled: true,
      source: 'ui',
      createdAt: NOW,
      updatedAt: NOW,
    });
}

/** Better Auth writes only the `accounts` row; the hook under test does the rest. */
async function createAccountLikeBetterAuth(userId: number, providerId: string, accountId: string) {
  await db().insert(accounts).values({
    userId,
    accountId,
    providerId,
    createdAt: NOW,
    updatedAt: NOW,
  });

  const options = ((await getAuth()) as any).options;
  expect(typeof options.databaseHooks?.account?.create?.after).toBe('function');
  await options.databaseHooks.account.create.after({
    userId: String(userId),
    providerId,
    accountId,
  });
}

beforeAll(async () => {
  await seedProvider('prov-a', 'https://a.example');
  await seedProvider('prov-b', 'https://b.example');
});

describe('#261 - account.create.after keeps users.provider/subject in sync', () => {
  it('syncs provider/subject when Better Auth links an OAuth identity to an existing user', async () => {
    const user = await createUser({
      email: 'autolink@example.com',
      name: 'Auto Link',
      provider: 'credentials',
      subject: null as unknown as string,
      passwordHash: 'x'.repeat(60),
    });

    await createAccountLikeBetterAuth(user.id, 'prov-a', 'sub-a-1');

    const fresh = await getUserById(user.id);
    expect(fresh?.provider).toBe('prov-a');
    expect(fresh?.subject).toBe('sub-a-1');
  });

  it('syncs provider/subject for brand-new federated sign-ups too', async () => {
    // Better Auth creates the user (with "" columns) before the accounts row.
    const user = await createUser({
      email: 'federated@example.com',
      name: 'Federated',
      provider: '',
      subject: '',
    });

    await createAccountLikeBetterAuth(user.id, 'prov-b', 'sub-b-1');

    const fresh = await getUserById(user.id);
    expect(fresh?.provider).toBe('prov-b');
    expect(fresh?.subject).toBe('sub-b-1');
  });

  it('also syncs on account updates (repeat OAuth sign-ins refresh the row)', async () => {
    const user = await createUser({
      email: 'resignin@example.com',
      name: 'Re Sign-in',
      provider: '',
      subject: '',
    });
    await db().insert(accounts).values({
      userId: user.id,
      accountId: 'sub-a-resignin',
      providerId: 'prov-a',
      createdAt: NOW,
      updatedAt: NOW,
    });

    const options = ((await getAuth()) as any).options;
    await options.databaseHooks.account.update.after({
      userId: String(user.id),
      providerId: 'prov-a',
      accountId: 'sub-a-resignin',
    });

    const fresh = await getUserById(user.id);
    expect(fresh?.provider).toBe('prov-a');
    expect(fresh?.subject).toBe('sub-a-resignin');
  });

  it('normalizes credential accounts to provider="credentials", subject=null', async () => {
    const user = await createUser({
      email: 'local@example.com',
      name: 'Local',
      provider: '',
      subject: '',
      passwordHash: 'y'.repeat(60),
    });
    await db()
      .insert(accounts)
      .values({
        userId: user.id,
        accountId: String(user.id),
        providerId: 'credential',
        password: 'y'.repeat(60),
        createdAt: NOW,
        updatedAt: NOW,
      });

    const options = ((await getAuth()) as any).options;
    await options.databaseHooks.account.create.after({
      userId: String(user.id),
      providerId: 'credential',
      accountId: String(user.id),
    });

    const fresh = await getUserById(user.id);
    expect(fresh?.provider).toBe('credentials');
    expect(fresh?.subject).toBeNull();
  });
});

describe('#261 - syncUserOAuthIdentity', () => {
  it('prefers the latest OAuth account when several identities exist', async () => {
    const user = await createUser({
      email: 'multi@example.com',
      name: 'Multi',
      provider: 'credentials',
      subject: null as unknown as string,
      passwordHash: 'x'.repeat(60),
    });
    await db()
      .insert(accounts)
      .values([
        {
          userId: user.id,
          accountId: 'sub-a-9',
          providerId: 'prov-a',
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          userId: user.id,
          accountId: 'sub-b-9',
          providerId: 'prov-b',
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]);

    await syncUserOAuthIdentity(user.id);

    const fresh = await getUserById(user.id);
    expect(fresh?.provider).toBe('prov-b');
    expect(fresh?.subject).toBe('sub-b-9');
  });

  it('falls back to "credentials" once the OAuth identity is gone but a password remains', async () => {
    const user = await createUser({
      email: 'fallback@example.com',
      name: 'Fallback',
      provider: 'prov-a',
      subject: 'sub-a-fallback',
      passwordHash: 'x'.repeat(60),
    });
    await db().insert(accounts).values({
      userId: user.id,
      accountId: 'sub-a-fallback',
      providerId: 'prov-a',
      createdAt: NOW,
      updatedAt: NOW,
    });

    await db().delete(accounts).where(eq(accounts.userId, user.id));
    await syncUserOAuthIdentity(user.id);

    const fresh = await getUserById(user.id);
    expect(fresh?.provider).toBe('credentials');
    expect(fresh?.subject).toBeNull();
  });

  it('clears provider for an identity-less user (no password, no OAuth)', async () => {
    const user = await createUser({
      email: 'bare@example.com',
      name: 'Bare',
      provider: 'prov-a',
      subject: 'sub-a-1',
    });
    await db().delete(accounts).where(eq(accounts.userId, user.id));

    await syncUserOAuthIdentity(user.id);

    const fresh = await getUserById(user.id);
    expect(fresh?.provider).toBeNull();
    expect(fresh?.subject).toBeNull();
  });
});

describe('#261 - unlink API re-derives identity from the accounts table', () => {
  it('resets users.provider/subject after the OAuth rows are deleted', async () => {
    const { POST } = await import('../../../src/app/api/user/unlink-oauth/route');

    const { hashPassword } = await import('../../../src/lib/auth/password');

    const user = await createUser({
      email: 'unlink@example.com',
      name: 'Unlink Me',
      provider: 'credentials',
      subject: null as unknown as string,
      passwordHash: await hashPassword('CorrectHorse2026!'),
    });
    ctx.unlinkUserId = user.id;
    await createAccountLikeBetterAuth(user.id, 'prov-a', 'sub-a-unlink');
    expect((await getUserById(user.id))?.provider).toBe('prov-a');

    const request = {
      method: 'POST',
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'origin' ? 'http://localhost:3000' : 'localhost:3000',
      },
      json: async () => ({ currentPassword: 'CorrectHorse2026!' }),
    } as unknown as Request;

    const response = await POST(request as any);
    expect(response.status).toBe(200);

    const fresh = await getUserById(user.id);
    expect(fresh?.provider).toBe('credentials');
    expect(fresh?.subject).toBeNull();

    const remaining = await db().select().from(accounts).where(eq(accounts.userId, user.id));
    expect(remaining.map((a) => a.providerId)).toEqual(['credential']);
  });
});

describe('#261 - profile connection state is derived from the accounts table', () => {
  it('lists linked OAuth providers from accounts, not from users.provider', async () => {
    const user = await createUser({
      email: 'derived@example.com',
      name: 'Derived',
      provider: '',
      subject: '',
      passwordHash: 'x'.repeat(60),
    });
    await createAccountLikeBetterAuth(user.id, 'prov-a', 'sub-a-derived');

    // A stale users.provider must not hide the link.
    await db().update(users).set({ provider: '', subject: '' }).where(eq(users.id, user.id));

    const linked = await listUserOAuthProviders(user.id);
    expect(linked).toEqual([{ providerId: 'prov-a', accountId: 'sub-a-derived' }]);

    await db().delete(accounts).where(eq(accounts.userId, user.id));
    expect(await listUserOAuthProviders(user.id)).toEqual([]);
  });
});
