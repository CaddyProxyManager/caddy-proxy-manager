/**
 * Sign-in CAPTCHA with Cap Standalone, self-hosted in the stack. web verifies solves against
 * http://cap:3000; the browser's requests to that name are passed to the host port with page.route,
 * the widget and its WebAssembly still coming from jsDelivr as in production. The setting is
 * removed afterwards, straight from the database, so no later sign-in meets it.
 */
import { test, expect, type Page } from '@playwright/test';
import * as seed from '../helpers/seed';
import { waitForHydration } from '../helpers/hydration';

const BASE = 'http://localhost:3000';
const CAP_HOST_URL = 'http://localhost:3007';
const CAP_INSTANCE = 'http://cap:3000';
const USER = { username: 'captchatest', password: 'CaptchaTest2026!' };

async function createCapSiteKey(): Promise<{ siteKey: string; secretKey: string }> {
  const login = (await (
    await fetch(`${CAP_HOST_URL}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ admin_key: 'e2e-cap-admin-key-0123456789abcdefghij' }),
    })
  ).json()) as { session_token: string; hashed_token: string };
  // The dashboard's own session header: base64 of the token and its hash.
  const session = Buffer.from(
    JSON.stringify({ token: login.session_token, hash: login.hashed_token }),
  ).toString('base64');
  const res = await fetch(`${CAP_HOST_URL}/server/keys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `cpm-e2e-${Date.now()}` }),
  });
  expect(res.ok, `cap key: ${res.status}`).toBe(true);
  return (await res.json()) as { siteKey: string; secretKey: string };
}

/** The browser cannot resolve `cap`; hand its requests to the published port. */
async function routeCap(page: Page) {
  await page.route(`${CAP_INSTANCE}/**`, async (route) => {
    const url = route.request().url().replace(CAP_INSTANCE, CAP_HOST_URL);
    await route.fulfill({ response: await route.fetch({ url }) });
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('Sign-in CAPTCHA (Cap)', () => {
  test.setTimeout(120_000);

  test.beforeAll(() => {
    seed.ensureTestUser(USER.username, USER.password, 'user');
  });

  test.afterAll(() => {
    seed.clearSettingRow('captcha');
  });

  test('is configured in Settings with a Cap site key', async ({ page }) => {
    const key = await createCapSiteKey();
    await page.goto('/settings/authentication');
    await waitForHydration(page);
    await page.getByRole('combobox', { name: /^provider/i }).click();
    await page.getByRole('option', { name: /cap \(self-hosted\)/i }).click();
    await page.getByRole('textbox', { name: /^cap instance url/i }).fill(CAP_INSTANCE);
    await page.getByRole('textbox', { name: /^site key/i }).fill(key.siteKey);
    await page.getByRole('textbox', { name: /^secret key/i }).fill(key.secretKey);
    await page.getByTestId('settings-page-save').click({ force: true });
    // Not staged: nothing of it goes to Caddy.
    await expect(page.getByText(/captcha settings saved/i)).toBeVisible({ timeout: 15_000 });
  });

  test('the server refuses a password sign-in without a solve, and a forged token', async ({
    request,
  }) => {
    const signIn = await request.post(`${BASE}/api/auth/sign-in/username`, {
      headers: { Origin: BASE },
      data: USER,
    });
    expect(signIn.status()).toBe(403);
    expect((await signIn.json()).code).toBe('CAPTCHA_REQUIRED');

    // Checked with Cap's siteverify, which does not know the token.
    const forged = await request.post(`${BASE}/api/sign-in/captcha`, {
      data: { username: USER.username, token: 'forged-token-1234' },
    });
    expect(forged.status()).toBe(403);
    expect((await forged.json()).code).toBe('CAPTCHA_FAILED');
  });

  test('a solved challenge lets the password step through', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    try {
      await routeCap(page);
      await page.goto(`${BASE}/login`);
      await waitForHydration(page);
      await page.getByRole('textbox', { name: /username/i }).fill(USER.username);

      const widget = page.locator('cap-widget');
      await expect(widget).toBeVisible({ timeout: 30_000 });
      // Continuing unsolved is refused on the page.
      await page.getByRole('button', { name: /^continue$/i }).click();
      await expect(page.getByText(/complete the captcha to continue/i)).toBeVisible();

      await widget.click();
      await expect(widget.getByText(/you're human/i)).toBeVisible({ timeout: 60_000 });
      // The widget relabels itself in the same dispatch that hands React the token, whose render
      // can land after a click that follows at machine speed; a person is never that quick.
      const password = page.getByRole('textbox', { name: /password/i });
      await expect(async () => {
        await page.getByRole('button', { name: /^continue$/i }).click();
        await expect(password).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 20_000 });
      await password.fill(USER.password);
      await page.getByRole('button', { name: /^sign in$/i }).click();
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 20_000 });
    } finally {
      await ctx.close();
    }
  });
});
