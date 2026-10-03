/**
 * The sign-in CAPTCHA on the forward-auth portal: enforced by the login route unless the host the
 * sign-in is for has switched it off, and that switch surviving the host model's round trips.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { NextRequest } from 'next/server';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const { testTranslator } = await import('../helpers/next-intl');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace?: string) => testTranslator(namespace),
}));

import * as schema from '../../src/lib/db/schema';
import { POST as login } from '../../src/app/api/forward-auth/login/route';
import {
  createRedirectIntent,
  redirectIntentWantsCaptcha,
} from '../../src/lib/models/forward-auth';
import { CAPTCHA_PASS_COOKIE, issueCaptchaPass } from '../../src/lib/captcha/pass';
import { DEFAULT_CAPTCHA_SETTINGS, saveCaptchaSettings } from '../../src/lib/captcha/settings';
import { hashPassword } from '../../src/lib/password';
import { accountKey, resetAccountFailures } from '../../src/lib/rate-limit';
import { createProxyHost, getProxyHost, updateProxyHost } from '../../src/lib/models/proxy-hosts';

const PASSWORD = 'correct horse battery staple';
const TARGET = 'https://app.example.com/dashboard';
let ipCounter = 0;

async function setup(cpmForwardAuth: Record<string, unknown> = { enabled: true }) {
  const timestamp = new Date().toISOString();
  const [user] = await ctx.db
    .insert(schema.users)
    .values({
      email: 'alice@localhost',
      name: 'Alice',
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
      meta: JSON.stringify({ cpm_forward_auth: cpmForwardAuth }),
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

function attempt(rid: string, cookie?: string, password = PASSWORD) {
  return login(
    new NextRequest('http://localhost:3000/api/forward-auth/login', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:3000',
        'content-type': 'application/json',
        'x-forwarded-for': `203.0.113.${++ipCounter % 250}`,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ username: 'alice', password, rid }),
    }),
  );
}

const passCookie = (name: string) => `${CAPTCHA_PASS_COOKIE}=${issueCaptchaPass(name)}`;

beforeEach(async () => {
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.users);
  resetAccountFailures(accountKey('alice'));
  await saveCaptchaSettings({
    provider: 'turnstile',
    siteKey: 'site',
    secretKey: 'secret',
    capInstanceUrl: '',
  });
});

describe('portal sign-in with a CAPTCHA configured', () => {
  it('refuses a sign-in with no pass', async () => {
    await setup();
    const rid = await createRedirectIntent(TARGET);
    const response = await attempt(rid);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe('CAPTCHA_REQUIRED');
  });

  it("refuses another name's pass", async () => {
    await setup();
    const rid = await createRedirectIntent(TARGET);
    expect((await attempt(rid, passCookie('bob'))).status).toBe(403);
  });

  it('lets a pass through, and spends it', async () => {
    await setup();
    const rid = await createRedirectIntent(TARGET);
    const response = await attempt(rid, passCookie('alice'));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain(`${CAPTCHA_PASS_COOKIE}=;`);
  });

  it('spends the pass on a wrong password too', async () => {
    await setup();
    const rid = await createRedirectIntent(TARGET);
    const cookie = passCookie('alice');
    const wrong = await attempt(rid, cookie, 'wrong');
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toContain(`${CAPTCHA_PASS_COOKIE}=;`);
    // Replayed with the right password, the spent pass is refused before the password is read.
    expect((await attempt(rid, cookie)).status).toBe(403);
  });

  it('asks nothing for a host that switched it off', async () => {
    await setup({ enabled: true, require_captcha: false });
    const rid = await createRedirectIntent(TARGET);
    expect(await redirectIntentWantsCaptcha(rid)).toBe(false);
    expect((await attempt(rid)).status).toBe(200);
  });

  it('asks nothing while no CAPTCHA is configured', async () => {
    await saveCaptchaSettings(DEFAULT_CAPTCHA_SETTINGS);
    await setup();
    const rid = await createRedirectIntent(TARGET);
    expect((await attempt(rid)).status).toBe(200);
  });

  it('fails closed for an intent it cannot find', async () => {
    expect(await redirectIntentWantsCaptcha('f'.repeat(32))).toBe(true);
  });
});

describe('the per-host switch', () => {
  it('defaults on, and survives an update that does not mention it', async () => {
    const { user } = await setup();
    const created = await createProxyHost(
      {
        name: 'app',
        domains: ['switch.example.com'],
        upstreams: ['backend:8080'],
        cpmForwardAuth: { enabled: true },
      } as never,
      user.id,
    );
    expect((await getProxyHost(created.id))?.cpmForwardAuth?.require_captcha).toBe(true);

    await updateProxyHost(
      created.id,
      { cpmForwardAuth: { enabled: true, require_captcha: false } },
      user.id,
    );
    expect((await getProxyHost(created.id))?.cpmForwardAuth?.require_captcha).toBe(false);

    await updateProxyHost(
      created.id,
      { cpmForwardAuth: { enabled: true, protected_paths: ['/admin/*'] } },
      user.id,
    );
    const host = await getProxyHost(created.id);
    expect(host?.cpmForwardAuth?.require_captcha).toBe(false);
    expect(host?.cpmForwardAuth?.protected_paths).toEqual(['/admin/*']);

    await updateProxyHost(
      created.id,
      { cpmForwardAuth: { enabled: true, require_captcha: true } },
      user.id,
    );
    expect((await getProxyHost(created.id))?.cpmForwardAuth?.require_captcha).toBe(true);
  });
});
