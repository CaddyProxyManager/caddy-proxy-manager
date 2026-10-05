/**
 * Seeds one country behind a host no other spec uses and filters to it, so the country table
 * holds exactly that country whatever else is in ClickHouse.
 */
import { test, expect } from '@playwright/test';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { ANALYTICS_OFF } from '../../helpers/compose';

const ORIGIN = 'http://localhost:3000';
const COUNTRY = 'IS';

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

test.describe('Analytics country breakdown', () => {
  test.skip(ANALYTICS_OFF, 'no ClickHouse in the analytics-off run');
  test('the country route validates its code and breaks one country down', async ({ page }) => {
    const host = `breakdown-api-${Date.now()}.example.com`;
    const ch = makeClient();
    try {
      await ch.insert({
        table: 'traffic_events',
        format: 'JSONEachRow',
        values: seedRows(host),
      });

      const bad = await page.request.get(`${ORIGIN}/api/analytics/country?interval=1h&code=ISL`);
      expect(bad.status()).toBe(400);

      const res = await page.request.get(
        `${ORIGIN}/api/analytics/country?interval=1h&hosts=${encodeURIComponent(host)}&code=${COUNTRY}`,
      );
      expect(res.ok()).toBeTruthy();
      const body = await res.json();
      expect(body).toMatchObject({
        countryCode: COUNTRY,
        total: 3,
        blocked: 1,
        uniqueIps: 2,
        hosts: [{ host, count: 3 }],
        statusClasses: { ok: 2, redirects: 0, clientErrors: 1, serverErrors: 0 },
      });
      expect(body.userAgents).toEqual(
        expect.arrayContaining([{ userAgent: 'breakdown-test/1.0', count: 2 }]),
      );
    } finally {
      await cleanup(ch, host);
    }
  });

  test('choosing a country opens its breakdown, and the map metric can be switched', async ({
    page,
  }) => {
    const tag = `breakdown-ui-${Date.now()}`;
    const host = `${tag}.example.com`;
    const ch = makeClient();
    try {
      await ch.insert({ table: 'traffic_events', format: 'JSONEachRow', values: seedRows(host) });

      // The seeded host is traffic-only, so the dropdown needs unconfigured hosts included.
      await page.addInitScript(() => {
        try {
          localStorage.setItem('analytics:includeUnconfiguredHosts', '1');
        } catch {
          /* ignore */
        }
      });
      await page.goto('/analytics');
      await expect(page.getByText('Traffic by Country')).toBeVisible({ timeout: 15_000 });

      await page.locator('button[aria-haspopup="listbox"]').click();
      await page.getByPlaceholder('Search hosts…').fill(tag);
      await page.getByRole('option', { name: host }).click();
      await page.keyboard.press('Escape');

      const open = page.getByRole('button', { name: `Show the breakdown for ${COUNTRY}` });
      await expect(open).toBeVisible({ timeout: 15_000 });
      await open.click();

      // Scoped to the card: the map's popup carries the name too.
      const breakdown = page.getByTestId('country-breakdown');
      const iceland = new Intl.DisplayNames(['en'], { type: 'region' }).of(COUNTRY) ?? COUNTRY;
      await expect(breakdown.getByText(iceland, { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(breakdown.getByText(/3 requests/)).toBeVisible();
      await expect(breakdown.getByText(host, { exact: true })).toBeVisible();
      await expect(breakdown.getByText('breakdown-test/1.0', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: `Close the breakdown for ${COUNTRY}` }).click();
      await expect(breakdown).toBeHidden();

      const blocked = page.getByRole('radio', { name: 'Blocked', exact: true });
      await blocked.click();
      await expect(blocked).toBeChecked();
      const ips = page.getByRole('radio', { name: 'Unique IPs', exact: true });
      await ips.click();
      await expect(ips).toBeChecked();
    } finally {
      await cleanup(ch, host);
    }
  });
});

/** Three requests from two addresses: two answered 200 (one of them blocked), one 404. */
function seedRows(host: string) {
  const now = Math.floor(Date.now() / 1000);
  const row = (ip: string, status: number, blocked: boolean, ua: string) => ({
    ts: chDateTime(now),
    client_ip: ip,
    country_code: COUNTRY,
    host,
    method: 'GET',
    uri: '/',
    status,
    proto: 'HTTP/1.1',
    bytes_sent: 1,
    user_agent: ua,
    is_blocked: blocked ? 1 : 0,
  });
  return [
    row('198.51.100.10', 200, false, 'breakdown-test/1.0'),
    row('198.51.100.10', 200, true, 'breakdown-test/1.0'),
    row('198.51.100.11', 404, false, 'curl/8.7.1'),
  ];
}

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
