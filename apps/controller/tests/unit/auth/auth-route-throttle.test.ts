/**
 * Regression (H5): dashboard sign-in relied on better-auth's limiter alone, keyed on whatever single
 * X-Forwarded-For value the client sent, with no per-account counter.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { vi } from '@/tests/helpers/vi';
import { createTestDb } from '@/tests/helpers/db';
import { dbModuleMock } from '@/tests/helpers/db-module';

// Settings resolve through the database: its own, not the app's connection every file shares.
const testDb = await createTestDb();
vi.mock('@/src/lib/db', () => dbModuleMock(() => testDb));
import { testTranslator } from '@/tests/helpers/next-intl';

const ctx = vi.hoisted(() => ({
  seen: [] as Request[],
  status: 401,
  captcha: false,
}));

vi.mock('@/src/lib/auth/server', () => ({
  getAuth: async () => ({
    handler: async (request: Request) => {
      ctx.seen.push(request);
      return new Response(null, { status: ctx.status });
    },
  }),
}));

vi.mock('@/src/lib/captcha/settings', () => ({
  getActiveCaptcha: async () => (ctx.captcha ? { provider: 'turnstile', siteKey: 'site' } : null),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace?: string) => testTranslator(namespace),
}));

import { GET, POST } from '@/src/app/api/auth/[...all]/route';
import { CLIENT_IP_HEADER } from '@/src/lib/http/client-ip';
import { accountKey, resetAccountFailures } from '@/src/lib/auth/rate-limit';
import { users } from '@/src/lib/db/schema';
import { invalidateSettingsCache } from '@/src/lib/settings/resolve';
import { CAPTCHA_PASS_COOKIE, isValidCaptchaPass, issueCaptchaPass } from '@/src/lib/captcha/pass';

function signIn(
  body: Record<string, string>,
  headers: Record<string, string> = {},
  path = '/sign-in/username',
) {
  return POST(
    new Request(`http://localhost:3000/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  ctx.seen = [];
  ctx.status = 401;
  ctx.captcha = false;
  resetAccountFailures(accountKey('alice'));
});

describe('/api/auth route', () => {
  it('replaces a client-sent client-IP header before better-auth reads it', async () => {
    await GET(
      new Request('http://localhost:3000/api/auth/get-session', {
        headers: { [CLIENT_IP_HEADER]: '6.6.6.6', 'x-forwarded-for': '203.0.113.9' },
      }),
    );
    expect(ctx.seen[0]?.headers.get(CLIENT_IP_HEADER)).toBe('203.0.113.9');

    await GET(
      new Request('http://localhost:3000/api/auth/get-session', {
        headers: { [CLIENT_IP_HEADER]: '6.6.6.6' },
      }),
    );
    expect(ctx.seen[1]?.headers.has(CLIENT_IP_HEADER)).toBe(false);
  });

  it('passes the body through intact', async () => {
    await signIn({ username: 'alice', password: 'pw' });
    expect(await ctx.seen[0]?.json()).toEqual({ username: 'alice', password: 'pw' });
  });

  it('backs off an account after repeated failures, from any address', async () => {
    for (let i = 0; i < 6; i++) {
      const response = await signIn(
        { username: 'alice', password: `wrong-${i}` },
        { 'x-forwarded-for': `203.0.113.${i}` },
      );
      expect(response.status).toBe(401);
    }

    const blocked = await signIn(
      { username: 'ALICE', password: 'another' },
      { 'x-forwarded-for': '198.51.100.99' },
    );
    expect(blocked.status).toBe(429);
    expect(ctx.seen).toHaveLength(6);
    expect(blocked.headers.get('retry-after')).toBe('1');
    // Its own code, so the form says the account is locked rather than that it sent too much.
    expect(await blocked.json()).toEqual({
      code: 'ACCOUNT_LOCKED',
      message: 'Too many login attempts. Please try again later.',
      retryAfter: 1,
    });
  });

  it('counts a directory sign-in against the same account', async () => {
    for (let i = 0; i < 6; i++) {
      await signIn({ username: 'alice', password: `wrong-${i}` }, {}, '/sign-in/ldap');
    }
    expect((await signIn({ username: 'alice', password: 'pw' })).status).toBe(429);
  });

  // With no directory named, /sign-in/ldap tries the local password first: the one-directory login
  // form sends every password there, so its failures must reach auto-disable like a local one's.
  describe('auto-disable through the directory endpoint', () => {
    const ENV = { ACCOUNT_LOCK_DISABLE_ENABLED: 'true', ACCOUNT_LOCK_DISABLE_AFTER: '3' };

    async function aliceStatus(): Promise<string | undefined> {
      const [row] = await testDb.select().from(users).where(eq(users.username, 'alice'));
      return row?.status;
    }

    beforeEach(async () => {
      Object.assign(process.env, ENV);
      invalidateSettingsCache();
      await testDb.delete(users);
      const now = new Date().toISOString();
      await testDb.insert(users).values({
        id: 50,
        email: 'alice@example.com',
        username: 'alice',
        role: 'user',
        provider: 'credentials',
        subject: 'alice@example.com',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    });

    afterEach(() => {
      for (const name of Object.keys(ENV)) delete process.env[name];
      invalidateSettingsCache();
    });

    it('disables a local account guessed at with no directory named', async () => {
      for (let i = 0; i < 3; i++) {
        await signIn({ username: 'alice', password: `wrong-${i}` }, {}, '/sign-in/ldap');
      }
      expect(await aliceStatus()).toBe('disabled');
    });

    it('leaves it alone when the guesses name a directory, which never tried it', async () => {
      for (let i = 0; i < 3; i++) {
        await signIn(
          { username: 'alice', password: `wrong-${i}`, directoryId: 'corp' },
          {},
          '/sign-in/ldap',
        );
      }
      expect(await aliceStatus()).toBe('active');
    });
  });

  it('resets the account on a successful sign-in', async () => {
    for (let i = 0; i < 5; i++) await signIn({ username: 'alice', password: 'wrong' });
    ctx.status = 200;
    await signIn({ username: 'alice', password: 'right' });
    ctx.status = 401;
    expect((await signIn({ username: 'alice', password: 'wrong' })).status).toBe(401);
    expect((await signIn({ username: 'alice', password: 'wrong' })).status).toBe(401);
  });

  it('points better-auth at the header this route sets', () => {
    const source = readFileSync(`${import.meta.dir}/../../../src/lib/auth/server.ts`, 'utf8');
    expect(source).toContain(`ipAddressHeaders: ["${CLIENT_IP_HEADER}"]`);
  });

  describe('with a CAPTCHA configured', () => {
    beforeEach(() => {
      ctx.captcha = true;
    });

    const passFor = (name: string) => ({
      cookie: `${CAPTCHA_PASS_COOKIE}=${issueCaptchaPass(name)}`,
    });

    it('refuses a sign-in with no pass before it reaches better-auth', async () => {
      const response = await signIn({ username: 'alice', password: 'pw' });
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('CAPTCHA_REQUIRED');
      expect(ctx.seen).toHaveLength(0);
    });

    it('refuses a sign-in that names no one, even with the pass a blank name would map to', async () => {
      // accountKey("") is "@localhost", the key of the username "@localhost".
      const response = await signIn({ password: 'pw' }, passFor('@localhost'));
      expect(response.status).toBe(403);
      expect(ctx.seen).toHaveLength(0);
    });

    it("refuses another name's pass", async () => {
      const response = await signIn({ username: 'alice', password: 'pw' }, passFor('bob'));
      expect(response.status).toBe(403);
      expect(ctx.seen).toHaveLength(0);
    });

    it('spends the pass on a wrong password, so replaying it gets nowhere', async () => {
      const pass = passFor('alice');
      const first = await signIn({ username: 'alice', password: 'wrong' }, pass);
      expect(first.status).toBe(401);
      expect(first.headers.get('set-cookie')).toContain(`${CAPTCHA_PASS_COOKIE}=;`);

      // A script ignores Set-Cookie and sends the same pass again.
      const replay = await signIn({ username: 'alice', password: 'guess-2' }, pass);
      expect(replay.status).toBe(403);
      expect(ctx.seen).toHaveLength(1);
    });

    it('does not spend the pass on an attempt the account throttle refuses', async () => {
      ctx.captcha = false;
      for (let i = 0; i < 6; i++) await signIn({ username: 'alice', password: 'wrong' });
      ctx.captcha = true;
      const pass = issueCaptchaPass('alice');
      const throttled = await signIn(
        { username: 'alice', password: 'right' },
        { cookie: `${CAPTCHA_PASS_COOKIE}=${pass}` },
      );
      expect(throttled.status).toBe(429);
      expect(isValidCaptchaPass(pass, 'alice')).toBe(true);
    });

    it('spends the pass on a successful sign-in', async () => {
      ctx.status = 200;
      const response = await signIn({ username: 'alice', password: 'right' }, passFor('alice'));
      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toContain(`${CAPTCHA_PASS_COOKIE}=;`);
      expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    });

    it('demands a pass for a directory sign-in too', async () => {
      const response = await signIn({ username: 'alice', password: 'pw' }, {}, '/sign-in/ldap');
      expect(response.status).toBe(403);
      expect(ctx.seen).toHaveLength(0);
    });

    it('leaves every other auth route alone', async () => {
      await GET(new Request('http://localhost:3000/api/auth/get-session'));
      expect(ctx.seen).toHaveLength(1);
    });
  });
});
