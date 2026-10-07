/**
 * Regressions for the forward-auth login surface:
 * - H5: the password was checked before the redirect intent, so 401 vs 400 answered "is this the
 *   password?" without a live intent, and nothing limited guesses per account.
 * - L10: every portal GET inserted an intent row and ran a DELETE sweep, uncapped.
 * - L11: identity headers were raw names, so "admins,ops" split in two and non-Latin-1 threw.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { NextRequest } from 'next/server';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

// bun evaluates a vi.mock factory synchronously while linking, so the helpers it needs are
// imported above it rather than awaited inside it.
const { createTestDb } = await import('../../helpers/db');
const { testTranslator } = await import('../../helpers/next-intl');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace?: string) => testTranslator(namespace),
}));

import * as schema from '../../../src/lib/db/schema';
import { POST as login } from '../../../src/app/api/forward-auth/login/route';
import { GET as verify } from '../../../src/app/api/forward-auth/verify/route';
import {
  MAX_REDIRECT_INTENTS_PER_WINDOW,
  REDIRECT_INTENT_WINDOW_KEY,
  createForwardAuthSession,
  createRedirectIntent,
  resolveForwardAuthAudience,
} from '../../../src/lib/models/forward-auth';
import {
  FORWARD_AUTH_PROXY_HOST_ID_HEADER,
  FORWARD_AUTH_PROXY_PROOF_HEADER,
  getForwardAuthProxyProof,
} from '../../../src/lib/forward-auth/trust';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../../../src/lib/auth/password';
import {
  accountKey,
  resetAccountFailures,
  resetWindow,
  takeFromWindow,
} from '../../../src/lib/auth/rate-limit';

const PASSWORD = 'correct horse battery staple';
const TARGET = 'https://app.example.com/dashboard';
const now = () => new Date().toISOString();
let ipCounter = 0;

async function setup(name = 'Alice') {
  const timestamp = now();
  const [user] = await ctx.db
    .insert(schema.users)
    .values({
      email: 'alice@localhost',
      name,
      role: 'user',
      provider: 'credentials',
      subject: 'alice',
      status: 'active',
      passwordHash: await hashPassword(PASSWORD),
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning();
  const [host] = await ctx.db
    .insert(schema.proxyHosts)
    .values({
      name: 'App',
      domains: JSON.stringify(['app.example.com']),
      upstreams: JSON.stringify(['backend:8080']),
      sslForced: true,
      hstsEnabled: true,
      hstsSubdomains: false,
      allowWebsocket: true,
      preserveHostHeader: true,
      skipHttpsHostnameValidation: false,
      enabled: true,
      meta: JSON.stringify({ cpm_forward_auth: { enabled: true } }),
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning();
  await ctx.db.insert(schema.forwardAuthAccess).values({
    proxyHostId: host.id,
    userId: user.id,
    groupId: null,
    createdAt: timestamp,
  });
  return { user, host };
}

function attempt(
  password: string,
  rid: string,
  ip = `203.0.113.${++ipCounter % 250}`,
  origin = 'http://localhost:3000',
) {
  return login(
    new NextRequest('http://localhost:3000/api/forward-auth/login', {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-forwarded-for': ip,
      },
      body: JSON.stringify({ username: 'alice', password, rid }),
    }),
  );
}

async function intentCount() {
  return (await ctx.db.select().from(schema.forwardAuthRedirectIntents)).length;
}

beforeEach(async () => {
  await ctx.db.delete(schema.groups);
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.users);
  resetAccountFailures(accountKey('alice'));
  resetWindow(REDIRECT_INTENT_WINDOW_KEY);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('forward-auth login', () => {
  it('answers a request without a live intent the same whether the password is right or not', async () => {
    await setup();
    const wrong = await attempt('wrong', 'f'.repeat(32));
    const right = await attempt(PASSWORD, 'f'.repeat(32));

    expect(wrong.status).toBe(400);
    expect(right.status).toBe(400);
    expect(await right.json()).toEqual(await wrong.json());
  });

  it('does not burn the intent on a mistyped password', async () => {
    await setup();
    const rid = await createRedirectIntent(TARGET);

    expect((await attempt('wrong', rid)).status).toBe(401);
    const response = await attempt(PASSWORD, rid);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { redirectTo: string }).redirectTo).toStartWith(
      'https://app.example.com/.cpm-auth/callback?code=',
    );
  });

  it('takes a local password only from a break-glass account while single sign-on is enforced', async () => {
    const { user } = await setup();
    const { setSetting } = await import('../../../src/lib/settings');
    await setSetting('sso_enforcement', { enforced: true, breakGlassUserIds: [], allowLdap: true });
    try {
      const refused = await attempt(PASSWORD, await createRedirectIntent(TARGET));
      expect(refused.status).toBe(401);
      await setSetting('sso_enforcement', {
        enforced: true,
        breakGlassUserIds: [user.id],
        allowLdap: true,
      });
      expect((await attempt(PASSWORD, await createRedirectIntent(TARGET))).status).toBe(200);
    } finally {
      await ctx.db.delete(schema.settings).where(eq(schema.settings.key, 'sso_enforcement'));
    }
  });

  it('accepts the portal served from the stored Public URL, and still refuses anywhere else', async () => {
    await setup();
    const { baseUrl } = await import('../../../src/lib/settings/registry');
    const { clearStoredSetting, saveSettings } = await import('../../../src/lib/settings/resolve');
    await saveSettings({ [baseUrl.key]: 'https://proxy.example.com' });
    try {
      const rid = await createRedirectIntent(TARGET);
      expect((await attempt(PASSWORD, rid, undefined, 'https://attacker.example')).status).toBe(
        403,
      );
      expect((await attempt(PASSWORD, rid, undefined, 'https://proxy.example.com')).status).toBe(
        200,
      );
    } finally {
      await clearStoredSetting(baseUrl.key);
    }
  });

  it('backs off the account however many addresses the guesses come from', async () => {
    await setup();
    const rid = await createRedirectIntent(TARGET);

    for (let i = 0; i < 6; i++) {
      expect((await attempt(`wrong-${i}`, rid)).status).toBe(401);
    }
    // Even the right password waits out the delay, from an address never seen before.
    const locked = await attempt(PASSWORD, rid, '198.51.100.200');
    expect(locked.status).toBe(429);
    // Told apart from a throttled address, with the wait, so the form can say how long.
    expect(await locked.json()).toEqual({
      error: 'Too many login attempts. Please try again later.',
      code: 'ACCOUNT_LOCKED',
      retryAfter: 1,
    });
    expect(locked.headers.get('retry-after')).toBe('1');
  });
});

describe('forward-auth login limits and uniform rejection', () => {
  let hostId = 0;

  /** A user who may reach the host, keyed by a name no other test uses. */
  async function addUser(
    username: string,
    overrides: Partial<typeof schema.users.$inferInsert> = {},
  ) {
    const timestamp = now();
    const [user] = await ctx.db
      .insert(schema.users)
      .values({
        email: `${username}@localhost`,
        name: username,
        role: 'user',
        provider: 'credentials',
        subject: username,
        status: 'active',
        passwordHash: await hashPassword(PASSWORD),
        createdAt: timestamp,
        updatedAt: timestamp,
        ...overrides,
      })
      .returning();
    await ctx.db.insert(schema.forwardAuthAccess).values({
      proxyHostId: hostId,
      userId: user.id,
      groupId: null,
      createdAt: timestamp,
    });
    return user;
  }

  function post(body: unknown, headers: Record<string, string> = {}, raw?: BodyInit) {
    return login(
      new NextRequest('http://localhost:3000/api/forward-auth/login', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          'content-type': 'application/json',
          'x-forwarded-for': `203.0.113.${++ipCounter % 250}`,
          ...headers,
        },
        body: raw ?? JSON.stringify(body),
        // Node's fetch refuses a stream body without it.
        ...(raw ? { duplex: 'half' } : {}),
      } as ConstructorParameters<typeof NextRequest>[1]),
    );
  }

  async function signIn(username: string, password: string, ip?: string) {
    const rid = await createRedirectIntent(TARGET);
    return post({ username, password, rid }, ip ? { 'x-forwarded-for': ip } : {});
  }

  beforeEach(async () => {
    ({
      host: { id: hostId },
    } = await setup());
  });

  it('rejects unknown users and wrong passwords the same way', async () => {
    await addUser('bob');
    const unknown = await signIn('nobody', PASSWORD);
    const wrong = await signIn('bob', 'wrong');
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
    expect((await signIn('bob', PASSWORD)).status).toBe(200);
  });

  it('runs exactly one password verify for unknown, inactive and password-less users', async () => {
    await addUser('dave', { status: 'disabled' });
    await addUser('erin', { passwordHash: null, provider: 'oidc' });
    const verifySpy = vi.spyOn(Bun.password, 'verify');
    try {
      for (const username of ['nobody', 'dave', 'erin']) {
        verifySpy.mockClear();
        expect((await signIn(username, PASSWORD)).status).toBe(401);
        expect(verifySpy).toHaveBeenCalledTimes(1);
        // The algorithm real accounts use, so the rejection takes as long.
        expect(String(verifySpy.mock.calls[0][1])).toStartWith('$argon2id$');
      }
    } finally {
      verifySpy.mockRestore();
    }
  });

  it('refuses usernames over 256 characters before any credential work', async () => {
    const verifySpy = vi.spyOn(Bun.password, 'verify');
    try {
      const res = await signIn('a'.repeat(257), PASSWORD);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Username is too long' });
      expect(verifySpy).not.toHaveBeenCalled();
    } finally {
      verifySpy.mockRestore();
    }
    // 256 characters is still an ordinary, failed login.
    expect((await signIn('a'.repeat(256), 'nope')).status).toBe(401);
  });

  it('refuses oversized bodies whether or not Content-Length is declared', async () => {
    await addUser('frank');
    const rid = await createRedirectIntent(TARGET);
    const oversized = {
      username: 'frank',
      password: PASSWORD,
      rid,
      padding: 'x'.repeat(20 * 1024),
    };

    const declared = await post(oversized, { 'content-length': String(20 * 1024 + 80) });
    expect(declared.status).toBe(413);

    const text = new TextEncoder().encode(JSON.stringify(oversized));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < text.length; i += 4096) controller.enqueue(text.slice(i, i + 4096));
        controller.close();
      },
    });
    expect((await post(undefined, {}, stream)).status).toBe(413);

    expect((await post('not json', {}, 'not json')).status).toBe(400);

    // The intent was not spent, and a normal-sized body still works.
    expect((await post({ username: 'frank', password: PASSWORD, rid })).status).toBe(200);
  });

  it('limits one client per account even after it signs in to its own account', async () => {
    await addUser('heidi');
    await addUser('mallory');
    const ip = '192.0.2.10';
    for (let i = 0; i < 4; i++) {
      expect((await signIn('heidi', `wrong-${i}`, ip)).status).toBe(401);
    }
    // Signing in clears the client's own counter...
    expect((await signIn('mallory', PASSWORD, ip)).status).toBe(200);
    // ...but not its failures against heidi: the fifth one blocks that pair.
    expect((await signIn('heidi', 'wrong-4', ip)).status).toBe(401);
    const throttled = await signIn('heidi', PASSWORD, ip);
    expect(throttled.status).toBe(429);
    // A throttled client, not a locked account: the generic refusal.
    expect((await throttled.json()).code).toBeUndefined();

    // The client can still use its own account, and heidi can sign in elsewhere.
    expect((await signIn('mallory', PASSWORD, ip)).status).toBe(200);
    expect((await signIn('heidi', PASSWORD, '198.51.100.201')).status).toBe(200);
  });

  it('counts concurrent attempts from one client against its limit', async () => {
    await addUser('kate');
    const ip = '192.0.2.20';
    const rids = await Promise.all(Array.from({ length: 12 }, () => createRedirectIntent(TARGET)));
    const responses = await Promise.all(
      rids.map((rid, i) =>
        post({ username: 'kate', password: `wrong-${i}`, rid }, { 'x-forwarded-for': ip }),
      ),
    );
    const statuses = responses.map((res) => res.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
    expect((await signIn('kate', PASSWORD, ip)).status).toBe(429);
  });

  it('gives a burst from many clients no more guesses at an account than sequential ones', async () => {
    await addUser('leo');
    const rid = await createRedirectIntent(TARGET);
    const responses = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        post(
          { username: 'leo', password: `wrong-${i}`, rid },
          { 'x-forwarded-for': `10.3.0.${i}` },
        ),
      ),
    );
    const failures = responses.filter((res) => res.status === 401).length;
    // Five free failures, then one more before the first delay: what a sequential run gets.
    expect(failures).toBeGreaterThanOrEqual(5);
    expect(failures).toBeLessThanOrEqual(6);
    expect(responses.every((res) => res.status === 401 || res.status === 429)).toBe(true);
  });

  it('keeps the audit summary short whatever the username', async () => {
    const { logAuditEvent } = await import('../../../src/lib/audit');
    vi.mocked(logAuditEvent).mockClear();
    expect((await signIn('z'.repeat(200), 'nope')).status).toBe(401);
    const [[event]] = vi.mocked(logAuditEvent).mock.calls as unknown as [[{ summary: string }]];
    expect(event.summary).toEndWith(`: ${'z'.repeat(64)}`);
  });
});

