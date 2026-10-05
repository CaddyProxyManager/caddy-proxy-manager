/**
 * Accounts Better Auth creates follow CPM's sign-in name rules, and a disabled account gets no
 * session. Boots the real auth server against a real database, as email-signup.test.ts does, so
 * the hooks run as they do in production.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/tests/helpers/db';
import { TEST_ENV } from '@/tests/helpers/env';
import { reloadConfig } from '@/tests/helpers/config';
import { reloadDbModule } from '@/tests/helpers/fresh-db';
import { vi } from '@/tests/helpers/vi';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';

vi.mock('next-intl/server', () => nextIntlServerMock());

const PASSWORD = 'Strong-Password-2026!';
const OTHER_PASSWORD = 'Other-Password-2026!';
const BASE = 'http://localhost:3000';

const cleanups: Array<() => void | Promise<void>> = [];

function resetDbModuleState() {
  const globals = globalThis as typeof globalThis & {
    __DRIZZLE_DB__?: unknown;
    __DB_CLIENT__?: unknown;
    __MIGRATIONS_RAN__?: boolean;
  };
  delete globals.__DRIZZLE_DB__;
  delete globals.__DB_CLIENT__;
  delete globals.__MIGRATIONS_RAN__;
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  process.env.DATABASE_URL = TEST_ENV.DATABASE_URL;
  process.env.CPM_EPHEMERAL_DB = TEST_ENV.CPM_EPHEMERAL_DB;
  delete process.env.AUTH_ALLOW_SELF_REGISTRATION;
  delete process.env.AUTH_RATE_LIMIT_ENABLED;
  resetDbModuleState();
});

async function boot() {
  const database = await createTestDatabase();
  cleanups.push(() => database.drop());
  process.env.DATABASE_URL = database.url;
  delete process.env.CPM_EPHEMERAL_DB;
  process.env.AUTH_ALLOW_SELF_REGISTRATION = 'true';
  process.env.AUTH_RATE_LIMIT_ENABLED = 'false';
  resetDbModuleState();

  await reloadConfig();
  const { dbModule, schema } = await reloadDbModule();
  cleanups.push(() => (dbModule.client as { close?: () => Promise<void> })?.close?.());

  const authServer = await import('@/src/lib/auth/server');
  // Or getAuth() hands back the instance built on the previous boot's database.
  authServer.invalidateProviderCache();
  // betterAuth's instance type is generated from its config; the test tree allows `any`.
  const auth = (await authServer.getAuth()) as any;
  const userModel = await import('@/src/lib/models/user');
  const { hashPassword } = await import('@/src/lib/auth/password');
  const db = dbModule.default;

  type ApiCall = (args: { body: Record<string, unknown> }) => Promise<unknown>;
  const api = (name: string) => (auth.api as Record<string, ApiCall>)[name];

  return {
    db,
    schema,
    auth,
    userModel,
    signUp: (body: Record<string, unknown>) =>
      api('signUpEmail')({ body: { password: PASSWORD, name: 'Someone', ...body } }) as Promise<{
        user?: { id?: string; username?: string | null };
      }>,
    /** The user id the username sign-in reaches, or null when it refuses. */
    signIn: async (username: string, password: string) => {
      try {
        const result = (await api('signInUsername')({ body: { username, password } })) as {
          user?: { id?: string };
        };
        return result.user?.id ?? null;
      } catch {
        return null;
      }
    },
    apiError: async (name: string, body: Record<string, unknown>) => {
      const error = await api(name)({ body }).then(
        () => {
          throw new Error('expected the call to be rejected');
        },
        (e: unknown) => e as { statusCode?: number; message?: string; body?: { message?: string } },
      );
      return { statusCode: error.statusCode, message: error.body?.message ?? error.message };
    },
    stored: async (userId: number | string) => {
      const [row] = await db
        .select({ username: schema.users.username, displayUsername: schema.users.displayUsername })
        .from(schema.users)
        .where(eq(schema.users.id, Number(userId)));
      return row;
    },
    count: async (email: string) =>
      (await db.select().from(schema.users).where(eq(schema.users.email, email))).length,
    sessionsOf: async (userId: number) =>
      db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId)),
    /** An OAuth sign-up's user: no username, no password. */
    seedOAuthUser: async (email: string) => {
      const now = new Date().toISOString();
      const [user] = await db
        .insert(schema.users)
        .values({ email, role: 'user', status: 'active', createdAt: now, updatedAt: now })
        .returning();
      return user;
    },
    hashPassword,
  };
}

