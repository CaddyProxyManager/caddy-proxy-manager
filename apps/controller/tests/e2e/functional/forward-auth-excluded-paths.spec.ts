/**
 * Functional: CPM Forward Auth with excluded_paths (#108) - excluded paths reach the upstream,
 * others redirect to the portal, the callback still completes auth. Domain: func-fwd-auth-excl.test
 */
import { test, expect } from '@playwright/test';
import { httpGet, waitForStatus } from '../../helpers/http';
import { signInWithCredentials } from '../../helpers/sign-in';

const DOMAIN = 'func-fwd-auth-excl.test';
const ECHO_BODY = 'echo-ok';
const BASE_URL = 'http://localhost:3000';
const API = `${BASE_URL}/api/v1`;

let proxyHostId: number;

test.describe
  .serial('Forward Auth Excluded Paths', () => {
    test('setup: create proxy host with forward auth and excluded paths via API', async ({
      page,
    }) => {
      const res = await page.request.post(`${API}/proxy-hosts`, {
        data: {
          name: 'Excluded Paths Test',
          domains: [DOMAIN],
          upstreams: ['echo-server:8080'],
          sslForced: false,
          cpmForwardAuth: {
            enabled: true,
            excluded_paths: ['/share/*', '/rest/*'],
          },
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

      // Caddy has the config once non-excluded paths redirect.
      await waitForStatus(DOMAIN, 302, 20_000);
    });

    test('excluded path /share/* bypasses auth and reaches upstream', async () => {
      const res = await httpGet(DOMAIN, '/share/some-track');
      expect(res.status).toBe(200);
      expect(res.body).toContain(ECHO_BODY);
    });

    test('excluded path /rest/* bypasses auth and reaches upstream', async () => {
      const res = await httpGet(DOMAIN, '/rest/ping');
      expect(res.status).toBe(200);
      expect(res.body).toContain(ECHO_BODY);
    });

    test('non-excluded root path requires auth (redirects to portal)', async () => {
      const res = await httpGet(DOMAIN, '/');
      expect(res.status).toBe(302);
      const location = String(res.headers.location);
      expect(location).toContain('/portal?rd=');
      expect(location).toContain(DOMAIN);
    });

    test('non-excluded arbitrary path requires auth', async () => {
      const res = await httpGet(DOMAIN, '/admin/dashboard');
      expect(res.status).toBe(302);
      expect(String(res.headers.location)).toContain('/portal');
    });

    test('credential login works for non-excluded paths', async ({ page }) => {
      const context = await page
        .context()
        .browser()!
        .newContext({ storageState: { cookies: [], origins: [] } });
      const freshPage = await context.newPage();

      try {
        await freshPage.goto(`${BASE_URL}/portal?rd=http://${DOMAIN}/protected-page`);
        await expect(freshPage.getByLabel('Username')).toBeVisible({ timeout: 10_000 });

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

        const callbackUrl = new URL(capturedRedirect!);
        const callbackRes = await httpGet(DOMAIN, callbackUrl.pathname + callbackUrl.search);
        expect(callbackRes.status).toBe(302);
        const setCookie = String(callbackRes.headers['set-cookie'] ?? '');
        expect(setCookie).toContain('_cpm_fa=');

        const match = setCookie.match(/_cpm_fa=([^;]+)/);
        expect(match).toBeTruthy();
        const sessionCookie = match![1];
        const upstreamRes = await httpGet(DOMAIN, '/protected-page', {
          Cookie: `_cpm_fa=${sessionCookie}`,
        });
        expect(upstreamRes.status).toBe(200);
        expect(upstreamRes.body).toContain(ECHO_BODY);
      } finally {
        await context.close();
      }
    });

    test('cleanup: delete proxy host', async ({ page }) => {
      if (proxyHostId) {
        const res = await page.request.delete(`${API}/proxy-hosts/${proxyHostId}`, {
          headers: { Origin: BASE_URL },
        });
        expect(res.status()).toBe(200);
      }
    });
  });
