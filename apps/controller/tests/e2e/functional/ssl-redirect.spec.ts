/** ssl_forced: plain HTTP gets a 308. Domain: func-ssl.test */
import { test, expect } from '@playwright/test';
import { httpGet, waitForRoute } from '../../helpers/http';
import { waitForHydration } from '../../helpers/hydration';

const DOMAIN = 'func-ssl.test';

test.describe
  .serial('SSL Redirect (ssl_forced)', () => {
    test('setup: create proxy host with ssl_forced=true', async ({ page }) => {
      // Opened by hand rather than through createProxyHost, which turns Force HTTPS off.
      await page.goto('/proxy-hosts');
      await waitForHydration(page);
      await page.getByRole('button', { name: /create host/i }).click();
      await expect(page.getByRole('dialog')).toBeVisible();

      await page.getByLabel('Name').fill('Functional SSL Redirect Test');
      await page.getByLabel(/^domains/i).fill(DOMAIN);
      await page.getByPlaceholder('10.0.0.5:8080').fill('echo-server:8080');

      // On by default; the spec checks the switch rather than setting it.
      await expect(
        page.getByRole('dialog').getByRole('switch', { name: 'Force HTTPS' }),
      ).toBeChecked();

      await page.getByRole('button', { name: /^create$/i }).click();
      await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByRole('table').getByText('Functional SSL Redirect Test', { exact: true }),
      ).toBeVisible({
        timeout: 10_000,
      });

      await waitForRoute(DOMAIN);
    });

    test('HTTP request receives 308 redirect to HTTPS', async () => {
      const res = await httpGet(DOMAIN, '/');
      expect(res.status).toBe(308);
    });

    test('redirect Location header points to HTTPS', async () => {
      const res = await httpGet(DOMAIN, '/');
      expect(res.status).toBe(308);
      const location = res.headers.location;
      const locationStr = Array.isArray(location) ? location[0] : (location ?? '');
      expect(locationStr).toMatch(/^https:\/\//);
      expect(locationStr).toContain(DOMAIN);
    });

    test('redirect preserves the request path', async () => {
      const res = await httpGet(DOMAIN, '/some/path');
      expect(res.status).toBe(308);
      const location = res.headers.location;
      const locationStr = Array.isArray(location) ? location[0] : (location ?? '');
      expect(locationStr).toContain('/some/path');
    });
  });
