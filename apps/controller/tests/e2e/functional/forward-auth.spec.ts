/**
 * Functional: CPM Forward Auth (credential login) - unauthenticated requests redirect to the portal
 * with ?rd=, non-forward-auth domains are rejected, a successful login completes the redirect, the
 * _cpm_fa cookie reaches the upstream, an invalid one redirects again. Domain: func-fwd-auth.test
 */
import { test, expect } from '@playwright/test';
import { httpGet, waitForStatus } from '../../helpers/http';
import { signInWithCredentials } from '../../helpers/sign-in';
import { waitForHydration } from '../../helpers/hydration';

const DOMAIN = 'func-fwd-auth.test';
const ECHO_BODY = 'echo-ok';
const BASE_URL = 'http://localhost:3000';
const API = `${BASE_URL}/api/v1`;

let proxyHostId: number;

test.describe
  .serial('Forward auth', () => {
    test('setup: create proxy host with forward auth via API', async ({ page }) => {
      const res = await page.request.post(`${API}/proxy-hosts`, {
        data: {
          name: 'Functional Forward Auth Test',
          domains: [DOMAIN],
          upstreams: ['echo-server:8080'],
          sslForced: false,
          cpmForwardAuth: { enabled: true },
        },
        headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
      });
      expect(res.status()).toBe(201);
      const host = await res.json();
      proxyHostId = host.id;

      const accessRes = await page.request.put(
        `${API}/proxy-hosts/${proxyHostId}/forward-auth-access`,
        {
          data: { userIds: [1], groupIds: [] },
          headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
        },
      );
      expect(accessRes.status()).toBe(200);

      await waitForStatus(DOMAIN, 302, 20_000);
    });

    test('unauthenticated request redirects to portal with ?rd= param', async () => {
      const res = await httpGet(DOMAIN, '/some/page');
      expect(res.status).toBe(302);
      const location = res.headers.location;
      expect(String(location)).toContain('/portal?rd=');
      expect(String(location)).toContain(DOMAIN);
    });

    test('redirect preserves the original request path in ?rd=', async () => {
      const res = await httpGet(DOMAIN, '/deep/path?q=hello');
      expect(res.status).toBe(302);
      const location = String(res.headers.location);
      expect(location).toContain('/deep/path');
      expect(location).toContain('q=hello');
    });

    test('portal shows login form when ?rd= points to forward auth domain', async ({ page }) => {
      // Use fresh context - admin session triggers auto-redirect on the portal
      const ctx = await page
        .context()
        .browser()!
        .newContext({ storageState: { cookies: [], origins: [] } });
      const p = await ctx.newPage();
      try {
        const response = await p.goto(`${BASE_URL}/portal?rd=http://${DOMAIN}/`);
        expect(response?.status()).toBeLessThan(500);
        await p.waitForLoadState('networkidle');
        // Step one of identifier-first sign-in: the password is only asked for after Continue.
        await expect(p.getByLabel('Username')).toBeVisible({ timeout: 10_000 });
        await expect(p.getByRole('button', { name: /^continue$/i })).toBeVisible();
      } finally {
        await ctx.close();
      }
    });

    test('portal shows target domain when ?rd= is valid', async ({ page }) => {
      const ctx = await page
        .context()
        .browser()!
        .newContext({ storageState: { cookies: [], origins: [] } });
      const p = await ctx.newPage();
      try {
        await p.goto(`${BASE_URL}/portal?rd=http://${DOMAIN}/`);
        await expect(p.getByText(DOMAIN)).toBeVisible();
      } finally {
        await ctx.close();
      }
    });

    test('portal rejects ?rd= for non-forward-auth domains', async ({ page }) => {
      const ctx = await page
        .context()
        .browser()!
        .newContext({ storageState: { cookies: [], origins: [] } });
      const p = await ctx.newPage();
      try {
        await p.goto(`${BASE_URL}/portal?rd=http://not-a-real-domain.test/`);
        // A non-forward-auth domain gets the generic form and no rid.
        await expect(p.getByText('Sign in to continue')).toBeVisible();
      } finally {
        await ctx.close();
      }
    });

    test('portal rejects empty ?rd= parameter', async ({ page }) => {
      const ctx = await page
        .context()
        .browser()!
        .newContext({ storageState: { cookies: [], origins: [] } });
      const p = await ctx.newPage();
      try {
        await p.goto(`${BASE_URL}/portal`);
        await expect(p.getByText('No redirect destination specified.')).toBeVisible();
      } finally {
        await ctx.close();
      }
    });

    test('credential login completes the redirect flow', async ({ page }) => {
      const context = await page
        .context()
        .browser()!
        .newContext({ storageState: { cookies: [], origins: [] } });
      const freshPage = await context.newPage();

      try {
        await freshPage.goto(`${BASE_URL}/portal?rd=http://${DOMAIN}/test-path`);
        await expect(freshPage.getByLabel('Username')).toBeVisible({ timeout: 10_000 });
        await waitForHydration(freshPage);

        // Intercept the login API response before the page navigates away
        let capturedRedirect: string | null = null;
        await freshPage.route('**/api/forward-auth/login', async (route) => {
          const response = await route.fetch();
          const json = await response.json();
          capturedRedirect = json.redirectTo ?? null;
          await route.fulfill({ response });
        });

        await signInWithCredentials(freshPage, 'testadmin', 'TestPassword2026!');

        const deadline = Date.now() + 15_000;
        while (!capturedRedirect && Date.now() < deadline) {
          await freshPage.waitForTimeout(200);
        }

        expect(capturedRedirect).toBeTruthy();
        expect(capturedRedirect).toContain('/.cpm-auth/callback');
        expect(capturedRedirect).toContain('code=');
        const data = { redirectTo: capturedRedirect! };

        const callbackUrl = new URL(data.redirectTo);
        const callbackRes = await httpGet(DOMAIN, callbackUrl.pathname + callbackUrl.search);
        expect(callbackRes.status).toBe(302);
        const setCookie = String(callbackRes.headers['set-cookie'] ?? '');
        expect(setCookie).toContain('_cpm_fa=');

        const match = setCookie.match(/_cpm_fa=([^;]+)/);
        expect(match).toBeTruthy();
        const sessionCookie = match![1];
        const upstreamRes = await httpGet(DOMAIN, '/test-path', {
          Cookie: `_cpm_fa=${sessionCookie}`,
        });
        expect(upstreamRes.status).toBe(200);
        expect(upstreamRes.body).toContain(ECHO_BODY);
      } finally {
        await context.close();
      }
    });

    test('request with invalid _cpm_fa cookie gets redirected', async () => {
      const res = await httpGet(DOMAIN, '/', {
        Cookie: '_cpm_fa=invalid-token-value',
      });
      expect(res.status).toBe(302);
      expect(String(res.headers.location)).toContain('/portal');
    });

    test('request with forged _cpm_fa cookie gets redirected', async () => {
      const forgedToken = 'a'.repeat(64);
      const res = await httpGet(DOMAIN, '/', {
        Cookie: `_cpm_fa=${forgedToken}`,
      });
      expect(res.status).toBe(302);
      expect(String(res.headers.location)).toContain('/portal');
    });
  });
