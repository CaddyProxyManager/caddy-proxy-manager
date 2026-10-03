/**
 * Forward auth with Dex OIDC. Test domains do not resolve, so the browser stays on localhost:3000
 * and the callback goes through httpGet. Domain: func-fwd-oauth.test
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { httpGet, waitForStatus } from '../../helpers/http';
import { signInWithCredentials } from '../../helpers/sign-in';
import { waitForHydration } from '../../helpers/hydration';

const DOMAIN = 'func-fwd-oauth.test';
const ECHO_BODY = 'echo-ok';
const BASE_URL = 'http://localhost:3000';
const API = `${BASE_URL}/api/v1`;

// Must match tests/dex/config.yml.
const ALICE = { email: 'alice@test.local', username: 'alice', password: 'password' };
const BOB = { email: 'bob@test.local', username: 'bob', password: 'password' };

let proxyHostId: number;
let aliceUserId: number;
let bobUserId: number;
let testGroupId: number;

async function apiPost(page: Page, path: string, body: unknown) {
  return page.request.post(`${API}${path}`, {
    data: body,
    headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
  });
}

async function apiPut(page: Page, path: string, body: unknown) {
  return page.request.put(`${API}${path}`, {
    data: body,
    headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
  });
}

async function apiGet(page: Page, path: string) {
  return page.request.get(`${API}${path}`);
}

/** A no-op when an existing Dex session auto-redirects. */
async function dexLogin(page: Page, email: string, password: string) {
  try {
    await page.waitForURL((url) => url.toString().includes('localhost:5556'), { timeout: 15_000 });
  } catch {
    return;
  }

  // Dex may show a connector chooser first, or go straight to the form.
  const loginLink = page.getByRole('link', { name: /log in with email/i });
  if (await loginLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await loginLink.click();
  }

  if (!page.url().includes('localhost:5556')) return;

  await expect(page.getByRole('button', { name: /login/i })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('textbox', { name: /email/i }).fill(email);
  await page.getByRole('textbox', { name: /password/i }).fill(password);
  await page.getByRole('button', { name: /login/i }).click();
}

async function freshContext(page: Page): Promise<BrowserContext> {
  return page
    .context()
    .browser()!
    .newContext({ storageState: { cookies: [], origins: [] } });
}

/** One retry: Better Auth OAuth state can race between rapid logins. */
async function doOAuthLogin(page: Page, user: { email: string; password: string }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctx = await freshContext(page);
    const p = await ctx.newPage();
    try {
      await p.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
      const oauthButton = p.getByRole('button', { name: /continue with dex/i });
      await expect(oauthButton).toBeVisible({ timeout: 10_000 });
      await oauthButton.click();
      // Better Auth fetches, then sets window.location.href.
      try {
        await p.waitForURL(
          (url) => {
            const s = url.toString();
            return s.includes('localhost:5556') || !s.includes('localhost:3000/login');
          },
          { timeout: 15_000 },
        );
      } catch {
        if (attempt === 0) continue;
        throw new Error(`OAuth redirect failed for ${user.email}: stuck on ${p.url()}`);
      }
      await dexLogin(p, user.email, user.password);
      await p.waitForURL(
        (url) => {
          try {
            const u = new URL(url);
            return u.origin === BASE_URL && !u.pathname.startsWith('/api/auth');
          } catch {
            return false;
          }
        },
        { timeout: 30_000 },
      );

      const finalUrl = p.url();
      if (finalUrl.includes('error=') || finalUrl.includes('/login')) {
        if (attempt === 0) continue; // retry
        throw new Error(`OAuth login failed for ${user.email}: ${finalUrl}`);
      }
      return; // success
    } finally {
      await ctx.close();
    }
  }
}

/** The callback URL, from the intercepted session-login response: test domains don't resolve. */
async function oauthPortalLogin(
  page: Page,
  domain: string,
  user: { email: string; password: string },
): Promise<{ redirectTo: string | null; error: string | null }> {
  let capturedResponse: { redirectTo: string | null; error: string | null } | null = null;
  await page.route('**/api/forward-auth/session-login', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    capturedResponse = {
      redirectTo: json.redirectTo ?? null,
      error: json.error ?? null,
    };
    await route.fulfill({ response });
  });

  await page.goto(`${BASE_URL}/portal?rd=http://${domain}/`);
  const oauthButton = page.getByRole('button', { name: /continue with dex/i });
  await expect(oauthButton).toBeVisible({ timeout: 10_000 });
  await oauthButton.click();
  await dexLogin(page, user.email, user.password);

  // Back on the portal with ?rid=..., which auto-submits to session-login.
  const deadline = Date.now() + 25_000;
  while (!capturedResponse && Date.now() < deadline) {
    await page.waitForTimeout(500);
  }

  return capturedResponse ?? { redirectTo: null, error: 'timeout' };
}

