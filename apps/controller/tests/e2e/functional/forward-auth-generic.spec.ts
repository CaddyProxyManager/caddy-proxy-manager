/**
 * Generic forward auth against tests/mock-forward-auth/server.js (mock-forward-auth:9091). whoami
 * echoes the request, so supplied and forged identity headers are both assertable.
 * Domains: func-fa-generic.test, func-fa-generic-split.test, func-fa-generic-bypass.test
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { httpGet, waitForStatus } from '../../helpers/http';

const BASE_URL = 'http://localhost:3000';
const API = `${BASE_URL}/api/v1`;
const AUTH_UPSTREAM = 'http://mock-forward-auth:9091';
const VALID_COOKIE = 'authelia_session=valid-session';
const BROWSER_HEADERS = { Accept: 'text/html,application/xhtml+xml' };

const PLAIN = 'func-fa-generic.test';
const SPLIT = 'func-fa-generic-split.test';
const BYPASS = 'func-fa-generic-bypass.test';

async function createHost(
  request: APIRequestContext,
  name: string,
  domain: string,
  forwardAuth: Record<string, unknown>,
) {
  const res = await request.post(`${API}/proxy-hosts`, {
    data: {
      name,
      domains: [domain],
      upstreams: ['whoami-server:80'],
      sslForced: false,
      forwardAuth: {
        enabled: true,
        provider: 'authelia',
        authUpstream: AUTH_UPSTREAM,
        ...forwardAuth,
      },
    },
    headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
  });
  expect(res.status()).toBe(201);
}

test.describe
  .serial('Generic forward auth', () => {
    test('setup: three hosts, one per behaviour', async ({ page }) => {
      await createHost(page.request, 'FA generic', PLAIN, {});
      await createHost(page.request, 'FA generic split', SPLIT, {
        // Redirects everyone, so only the split can turn a non-browser caller's answer into 401.
        provider: 'custom',
        authEndpoint: '/api/always-redirect',
        apiSplit: true,
      });
      await createHost(page.request, 'FA generic bypass', BYPASS, {
        apiSplit: true,
        apiBypassHeaders: ['X-Api-Key'],
      });

      // The Authelia-style endpoint answers an API-shaped request with 401.
      await waitForStatus(PLAIN, 401, 20_000);
      await waitForStatus(SPLIT, 401, 20_000);
      await waitForStatus(BYPASS, 401, 20_000);
    });

    test('sends a browser to the login portal', async () => {
      const res = await httpGet(PLAIN, '/', BROWSER_HEADERS);
      expect(res.status).toBe(302);
      expect(String(res.headers.location)).toContain('auth-portal.test');
    });

    test('passes an authenticated request through with the identity the auth server gave it', async () => {
      const res = await httpGet(PLAIN, '/', { Cookie: VALID_COOKIE });
      expect(res.status).toBe(200);
      expect(res.body).toContain('Remote-User: alice');
      expect(res.body).toContain('Remote-Email: alice@example.com');
    });

    test('strips an identity header the caller forged', async () => {
      // No session: never reaches the upstream.
      const blocked = await httpGet(PLAIN, '/', { 'Remote-User': 'root' });
      expect(blocked.status).toBe(401);

      // Must arrive as alice: the copy only overwrites when the auth server sent a value.
      const allowed = await httpGet(PLAIN, '/', { Cookie: VALID_COOKIE, 'Remote-User': 'root' });
      expect(allowed.status).toBe(200);
      expect(allowed.body).toContain('Remote-User: alice');
      expect(allowed.body).not.toContain('root');
    });

    test('turns the auth server redirect into a 401 for a caller that is not a browser', async () => {
      const browser = await httpGet(SPLIT, '/', BROWSER_HEADERS);
      expect(browser.status).toBe(302);
      expect(String(browser.headers.location)).toContain('auth-portal.test');

      // The endpoint answers 302 here too; the 401 is CPM's.
      const api = await httpGet(SPLIT, '/api/things');
      expect(api.status).toBe(401);

      // An XHR accepting HTML still must not get a login page.
      const xhr = await httpGet(SPLIT, '/api/things', {
        ...BROWSER_HEADERS,
        'X-Requested-With': 'XMLHttpRequest',
      });
      expect(xhr.status).toBe(401);
    });

    test('lets a bypass header reach the upstream with no session at all', async () => {
      const bypassed = await httpGet(BYPASS, '/printer/objects', { 'X-Api-Key': 'whatever' });
      expect(bypassed.status).toBe(200);
      expect(bypassed.body).toContain('GET /printer/objects');
      // Unauthenticated, so no identity may reach the upstream.
      expect(bypassed.body).not.toContain('Remote-User');

      // Without the header the same path is still gated.
      const gated = await httpGet(BYPASS, '/printer/objects');
      expect(gated.status).toBe(401);
    });

    test('strips a forged identity header on the bypass route too', async () => {
      const res = await httpGet(BYPASS, '/printer/objects', {
        'X-Api-Key': 'whatever',
        'Remote-User': 'root',
      });
      expect(res.status).toBe(200);
      expect(res.body).not.toContain('Remote-User');
    });
  });
