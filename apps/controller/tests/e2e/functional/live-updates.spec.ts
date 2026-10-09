/**
 * An open Analytics page picks up new traffic by itself: the agent parses every few seconds, the
 * controller announces the batch, and the page re-reads over its event stream - well inside the
 * 30-second timer that is only the fallback. Domain: func-live-updates.test
 */
import { test, expect } from '@playwright/test';
import { httpGet, waitForStatus } from '../../helpers/http';
import { waitForHydration } from '../../helpers/hydration';

const ORIGIN = 'http://localhost:3000';
const DOMAIN = 'func-live-updates.test';
// Agent interval (5s) plus the announcement gap and a refetch; far below the 30s fallback timer.
const LIVE_TIMEOUT_MS = 20_000;

async function clickhouseUp(): Promise<boolean> {
  try {
    return (await fetch('http://localhost:8123/ping', { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

test.describe('Live updates', () => {
  test.setTimeout(120_000);

  test('new traffic appears on an open Analytics page without a reload', async ({ page }) => {
    test.skip(!(await clickhouseUp()), 'ClickHouse not started (analytics-disabled run)');
    let hostId: string | undefined;
    const LOGGING = `${ORIGIN}/api/v1/settings/logging`;
    const previousLogging = await (await page.request.get(LOGGING)).json();
    try {
      const logging = await page.request.put(LOGGING, {
        headers: { Origin: ORIGIN },
        data: { enabled: true, format: 'json' },
      });
      expect(logging.ok(), await logging.text()).toBeTruthy();

      const created = await page.request.post(`${ORIGIN}/api/v1/proxy-hosts`, {
        headers: { Origin: ORIGIN },
        data: {
          name: 'Live updates',
          domains: [DOMAIN],
          upstreams: ['echo-server:8080'],
          sslForced: false,
        },
      });
      expect(created.status(), await created.text()).toBe(201);
      hostId = (await created.json()).uuid;
      await waitForStatus(DOMAIN, 200, 20_000);

      const filter = encodeURIComponent(`host:is:${DOMAIN}`);
      await page.goto(`/analytics?range=1h&f=${filter}`);
      await waitForHydration(page);

      const path = `/live-${Date.now()}`;
      const paths = page.getByTestId('analytics-top-path');
      await expect(paths.filter({ hasText: path })).toHaveCount(0);

      for (let i = 0; i < 3; i++) {
        const res = await httpGet(DOMAIN, path, { 'User-Agent': 'cpm-live-e2e' });
        expect(res.status).toBe(200);
      }

      // No reload, no click: only the push can put it there in this time.
      await expect(paths.filter({ hasText: path }).first()).toBeVisible({
        timeout: LIVE_TIMEOUT_MS,
      });
    } finally {
      await page.request.put(LOGGING, { headers: { Origin: ORIGIN }, data: previousLogging });
      if (hostId !== undefined) {
        await page.request.delete(`${ORIGIN}/api/v1/proxy-hosts/${hostId}`, {
          headers: { Origin: ORIGIN },
        });
      }
    }
  });
});
