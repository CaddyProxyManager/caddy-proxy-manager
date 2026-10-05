/**
 * #171: a host that only ever received traffic can still be filtered to. Hosts are filters now, so
 * one in the URL narrows the page, and the hosts list offers it as a filter of its own.
 */
import { test, expect } from '@playwright/test';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { ANALYTICS_OFF } from '../../helpers/compose';

const ORIGIN = 'http://localhost:3000';

// ClickHouse HTTP port is exposed to the host by tests/docker-compose.test.yml.
function makeClient(): ClickHouseClient {
  return createClient({
    url: 'http://localhost:8123',
    username: 'cpm',
    password: 'test-clickhouse-password-2026',
    database: 'analytics',
  });
}

function chDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

test.describe('Analytics host filter (#171)', () => {
  test.skip(ANALYTICS_OFF, 'no ClickHouse in the analytics-off run');
  test('a traffic-only host can be filtered to, from the URL or from its row', async ({ page }) => {
    const host = `hostfilter-${Date.now()}-unconfigured.example.com`;
    const ch = makeClient();

    try {
      await ch.insert({
        table: 'traffic_events',
        format: 'JSONEachRow',
        values: [
          {
            ts: chDateTime(Math.floor(Date.now() / 1000)),
            client_ip: '203.0.113.7',
            host,
            method: 'GET',
            uri: '/',
            status: 200,
            proto: 'HTTP/1.1',
            bytes_sent: 1,
            user_agent: 'host-filter-test',
            is_blocked: 0,
            outcome: 'served',
          },
        ],
      });

      // The hosts the filter bar suggests include it.
      const hosts = await page.request.get(`${ORIGIN}/api/analytics/hosts`);
      expect(JSON.stringify(await hosts.json())).toContain(host);

      await page.goto(`/analytics?range=1h&f=${encodeURIComponent(`host:is:${host}`)}`);
      const hostsList = page.getByTestId('analytics-top-host');
      // Each label's tooltip carries the same text, after it.
      await expect(hostsList.getByText(host, { exact: true }).first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByTestId('analytics-stats').getByText('1', { exact: true }).first(),
      ).toBeVisible();

      // Leaving it out from its own row empties the list.
      await hostsList.getByRole('button', { name: `Leave out ${host}` }).click();
      await expect(page).toHaveURL(new RegExp(`host%3Anot%3A${host.replace(/\./g, '\\.')}`));
      await expect(hostsList.getByText(host, { exact: true })).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await ch
        .command({
          query: `ALTER TABLE traffic_events DELETE WHERE host = {h:String} SETTINGS mutations_sync = 2`,
          query_params: { h: host },
        })
        .catch(() => {
          /* best-effort cleanup */
        });
      await ch.close();
    }
  });
});
