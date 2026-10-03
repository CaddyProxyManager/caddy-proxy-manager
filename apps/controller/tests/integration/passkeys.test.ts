/**
 * Passkeys through Better Auth's real routes, against a real database, with a software
 * authenticator: the plugin verifies without requiring user verification, and CPM's hooks add
 * that, the ten-minute registration window and the lock-out guard on top.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/tests/helpers/db';
import { TEST_ENV } from '@/tests/helpers/env';
import { reloadConfig } from '@/tests/helpers/config';
import { reloadDbModule } from '@/tests/helpers/fresh-db';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import { vi } from '@/tests/helpers/vi';
import {
  type SoftwareCredential,
  authenticationResponse,
  newCredential,
  registrationResponse,
} from '@/tests/helpers/webauthn';

// CPM's refusals are worded through next-intl, which needs a request scope.
vi.mock('next-intl/server', () => nextIntlServerMock());

const ORIGIN = 'http://localhost:3000';
const RP_ID = 'localhost';
const PASSWORD = 'Passkey-password-2026!';

const cleanups: Array<() => void | Promise<void>> = [];

function resetDbModuleState() {
  delete (globalThis as typeof globalThis & { __DRIZZLE_DB__?: unknown }).__DRIZZLE_DB__;
  delete (globalThis as typeof globalThis & { __DB_CLIENT__?: unknown }).__DB_CLIENT__;
  delete (globalThis as typeof globalThis & { __MIGRATIONS_RAN__?: boolean }).__MIGRATIONS_RAN__;
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  process.env.DATABASE_URL = TEST_ENV.DATABASE_URL;
  process.env.CPM_EPHEMERAL_DB = TEST_ENV.CPM_EPHEMERAL_DB;
  delete process.env.AUTH_RATE_LIMIT_ENABLED;
  delete process.env.AUTH_DISABLE_LOCAL_USERS;
  resetDbModuleState();
});

/** One browser: the cookies Better Auth sets, sent back on the next request. */
class CookieJar {
  private readonly cookies = new Map<string, string>();

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  take(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1);
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  has(fragment: string): boolean {
    return [...this.cookies.keys()].some((name) => name.includes(fragment));
  }
}