describe('self-registration usernames', () => {
  it("does not store another account's email address as the registrant's username", async () => {
    const app = await boot();
    const victim = await app.seedOAuthUser('victim@example.com');

    const attacker = await app.signUp({
      email: 'attacker@evil.example.com',
      username: 'victim@example.com',
    });

    expect(attacker.user?.username).toBe('attacker@evil.example.com');
    expect((await app.stored(attacker.user!.id!))?.username).toBe('attacker@evil.example.com');

    // The victim's own address stays theirs to sign in with.
    await app.userModel.updateUserPassword(victim.id, await app.hashPassword(OTHER_PASSWORD));
    expect(await app.userModel.getPasswordSignInUsername(victim.id)).toBe('victim@example.com');
    expect(await app.signIn('victim@example.com', OTHER_PASSWORD)).toBe(String(victim.id));
    expect(await app.signIn('victim@example.com', PASSWORD)).toBeNull();
    expect(await app.signIn('attacker@evil.example.com', PASSWORD)).toBe(attacker.user?.id ?? '');
  });

  it('ignores a chosen username or display username, in any case', async () => {
    const app = await boot();
    const bob = await app.userModel.createUser({
      email: 'bob@example.com',
      provider: 'credentials',
      subject: 'bob',
      username: 'bob',
      passwordHash: await app.hashPassword(OTHER_PASSWORD),
    });

    const upper = await app.signUp({ email: 'mallory@example.com', username: 'BOB@example.com' });
    const display = await app.signUp({ email: 'trudy@example.com', displayUsername: 'Bob' });

    expect(await app.stored(upper.user!.id!)).toEqual({
      username: 'mallory@example.com',
      displayUsername: 'mallory@example.com',
    });
    expect(await app.stored(display.user!.id!)).toEqual({
      username: 'trudy@example.com',
      displayUsername: 'trudy@example.com',
    });
    expect(await app.signIn('bob', PASSWORD)).toBeNull();
    expect(await app.signIn('bob', OTHER_PASSWORD)).toBe(String(bob.id));
  });

  it('signs a registrant in with their own email address, in any case', async () => {
    const app = await boot();
    const dave = await app.signUp({ email: 'Dave@Example.com' });

    expect(dave.user?.username).toBe('dave@example.com');
    expect(await app.signIn('DAVE@example.com', PASSWORD)).toBe(dave.user?.id ?? '');
  });

  it('gives a registrant whose email the login page refuses no username', async () => {
    const app = await boot();
    const carol = await app.signUp({
      email: 'carol+x@example.com',
      username: 'carol-x@example.com',
    });

    expect(carol.user?.username).toBeNull();
    expect(await app.signIn('carol-x@example.com', PASSWORD)).toBeNull();
  });

  it('refuses a registration whose email another account signs in with, as a taken email', async () => {
    const app = await boot();
    await app.userModel.createUser({
      email: 'anna@example.com',
      provider: 'credentials',
      subject: 'anna',
      username: 'boss@example.com',
    });

    const boss = await app.apiError('signUpEmail', {
      email: 'Boss@Example.com',
      password: PASSWORD,
      name: 'Boss',
    });

    expect(boss).toEqual({ statusCode: 422, message: 'User already exists. Use another email.' });
    expect(await app.count('boss@example.com')).toBe(0);
  });

  it('does not say over HTTP whether a requested username is taken', async () => {
    const app = await boot();
    await app.userModel.createUser({
      email: 'owen@example.com',
      provider: 'credentials',
      subject: 'owen',
      username: 'owen',
    });
    const post = (body: Record<string, unknown>) =>
      app.auth.handler(
        new Request(`${BASE}/api/auth/sign-up/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE },
          body: JSON.stringify({ password: PASSWORD, name: 'Someone', ...body }),
        }),
      ) as Promise<Response>;

    const taken = await post({ email: 'olivia@example.com', username: 'owen' });
    expect(taken.status).toBe(200);
    expect((await taken.json()).user.username).toBe('olivia@example.com');
  });
});

describe('accounts Better Auth creates outside self-registration (OAuth sign-up)', () => {
  type InternalAdapter = {
    createUser: (user: Record<string, unknown>) => Promise<{ id: string | number }>;
  };
  async function internalAdapter(app: Awaited<ReturnType<typeof boot>>) {
    return ((await app.auth.$context) as { internalAdapter: InternalAdapter }).internalAdapter;
  }

  it('stores no username, whatever the profile carried', async () => {
    const app = await boot();
    await app.seedOAuthUser('owner@example.com');

    const created = await (await internalAdapter(app)).createUser({
      email: 'idp-user@example.com',
      name: 'IdP User',
      emailVerified: false,
      username: 'owner@example.com',
    });

    expect((await app.stored(created.id))?.username).toBeNull();
  });

  it("refuses an email that is another account's username or would claim a portal name", async () => {
    const app = await boot();
    await app.userModel.createUser({
      email: 'zed@example.com',
      provider: 'credentials',
      subject: 'zed',
      username: 'chief@example.com',
    });
    const adapter = await internalAdapter(app);

    await expect(
      adapter.createUser({ email: 'chief@example.com', name: 'Chief', emailVerified: false }),
    ).rejects.toThrow('Another account signs in with this email address as its username');
    for (const email of ['root', 'ops@localhost', 'Newbie@LOCALHOST', '@example.com', 'x@']) {
      await expect(adapter.createUser({ email, name: 'X', emailVerified: false })).rejects.toThrow(
        'Email address is not allowed',
      );
      expect(await app.count(email.toLowerCase())).toBe(0);
    }
    expect(await app.count('chief@example.com')).toBe(0);
  });
});

describe('disabled accounts', () => {
  it('get no session, and a correct password is refused as a wrong one', async () => {
    const app = await boot();
    const signedUp = await app.signUp({ email: 'dora@example.com' });
    const userId = Number(signedUp.user!.id);
    expect((await app.sessionsOf(userId)).length).toBeGreaterThan(0);

    await app.userModel.updateUserStatus(userId, 'disabled');
    expect(await app.sessionsOf(userId)).toEqual([]);

    const attempt = (password: string) =>
      app.apiError('signInUsername', { username: 'dora@example.com', password });
    const wrong = await attempt(`${PASSWORD}-wrong`);
    expect(await attempt(PASSWORD)).toEqual(wrong);
    expect(wrong).toEqual({ statusCode: 401, message: 'Invalid username or password' });
    expect(
      await app.apiError('signInEmail', { email: 'dora@example.com', password: PASSWORD }),
    ).toEqual({ statusCode: 401, message: 'Invalid email or password' });
    expect(await app.sessionsOf(userId)).toEqual([]);

    await app.userModel.updateUserStatus(userId, 'active');
    expect(await app.signIn('dora@example.com', PASSWORD)).toBe(String(userId));
  });
});
