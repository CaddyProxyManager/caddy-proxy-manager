/**
 * API tokens from the Profile page: minted once, usable as a Bearer token against /api/v1, and
 * dead the moment they are deleted. Its own admin, so testadmin's token list stays empty.
 */
import { test, expect, request as playwrightRequest } from '@playwright/test';
import * as seed from '../../helpers/seed';
import { waitForHydration } from '../../helpers/hydration';
import { signInWithCredentials } from '../../helpers/sign-in';

const BASE = 'http://localhost:3000';
const USER = { username: 'apitokenuser', password: 'ApiTokenUser2026!' };

async function withBearer(token: string, method: 'GET' | 'POST' = 'GET') {
  const ctx = await playwrightRequest.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const headers = { Authorization: `Bearer ${token}` };
    const response =
      method === 'GET'
        ? await ctx.get(`${BASE}/api/v1/access-lists`, { headers })
        : await ctx.post(`${BASE}/api/v1/access-lists`, {
            headers,
            data: { name: `E2E scoped ${Date.now()}` },
          });
    return response.status();
  } finally {
    await ctx.dispose();
  }
}

/** Opens the create dialog, fills it, and returns the secret shown once afterwards. */
async function createToken(
  page: import('@playwright/test').Page,
  name: string,
  scope?: RegExp,
): Promise<string> {
  await page
    .getByRole('button', { name: /^create$/i })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('e.g. CI/CD Pipeline').fill(name);
  if (scope) await dialog.getByRole('radio', { name: scope }).check();
  await dialog.getByRole('button', { name: /^create$/i }).click();
  await expect(page.getByText(/copy this token now/i)).toBeVisible({ timeout: 15_000 });
  return (
    await page
      .locator('pre, code')
      .filter({ hasText: /\S{20,}/ })
      .first()
      .innerText()
  ).trim();
}

test.use({ storageState: { cookies: [], origins: [] } });

test('an API token is shown once, works as a Bearer token, and dies when deleted', async ({
  page,
}) => {
  seed.ensureTestUser(USER.username, USER.password, 'admin');
  const name = `E2E token ${Date.now()}`;

  await page.goto(`${BASE}/login`);
  await waitForHydration(page);
  await signInWithCredentials(page, USER.username, USER.password);
  await page.waitForURL((url) => !url.pathname.includes('/login'));

  await page.goto(`${BASE}/profile`);
  await waitForHydration(page);
  const token = await createToken(page, name);
  expect(token.length).toBeGreaterThan(20);

  expect(await withBearer(token)).toBe(200);
  expect(await withBearer(`${token}x`)).toBe(401);

  // Only the hash is kept: after a reload the token itself is gone from the page.
  await page.reload();
  await waitForHydration(page);
  await expect(page.getByText(name)).toBeVisible();
  await expect(page.getByText(token)).toHaveCount(0);

  await page.getByRole('button', { name: `Delete token ${name}` }).click();
  const confirm = page.getByRole('alertdialog');
  if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await confirm.getByRole('button', { name: /delete/i }).click();
  }
  await expect(page.getByText(name)).toHaveCount(0, { timeout: 15_000 });
  expect(await withBearer(token)).toBe(401);
});

test('a read-only token reads and is refused every change', async ({ page }) => {
  seed.ensureTestUser(USER.username, USER.password, 'admin');
  await page.goto(`${BASE}/login`);
  await waitForHydration(page);
  await signInWithCredentials(page, USER.username, USER.password);
  await page.waitForURL((url) => !url.pathname.includes('/login'));

  await page.goto(`${BASE}/profile`);
  await waitForHydration(page);
  const name = `E2E read-only ${Date.now()}`;
  const token = await createToken(page, name, /^read only/i);
  await expect(page.getByText(name)).toBeVisible();

  expect(await withBearer(token)).toBe(200);
  expect(await withBearer(token, 'POST')).toBe(403);
});
