/**
 * Functional: L4 (TCP) load balancing (upstream #301). Load balancing used to send
 * reverse_proxy's schema (`selection_policy`, `retries`) to caddy-l4, and Caddy refused the whole
 * config. Two upstreams, the first dead, "First Available", a try window and an active health
 * check: every connection only echoes if caddy-l4 applied all of it.
 *
 * Port TCP 15434; upstreams tcp-echo:9999 (nothing listening) and tcp-echo:9000 (echo).
 */
import { test, expect } from '@playwright/test';
import { tcpSend, waitForTcpEcho } from '../../helpers/tcp';

const TCP_PORT = 15434;
const HOST_NAME = 'L4 LB First Available Test';
const BASE_URL = 'http://localhost:3000';
// Session-cookie API calls need an Origin header to pass the CSRF check.
const SESSION_HEADERS = { Origin: BASE_URL };

test.describe
  .serial('L4 TCP Load Balancing', () => {
    test('setup: create L4 host with load balancing and active health check', async ({ page }) => {
      await page.goto('/l4-proxy-hosts');
      await page.getByRole('button', { name: /create l4 host/i }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      await dialog.getByLabel('Name').fill(HOST_NAME);
      await dialog.getByLabel('Listen Address').fill(`:${TCP_PORT}`);
      await dialog
        .getByRole('textbox', { name: /^Upstreams/ })
        .fill('tcp-echo:9999\ntcp-echo:9000');

      await dialog.getByRole('button', { name: 'Load Balancer' }).click();
      await dialog.getByRole('switch', { name: 'Enable Load Balancing' }).click();
      await dialog.getByRole('combobox', { name: 'Policy' }).click();
      await page.getByRole('option', { name: 'First Available' }).click();
      await dialog.getByLabel('Try Duration').fill('5s');
      await dialog.getByLabel('Try Interval').fill('250ms');
      await dialog.getByRole('switch', { name: 'Enable Active Health Check' }).click();

      // Fields caddy-l4 does not support must not be offered.
      await expect(dialog.getByLabel('Retries')).toHaveCount(0);
      await expect(dialog.getByLabel('Unhealthy Latency')).toHaveCount(0);

      await dialog.getByRole('button', { name: /^create$/i }).click();

      // Before the fix Caddy rejected the config and the dialog stayed open.
      await expect(dialog).not.toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole('table').getByText(HOST_NAME, { exact: true })).toBeVisible({
        timeout: 10_000,
      });

      await waitForTcpEcho('127.0.0.1', TCP_PORT);
    });

    test('stores the load balancer settings', async ({ page }) => {
      const res = await page.request.get('/api/v1/l4-proxy-hosts');
      expect(res.ok()).toBe(true);
      const hosts = (await res.json()) as Array<{
        name: string;
        loadBalancer: Record<string, unknown> | null;
      }>;
      const host = hosts.find((h) => h.name === HOST_NAME);
      expect(host?.loadBalancer).toMatchObject({
        enabled: true,
        policy: 'first',
        tryDuration: '5s',
        tryInterval: '250ms',
        activeHealthCheck: { enabled: true },
      });
    });

    test('fails over from the dead first upstream on every connection', async () => {
      for (let i = 0; i < 5; i++) {
        // tcpSend returns once the socket idles for timeoutMs (the echo server keeps it open).
        const res = await tcpSend('127.0.0.1', TCP_PORT, `lb-probe-${i}\n`, 4_000);
        expect(res.connected).toBe(true);
        expect(res.data).toContain(`lb-probe-${i}`);
      }
    });

    test('cleanup: delete the load-balanced L4 host', async ({ page }) => {
      const res = await page.request.get('/api/v1/l4-proxy-hosts');
      const hosts = (await res.json()) as Array<{ id: number; name: string }>;
      const host = hosts.find((h) => h.name === HOST_NAME);
      expect(host).toBeDefined();
      const del = await page.request.delete(`/api/v1/l4-proxy-hosts/${host!.id}`, {
        headers: SESSION_HEADERS,
      });
      expect(del.ok()).toBe(true);
    });
  });