/** Via httpGet, since the browser can't resolve the test domain. */
async function completeCallback(domain: string, callbackUrl: string): Promise<string> {
  const url = new URL(callbackUrl);
  const res = await httpGet(domain, url.pathname + url.search);
  expect(res.status).toBe(302);
  const setCookie = String(res.headers['set-cookie'] ?? '');
  expect(setCookie).toContain('_cpm_fa=');
  const match = setCookie.match(/_cpm_fa=([^;]+)/);
  expect(match).toBeTruthy();
  return match![1];
}

test.describe
  .serial('Forward Auth with OAuth (Dex)', () => {
    // ── Setup ──────────────────────────────────────────────────────────

    test('setup: wait for Dex to be ready', async () => {
      const deadline = Date.now() + 30_000;
      let ready = false;
      while (Date.now() < deadline) {
        try {
          const res = await fetch('http://localhost:5556/dex/.well-known/openid-configuration');
          if (res.ok) {
            ready = true;
            break;
          }
        } catch {
          /* not ready yet */
        }
        await new Promise((r) => setTimeout(r, 1_000));
      }
      expect(ready).toBe(true);
    });

    test('setup: create proxy host with forward auth via API', async ({ page }) => {
      const res = await apiPost(page, '/proxy-hosts', {
        name: 'OAuth Forward Auth Test',
        domains: [DOMAIN],
        upstreams: ['echo-server:8080'],
        sslForced: false,
        cpmForwardAuth: { enabled: true },
      });
      expect(res.status()).toBe(201);
      const host = await res.json();
      proxyHostId = host.id;
      expect(proxyHostId).toBeGreaterThan(0);
    });

    test('setup: trigger OAuth login for alice to create her user account', async ({ page }) => {
      await doOAuthLogin(page, ALICE);
    });

    test('setup: trigger OAuth login for bob to create his user account', async ({ page }) => {
      await doOAuthLogin(page, BOB);
    });

    test('setup: find alice and bob user IDs', async ({ page }) => {
      const res = await apiGet(page, '/users');
      expect(res.status()).toBe(200);
      const users: Array<{ id: number; email: string }> = await res.json();

      const alice = users.find((u) => u.email === ALICE.email);
      const bob = users.find((u) => u.email === BOB.email);
      expect(alice).toBeTruthy();
      expect(bob).toBeTruthy();
      aliceUserId = alice!.id;
      bobUserId = bob!.id;
    });

    test('setup: grant alice forward auth access (not bob)', async ({ page }) => {
      const res = await apiPut(page, `/proxy-hosts/${proxyHostId}/forward-auth-access`, {
        userIds: [aliceUserId],
        groupIds: [],
      });
      expect(res.status()).toBe(200);
    });

    test('setup: wait for Caddy to apply forward auth config', async () => {
      await waitForStatus(DOMAIN, 302, 20_000);
    });

    // ── Unauthenticated tests ─────────────────────────────────────────

    test('unauthenticated request redirects to portal with ?rd=', async () => {
      const res = await httpGet(DOMAIN, '/protected/page');
      expect(res.status).toBe(302);
      const location = String(res.headers.location);
      expect(location).toContain('/portal?rd=');
      expect(location).toContain(DOMAIN);
      expect(location).toContain('/protected/page');
    });

    test('forged session cookie gets redirected', async () => {
      const res = await httpGet(DOMAIN, '/', { Cookie: '_cpm_fa=forged-token' });
      expect(res.status).toBe(302);
      expect(String(res.headers.location)).toContain('/portal');
    });

    // ── User-based access control ─────────────────────────────────────

    test('alice (allowed user) can complete OAuth forward auth login', async ({ page }) => {
      const ctx = await freshContext(page);
      const p = await ctx.newPage();
      try {
        const result = await oauthPortalLogin(p, DOMAIN, ALICE);
        expect(result.error).toBeNull();
        expect(result.redirectTo).toBeTruthy();
        expect(result.redirectTo).toContain('/.cpm-auth/callback');

        const sessionCookie = await completeCallback(DOMAIN, result.redirectTo!);
        const upstreamRes = await httpGet(DOMAIN, '/', { Cookie: `_cpm_fa=${sessionCookie}` });
        expect(upstreamRes.status).toBe(200);
        expect(upstreamRes.body).toContain(ECHO_BODY);
      } finally {
        await ctx.close();
      }
    });

    test('bob (disallowed user) is denied access via OAuth forward auth', async ({ page }) => {
      const ctx = await freshContext(page);
      const p = await ctx.newPage();
      try {
        const result = await oauthPortalLogin(p, DOMAIN, BOB);
        expect(result.error).toBeTruthy();
        expect(result.redirectTo).toBeNull();
      } finally {
        await ctx.close();
      }
    });

    // ── Group-based access control ────────────────────────────────────

    test('setup: create a group and add bob to it', async ({ page }) => {
      const groupRes = await apiPost(page, '/groups', { name: 'OAuth Testers' });
      expect(groupRes.status()).toBe(201);
      const group = await groupRes.json();
      testGroupId = group.id;

      const memberRes = await apiPost(page, `/groups/${testGroupId}/members`, {
        userId: bobUserId,
      });
      expect(memberRes.status()).toBe(201);
    });

    test('setup: grant group-based forward auth access', async ({ page }) => {
      const res = await apiPut(page, `/proxy-hosts/${proxyHostId}/forward-auth-access`, {
        userIds: [aliceUserId],
        groupIds: [testGroupId],
      });
      expect(res.status()).toBe(200);
      const access = await res.json();
      expect(access.length).toBe(2);
    });

    test('bob (now in allowed group) can access via OAuth forward auth', async ({ page }) => {
      const ctx = await freshContext(page);
      const p = await ctx.newPage();
      try {
        const result = await oauthPortalLogin(p, DOMAIN, BOB);
        expect(result.error).toBeNull();
        expect(result.redirectTo).toBeTruthy();

        const sessionCookie = await completeCallback(DOMAIN, result.redirectTo!);
        const upstreamRes = await httpGet(DOMAIN, '/', { Cookie: `_cpm_fa=${sessionCookie}` });
        expect(upstreamRes.status).toBe(200);
        expect(upstreamRes.body).toContain(ECHO_BODY);
      } finally {
        await ctx.close();
      }
    });

    // ── Revoke access ─────────────────────────────────────────────────

    test('setup: revoke all access (both user and group)', async ({ page }) => {
      const res = await apiPut(page, `/proxy-hosts/${proxyHostId}/forward-auth-access`, {
        userIds: [],
        groupIds: [],
      });
      expect(res.status()).toBe(200);
      const access = await res.json();
      expect(access.length).toBe(0);
    });

    test('alice is denied after access revocation', async ({ page }) => {
      const ctx = await freshContext(page);
      const p = await ctx.newPage();
      try {
        const result = await oauthPortalLogin(p, DOMAIN, ALICE);
        expect(result.error).toBeTruthy();
        expect(result.redirectTo).toBeNull();
      } finally {
        await ctx.close();
      }
    });

    // ── Credential-based forward auth (coexisting with OAuth) ─────────

    test('setup: grant admin user direct access for credential login test', async ({ page }) => {
      const usersRes = await apiGet(page, '/users');
      const users: Array<{ id: number; email: string }> = await usersRes.json();
      const admin = users.find((u) => u.email === 'testadmin@localhost');
      expect(admin).toBeTruthy();

      const res = await apiPut(page, `/proxy-hosts/${proxyHostId}/forward-auth-access`, {
        userIds: [admin!.id],
        groupIds: [],
      });
      expect(res.status()).toBe(200);
    });

    test('admin can log in via credential form on portal', async ({ page }) => {
      const ctx = await freshContext(page);
      const p = await ctx.newPage();
      try {
        await p.goto(`${BASE_URL}/portal?rd=http://${DOMAIN}/`);
        await expect(p.getByLabel('Username')).toBeVisible({ timeout: 10_000 });
        await waitForHydration(p);

        let capturedRedirect: string | null = null;
        await p.route('**/api/forward-auth/login', async (route) => {
          const response = await route.fetch();
          const json = await response.json();
          capturedRedirect = json.redirectTo ?? null;
          await route.fulfill({ response });
        });

        await signInWithCredentials(p, 'testadmin', 'TestPassword2026!');

        const deadline = Date.now() + 15_000;
        while (!capturedRedirect && Date.now() < deadline) {
          await p.waitForTimeout(200);
        }

        expect(capturedRedirect).toBeTruthy();
        expect(capturedRedirect).toContain('/.cpm-auth/callback');

        const sessionCookie = await completeCallback(DOMAIN, capturedRedirect!);
        const upstreamRes = await httpGet(DOMAIN, '/', { Cookie: `_cpm_fa=${sessionCookie}` });
        expect(upstreamRes.status).toBe(200);
        expect(upstreamRes.body).toContain(ECHO_BODY);
      } finally {
        await ctx.close();
      }
    });
  });