async function boot(env: Record<string, string> = {}) {
  const database = await createTestDatabase();
  cleanups.push(() => database.drop());

  process.env.DATABASE_URL = database.url;
  delete process.env.CPM_EPHEMERAL_DB;
  process.env.AUTH_RATE_LIMIT_ENABLED = 'false';
  Object.assign(process.env, env);
  resetDbModuleState();

  await reloadConfig();

  const { dbModule, schema } = await reloadDbModule();
  cleanups.push(() => (dbModule.client as { close?: () => Promise<void> })?.close?.());

  const users = await import('@/src/lib/models/user');
  const { hashPassword } = await import('@/src/lib/password');
  const authServer = await import('@/src/lib/auth-server');
  // Or getAuth() hands back the instance built on the previous boot's database.
  authServer.invalidateProviderCache();
  // betterAuth's instance type is generated from its config; the test tree allows `any`.
  const auth = (await authServer.getAuth()) as any;
  const db = dbModule.default;

  const call = async (jar: CookieJar, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const response: Response = await auth.handler(
      new Request(`${ORIGIN}/api/auth${path}`, {
        method,
        headers: {
          origin: ORIGIN,
          cookie: jar.header(),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    jar.take(response);
    return response;
  };

  /** A local account, signed in with its password in a jar of its own. */
  const signedInUser = async (email: string) => {
    const user = await users.createUser({
      email,
      provider: 'credentials',
      subject: email,
      passwordHash: await hashPassword(PASSWORD),
    });
    const jar = new CookieJar();
    const response = await call(jar, 'POST', '/sign-in/username', {
      username: email,
      password: PASSWORD,
    });
    expect(response.status).toBe(200);
    return { user, jar };
  };

  const register = async (
    jar: CookieJar,
    options: { userVerified?: boolean; name?: string; createSession?: boolean } = {},
  ) => {
    const optionsResponse = await call(jar, 'GET', '/passkey/generate-register-options');
    if (optionsResponse.status !== 200) return { optionsResponse, credential: null, verify: null };
    const creation = await optionsResponse.json();
    const credential = newCredential();
    const verify = await call(jar, 'POST', '/passkey/verify-registration', {
      response: registrationResponse(credential, {
        challenge: creation.challenge,
        origin: ORIGIN,
        rpId: RP_ID,
        userVerified: options.userVerified ?? true,
      }),
      name: options.name ?? 'Laptop',
      ...(options.createSession ? { createSession: true } : {}),
    });
    return { optionsResponse, creation, credential, verify };
  };

  const signInWithPasskey = async (
    credential: SoftwareCredential,
    options: { userVerified?: boolean; counter?: number; origin?: string } = {},
  ) => {
    const jar = new CookieJar();
    const request = await call(jar, 'GET', '/passkey/generate-authenticate-options');
    expect(request.status).toBe(200);
    const { challenge } = await request.json();
    const response = await call(jar, 'POST', '/passkey/verify-authentication', {
      response: authenticationResponse(credential, {
        challenge,
        origin: options.origin ?? ORIGIN,
        rpId: RP_ID,
        userVerified: options.userVerified ?? true,
        counter: options.counter ?? 1,
      }),
    });
    return { jar, response };
  };

  const passkeysOf = (userId: number) =>
    db.select().from(schema.passkeys).where(eq(schema.passkeys.userId, userId));

  const signInsOf = async (userId: number) =>
    (
      await db
        .select()
        .from(schema.auditEvents)
        .where(
          and(
            eq(schema.auditEvents.userId, userId),
            eq(schema.auditEvents.action, 'login_success'),
          ),
        )
    ).length;

  return {
    db,
    schema,
    users,
    call,
    signedInUser,
    register,
    signInWithPasskey,
    passkeysOf,
    signInsOf,
  };
}

describe('passkey registration', () => {
  it('binds the passkey to the Public URL hostname and asks for a discoverable, verified one', async () => {
    const { signedInUser, register, passkeysOf } = await boot();
    const { user, jar } = await signedInUser('register@example.com');

    const { creation, verify } = await register(jar);

    expect(creation.rp).toEqual({ id: RP_ID, name: 'Caddy Proxy Manager' });
    expect(creation.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(verify?.status).toBe(200);
    const rows = await passkeysOf(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Laptop', counter: 0 });
  });

  it("needs a sign-in less than ten minutes old, not Better Auth's day", async () => {
    const { db, schema, signedInUser, register, passkeysOf } = await boot();
    const { user, jar } = await signedInUser('stale@example.com');
    await db
      .update(schema.sessions)
      .set({ createdAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() })
      .where(eq(schema.sessions.userId, user.id));

    const { optionsResponse } = await register(jar);

    expect(optionsResponse.status).toBe(403);
    expect((await optionsResponse.json()).code).toBe('SESSION_NOT_FRESH');
    expect(await passkeysOf(user.id)).toHaveLength(0);
  });

  it('refuses an authenticator that did not verify the user', async () => {
    const { signedInUser, register, passkeysOf } = await boot();
    const { user, jar } = await signedInUser('no-uv-register@example.com');

    const { verify } = await register(jar, { userVerified: false });

    expect(verify?.status).toBe(400);
    expect((await (verify as Response).json()).code).toBe('USER_NOT_VERIFIED');
    expect(await passkeysOf(user.id)).toHaveLength(0);
  });

  it('never signs in from a registration, which would restart the ten minutes', async () => {
    const { db, schema, signedInUser, register } = await boot();
    const { user, jar } = await signedInUser('create-session@example.com');
    const before = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, user.id));

    const { verify } = await register(jar, { createSession: true });

    expect(verify?.status).toBe(200);
    expect((await (verify as Response).json()).session).toBeUndefined();
    const after = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, user.id));
    expect(after).toHaveLength(before.length);
  });

  it('refuses a name longer than the Profile list shows', async () => {
    const { signedInUser, register } = await boot();
    const { jar } = await signedInUser('long-name@example.com');

    const { verify } = await register(jar, { name: 'x'.repeat(65) });

    expect(verify?.status).toBe(400);
    expect((await (verify as Response).json()).code).toBe('PASSKEY_NAME_TOO_LONG');
  });
});

describe('passkey sign-in', () => {
  it('signs in with a verified passkey, audited once', async () => {
    const { signedInUser, register, signInWithPasskey, signInsOf, passkeysOf } = await boot();
    const { user, jar } = await signedInUser('sign-in@example.com');
    const { credential } = await register(jar);
    const before = await signInsOf(user.id);

    const { jar: browser, response } = await signInWithPasskey(credential as SoftwareCredential);

    expect(response.status).toBe(200);
    expect((await response.json()).user.email).toBe('sign-in@example.com');
    expect(browser.has('session_token')).toBe(true);
    expect(await signInsOf(user.id)).toBe(before + 1);
    expect((await passkeysOf(user.id))[0].counter).toBe(1);
  });

  it('refuses an assertion without user verification, before any session', async () => {
    const { db, schema, signedInUser, register, signInWithPasskey, passkeysOf } = await boot();
    const { user, jar } = await signedInUser('no-uv-sign-in@example.com');
    const { credential } = await register(jar);
    const sessionsBefore = (
      await db.select().from(schema.sessions).where(eq(schema.sessions.userId, user.id))
    ).length;

    const { jar: browser, response } = await signInWithPasskey(credential as SoftwareCredential, {
      userVerified: false,
    });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('USER_NOT_VERIFIED');
    expect(browser.has('session_token')).toBe(false);
    const sessionsAfter = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, user.id));
    expect(sessionsAfter).toHaveLength(sessionsBefore);
    // Nor is the counter spent.
    expect((await passkeysOf(user.id))[0].counter).toBe(0);
  });

  it('refuses an assertion made for another origin', async () => {
    const { signedInUser, register, signInWithPasskey } = await boot();
    const { jar } = await signedInUser('origin@example.com');
    const { credential } = await register(jar);

    const { response } = await signInWithPasskey(credential as SoftwareCredential, {
      origin: 'https://phishing.example',
    });

    expect(response.status).toBe(400);
  });

  it('refuses a disabled account', async () => {
    const { db, schema, signedInUser, register, signInWithPasskey } = await boot();
    const { user, jar } = await signedInUser('disabled@example.com');
    const { credential } = await register(jar);
    await db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, user.id));
    const sessionsOf = () =>
      db.select().from(schema.sessions).where(eq(schema.sessions.userId, user.id));
    const before = (await sessionsOf()).length;

    const { jar: browser, response } = await signInWithPasskey(credential as SoftwareCredential);

    // The session hook's refusal, which the plugin reports as a failed authentication.
    expect(response.status).toBe(400);
    expect(browser.has('session_token')).toBe(false);
    expect(await sessionsOf()).toHaveLength(before);
  });

  it("stops with the directory that was a directory user's only way in", async () => {
    const { db, schema, signedInUser, register, signInWithPasskey } = await boot();
    const { user, jar } = await signedInUser('directory@example.com');
    const { credential } = await register(jar);
    // Now as a directory created them: no password, one account, the directory's.
    await db.update(schema.users).set({ passwordHash: null }).where(eq(schema.users.id, user.id));
    await db.delete(schema.accounts).where(eq(schema.accounts.userId, user.id));
    const stamp = new Date().toISOString();
    await db.insert(schema.oauthProviders).values({
      id: 'directory-1',
      name: 'Corp AD',
      type: 'ldap',
      clientId: '',
      clientSecret: '',
      createdAt: stamp,
      updatedAt: stamp,
    });
    await db.insert(schema.accounts).values({
      userId: user.id,
      providerId: 'directory-1',
      accountId: 'guid-1',
      createdAt: stamp,
      updatedAt: stamp,
    });

    const allowed = await signInWithPasskey(credential as SoftwareCredential);
    expect(allowed.response.status).toBe(200);

    await db
      .update(schema.oauthProviders)
      .set({ enabled: false })
      .where(eq(schema.oauthProviders.id, 'directory-1'));
    const refused = await signInWithPasskey(credential as SoftwareCredential, { counter: 2 });
    expect(refused.response.status).toBe(400);
    expect(refused.jar.has('session_token')).toBe(false);
  });

  it('is off, with registration, while sign-in is limited to single sign-on', async () => {
    const { call } = await boot({ AUTH_DISABLE_LOCAL_USERS: 'true' });

    const response = await call(new CookieJar(), 'GET', '/passkey/generate-authenticate-options');

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('PASSKEYS_DISABLED');
  });
});