describe('forward-auth verify identity headers', () => {
  it('encodes names the Headers constructor would reject, and commas inside group names', async () => {
    const { user, host } = await setup();
    // Not something sign-up accepts, but an OAuth-created or legacy row can hold anything.
    await ctx.db
      .update(schema.users)
      .set({ username: 'Zoë 李' })
      .where(eq(schema.users.id, user.id));
    const timestamp = now();
    const [group] = await ctx.db
      .insert(schema.groups)
      .values({ name: 'admins,ops', createdAt: timestamp, updatedAt: timestamp })
      .returning();
    await ctx.db
      .insert(schema.groupMembers)
      .values({ groupId: group.id, userId: user.id, createdAt: timestamp });

    const audience = await resolveForwardAuthAudience('https://app.example.com');
    const { rawToken } = await createForwardAuthSession(user.id, audience!);

    const response = await verify(
      new NextRequest('http://localhost/api/forward-auth/verify', {
        headers: {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'app.example.com',
          [FORWARD_AUTH_PROXY_PROOF_HEADER]: getForwardAuthProxyProof(),
          [FORWARD_AUTH_PROXY_HOST_ID_HEADER]: String(host.id),
          cookie: `_cpm_fa=${rawToken}`,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('X-CPM-User')).toBe('Zo%C3%AB %E6%9D%8E');
    expect(response.headers.get('X-CPM-Groups')).toBe('admins%2Cops');
    expect(response.headers.get('X-CPM-Email')).toBe('alice@localhost');
  });
});

describe('redirect intent creation', () => {
  it('sweeps expired intents at most once per interval', async () => {
    const { host } = await setup();
    const base = Date.now() + 24 * 60 * 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    await createRedirectIntent(TARGET);

    const insertExpired = (ridHash: string) =>
      ctx.db.insert(schema.forwardAuthRedirectIntents).values({
        ridHash,
        proxyHostId: host.id,
        audienceOrigin: 'https://app.example.com',
        redirectUri: TARGET,
        expiresAt: new Date(Date.UTC(2000, 0, 1)).toISOString(),
        consumed: false,
        createdAt: new Date(Date.UTC(2000, 0, 1)).toISOString(),
      });

    await insertExpired('expired-1');
    clock.mockReturnValue(base + 1_000);
    await createRedirectIntent(TARGET);
    expect(await intentCount()).toBe(3);

    clock.mockReturnValue(base + 61_000);
    await createRedirectIntent(TARGET);
    expect(await intentCount()).toBe(3);
  });

  it('refuses once the global budget is spent, without writing a row', async () => {
    await setup();
    for (let i = 0; i < MAX_REDIRECT_INTENTS_PER_WINDOW; i++) {
      takeFromWindow(REDIRECT_INTENT_WINDOW_KEY, MAX_REDIRECT_INTENTS_PER_WINDOW, 10 * 60_000);
    }
    await expect(createRedirectIntent(TARGET)).rejects.toMatchObject({
      code: 'tooManyRedirectIntents',
    });
    expect(await intentCount()).toBe(0);
  });
});
