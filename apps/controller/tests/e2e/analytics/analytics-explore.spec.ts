/**
 * The analytics page's depth: filters and grouping that live in the URL, the mitigated-only log,
 * CSV export and saved views. Rows are seeded behind a host no other spec uses.
 */
import { test, expect } from '@playwright/test';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { ANALYTICS_OFF } from '../../helpers/compose';

const ORIGIN = 'http://localhost:3000';

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

function seedRows(host: string) {
  const now = Math.floor(Date.now() / 1000);
  const row = (uri: string, status: number, outcome: string) => ({
    ts: chDateTime(now - 60),
    client_ip: '198.51.100.40',
    country_code: 'NL',
    host,
    method: 'GET',
    uri,
    status,
    proto: 'HTTP/2.0',
    bytes_sent: 10,
    user_agent: 'explore-test/1.0',
    is_blocked: 0,
    duration_ms: 25,
    outcome,
    ua_family: 'Other',
  });
  return [
    row('/', 200, 'served'),
    row('/', 200, 'served'),
    row('/.env', 403, 'waf'),
    row('/admin', 429, 'rate_limit'),
  ];
}

const filterTo = (host: string) => `f=${encodeURIComponent(`host:is:${host}`)}`;

test.describe('Analytics explore', () => {
  test.skip(ANALYTICS_OFF, 'no ClickHouse in the analytics-off run');

  test('the report API applies outcome filters and groups by outcome', async ({ page }) => {
    const host = `explore-api-${Date.now()}.example.com`;
    const ch = makeClient();
    try {
      await ch.insert({ table: 'traffic_events', format: 'JSONEachRow', values: seedRows(host) });
      const res = await page.request.get(
        `${ORIGIN}/api/analytics/explore?range=1h&group=outcome&${filterTo(host)}`,
      );
      expect(res.ok()).toBeTruthy();
      const report = await res.json();
      expect(report.totals).toMatchObject({ requests: 4, mitigated: 2 });
      const groups = Object.fromEntries(
        (report.groups as { key: string; counts: number[] }[]).map((g) => [
          g.key,
          g.counts.reduce((a, b) => a + b, 0),
        ]),
      );
      expect(groups).toEqual({ served: 2, waf: 1, rate_limit: 1 });

      const waf = await page.request.get(
        `${ORIGIN}/api/analytics/explore?range=1h&${filterTo(host)}&f=outcome%3Ais%3Awaf`,
      );
      expect((await waf.json()).totals.requests).toBe(1);

      const top = await page.request.get(
        `${ORIGIN}/api/analytics/top?range=1h&dimension=path&${filterTo(host)}`,
      );
      expect(await top.json()).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: '/', requests: 2 })]),
      );
    } finally {
      await cleanup(ch, host);
    }
  });

  test('a filter added from a list lands in the URL, and the log narrows to mitigated', async ({
    page,
  }) => {
    const host = `explore-ui-${Date.now()}.example.com`;
    const ch = makeClient();
    try {
      await ch.insert({ table: 'traffic_events', format: 'JSONEachRow', values: seedRows(host) });
      await page.goto(`/analytics?range=1h&${filterTo(host)}`);

      const paths = page.getByTestId('analytics-top-path');
      await expect(paths.getByText('/.env', { exact: true })).toBeVisible({ timeout: 15_000 });
      await paths.getByRole('button', { name: 'Show only /.env' }).click();
      await expect(page).toHaveURL(/path%3Ais%3A%2F\.env/);
      await expect(paths.getByText('/admin', { exact: true })).toBeHidden({ timeout: 15_000 });

      await page.goto(`/analytics?range=1h&${filterTo(host)}`);
      await page.getByRole('switch', { name: 'Mitigated only' }).click();
      await expect(page).toHaveURL(/log=mitigated/);
      await expect(page.getByText('GET /admin').first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('GET /', { exact: true })).toBeHidden();

      // CSV export of the chart buckets.
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download the chart as CSV' }).click();
      expect((await download).suggestedFilename()).toMatch(/\.csv$/);
    } finally {
      await cleanup(ch, host);
    }
  });

  test('a saved view can be saved, opened and deleted', async ({ page }) => {
    const name = `Explore view ${Date.now()}`;
    await page.goto('/analytics?range=7d&group=status');
    await page.getByRole('button', { name: 'Saved views' }).click();
    await page.getByRole('menuitem', { name: 'Save current view…' }).click();
    await page.getByRole('textbox', { name: 'Name' }).fill(name);
    await page.getByRole('button', { name: 'Save view' }).click();
    await expect(page.getByText(`Saved view ${name}`)).toBeVisible({ timeout: 10_000 });

    await page.goto('/analytics');
    await page.getByRole('button', { name: 'Saved views' }).click();
    await page.getByRole('menuitem', { name }).click();
    await expect(page).toHaveURL(/range=7d/);
    await expect(page).toHaveURL(/group=status/);

    await page.getByRole('button', { name: 'Saved views' }).click();
    await page.getByRole('menuitem', { name: 'Manage views…' }).click();
    await page.getByRole('button', { name: `Actions for ${name}` }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.getByText('View deleted')).toBeVisible({ timeout: 10_000 });
  });
});

async function cleanup(ch: ClickHouseClient, host: string) {
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
