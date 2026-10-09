/**
 * Response compression through Caddy's `encode` handler: on by default, off from Settings ->
 * Compression, and a host's own override winning over the global switch. The upstream is whoami's
 * /data endpoint, which returns as many bytes as asked. Domain: func-compression.test
 */
import { test, expect, type Page } from '@playwright/test';
import { httpGet, waitForStatus } from '../../helpers/http';
import { applyStagedChanges, expectStaged } from '../../helpers/staged-settings';
import { waitForHydration } from '../../helpers/hydration';

const ORIGIN = 'http://localhost:3000';
const DOMAIN = 'func-compression.test';
const COMPRESSION = `${ORIGIN}/api/v1/settings/compression`;

/** Big enough that Caddy's minimum length never decides it. */
async function encoding(): Promise<string | undefined> {
  const res = await httpGet(DOMAIN, '/data?size=20000', { 'Accept-Encoding': 'gzip' });
  expect(res.status).toBe(200);
  return res.headers['content-encoding'] as string | undefined;
}

async function setGlobalFromSettings(page: Page, enabled: boolean) {
  await page.goto('/settings/network');
  await waitForHydration(page);
  const toggle = page.getByRole('switch', { name: /^compress responses/i });
  await toggle.scrollIntoViewIfNeeded();
  if ((await toggle.isChecked()) === enabled) return;
  await toggle.click();
  await page.getByTestId('settings-page-save').click({ force: true });
  await expectStaged(page);
  await applyStagedChanges(page);
}

test.describe
  .serial('Compression', () => {
    test.setTimeout(90_000);
    let hostId: string;

    test.beforeAll(async ({ request }) => {
      const created = await request.post(`${ORIGIN}/api/v1/proxy-hosts`, {
        headers: { Origin: ORIGIN },
        data: {
          name: 'Compression',
          domains: [DOMAIN],
          upstreams: ['whoami-server:80'],
          sslForced: false,
        },
      });
      expect(created.status(), await created.text()).toBe(201);
      hostId = (await created.json()).uuid;
      await waitForStatus(DOMAIN, 200, 20_000);
    });

    test.afterAll(async ({ request }) => {
      await request.put(COMPRESSION, { headers: { Origin: ORIGIN }, data: { enabled: true } });
      await request.delete(`${ORIGIN}/api/v1/proxy-hosts/${hostId}`, {
        headers: { Origin: ORIGIN },
      });
    });

    test('responses are compressed by default, and never for a client that did not ask', async () => {
      await expect.poll(encoding, { timeout: 20_000 }).toBe('gzip');
      const plain = await httpGet(DOMAIN, '/data?size=20000');
      expect(plain.headers['content-encoding']).toBeUndefined();
      expect(plain.body.length).toBe(20000);
    });

    test('switching it off in Settings stops it', async ({ page }) => {
      await setGlobalFromSettings(page, false);
      await expect.poll(encoding, { timeout: 20_000 }).toBeUndefined();
    });

    test("a host's own override wins over the global switch", async ({ request }) => {
      const updated = await request.put(`${ORIGIN}/api/v1/proxy-hosts/${hostId}`, {
        headers: { Origin: ORIGIN },
        data: { compression: 'on' },
      });
      expect(updated.ok(), await updated.text()).toBe(true);
      await expect.poll(encoding, { timeout: 20_000 }).toBe('gzip');
    });

    test('switching it back on restores the default for every host', async ({ page, request }) => {
      await request.put(`${ORIGIN}/api/v1/proxy-hosts/${hostId}`, {
        headers: { Origin: ORIGIN },
        data: { compression: 'off' },
      });
      await expect.poll(encoding, { timeout: 20_000 }).toBeUndefined();
      await setGlobalFromSettings(page, true);
      // "off" on the host still wins.
      expect(await encoding()).toBeUndefined();
      await request.put(`${ORIGIN}/api/v1/proxy-hosts/${hostId}`, {
        headers: { Origin: ORIGIN },
        data: { compression: 'inherit' },
      });
      await expect.poll(encoding, { timeout: 20_000 }).toBe('gzip');
    });
  });