describe('removing a passkey', () => {
  it('refuses the last way into an account, and allows it once there is another', async () => {
    const { db, schema, call, signedInUser, register, signInWithPasskey, passkeysOf } =
      await boot();
    const { user, jar } = await signedInUser('last-method@example.com');
    const { credential } = await register(jar);
    // A passkey-only account: no password, no provider.
    await db
      .delete(schema.accounts)
      .where(
        and(eq(schema.accounts.userId, user.id), eq(schema.accounts.providerId, 'credential')),
      );
    await db.update(schema.users).set({ passwordHash: null }).where(eq(schema.users.id, user.id));
    const { jar: browser } = await signInWithPasskey(credential as SoftwareCredential);
    const [only] = await passkeysOf(user.id);

    const refused = await call(browser, 'POST', '/passkey/delete-passkey', { id: String(only.id) });
    expect(refused.status).toBe(400);
    expect((await refused.json()).code).toBe('LAST_SIGN_IN_METHOD');
    expect(await passkeysOf(user.id)).toHaveLength(1);

    // The passkey sign-in is minutes old, so it may add a second one.
    const { verify } = await register(browser, { name: 'Phone' });
    expect(verify?.status).toBe(200);
    const removed = await call(browser, 'POST', '/passkey/delete-passkey', { id: String(only.id) });
    expect(removed.status).toBe(200);
    expect((await passkeysOf(user.id)).map((row) => row.name)).toEqual(['Phone']);
  });

  it('allows removing the only passkey of an account that keeps its password', async () => {
    const { call, signedInUser, register, passkeysOf } = await boot();
    const { user, jar } = await signedInUser('keeps-password@example.com');
    await register(jar);
    const [only] = await passkeysOf(user.id);

    const response = await call(jar, 'POST', '/passkey/delete-passkey', { id: String(only.id) });

    expect(response.status).toBe(200);
    expect(await passkeysOf(user.id)).toHaveLength(0);
  });
});
