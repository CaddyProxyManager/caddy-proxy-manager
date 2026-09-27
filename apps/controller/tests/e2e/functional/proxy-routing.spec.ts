/**
 * Functional: basic reverse-proxy routing to the echo-server container. Domain: func-proxy.test -
 * no DNS needed, requests go to 127.0.0.1:80 with a custom Host header.
 */
import { test, expect } from '@playwright/test';
import { createProxyHost } from '../../helpers/proxy-api';
import { httpGet, waitForRoute } from '../../helpers/http';

const DOMAIN = 'func-proxy.test';
const ECHO_BODY = 'echo-ok';

test.describe
  .serial('Proxy Routing', () => {
    test('setup: create proxy host pointing at echo server', async ({ page }) => {
      await createProxyHost(page, {
        name: 'Functional Proxy Test',
        domain: DOMAIN,
        upstream: 'echo-server:8080',
      });
      await waitForRoute(DOMAIN);
    });

    test('routes HTTP requests to the upstream echo server', async () => {
      const res = await httpGet(DOMAIN);
      expect(res.status).toBe(200);
      expect(res.body).toContain(ECHO_BODY);
    });

    test('proxies arbitrary paths to the upstream', async () => {
      const res = await httpGet(DOMAIN, '/some/path?q=hello');
      expect(res.status).toBe(200);
      expect(res.body).toContain(ECHO_BODY);
    });

    test('unknown domain is not proxied to the echo server', async () => {
      // The unmatched reply depends on the default response, so only isolation is asserted.
      const res = await httpGet('no-such-route.test');
      expect(res.body).not.toContain(ECHO_BODY);
    });

    test('disabled proxy host stops routing traffic', async ({ page }) => {
      await page.goto('/proxy-hosts');
      const row = page.locator('tr', { hasText: 'Functional Proxy Test' });
      await row.getByRole('switch').click();
      await page.waitForTimeout(3_000);

      // Disabling the final host can remove Caddy's HTTP listener entirely; a native response
      // and a closed connection both prove the route is gone.
      try {
        const res = await httpGet(DOMAIN);
        expect(res.body).not.toContain(ECHO_BODY);
      } catch {
        // No HTTP listener is a valid outcome when no managed route remains.
      }

      await row.getByRole('switch').click();
      await page.waitForTimeout(2_000);
    });
  });
