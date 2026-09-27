/**
 * Regressions for the forward-auth login surface:
 * - H5: the password was checked before the redirect intent, so 401 vs 400 answered "is this the
 *   password?" without a live intent, and nothing limited guesses per account.
 * - L10: every portal GET inserted an intent row and ran a DELETE sweep, uncapped.
 * - L11: identity headers were raw names, so "admins,ops" split in two and non-Latin-1 threw.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { NextRequest } from 'next/server';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

// bun evaluates a vi.mock factory synchronously while linking, so the helpers it needs are
// imported above it rather than awaited inside it.
const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');
const { testTranslator } = await import('../helpers/next-intl');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => ({
  default: ctx.db,
  sqlite: undefined,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null => {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  },
}));

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace?: string) => testTranslator(namespace),
}));

import * as schema from '../../src/lib/db/schema';
import { POST as login } from '../../src/app/api/forward-auth/login/route';
import { GET as verify } from '../../src/app/api/forward-auth/verify/route';
import {
  MAX_REDIRECT_INTENTS_PER_WINDOW,
  REDIRECT_INTENT_WINDOW_KEY,
  createForwardAuthSession,
  createRedirectIntent,
  resolveForwardAuthAudience,
} from '../../src/lib/models/forward-auth';
import {
  FORWARD_AUTH_PROXY_HOST_ID_HEADER,
  FORWARD_AUTH_PROXY_PROOF_HEADER,
  getForwardAuthProxyProof,
} from '../../src/lib/forward-auth-trust';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../../src/lib/password';
import {
  accountKey,
  resetAccountFailures,
  resetWindow,
  takeFromWindow,
} from '../../src/lib/rate-limit';

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

  it('accepts the portal served from the stored Public URL, and still refuses anywhere else', async () => {
    await setup();
    const { baseUrl } = await import('../../src/lib/settings/registry');
    const { clearStoredSetting, saveSettings } = await import('../../src/lib/settings/resolve');
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
    expect((await attempt(PASSWORD, rid, '198.51.100.200')).status).toBe(429);
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
