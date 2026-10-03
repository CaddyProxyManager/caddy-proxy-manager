/**
 * API tokens from the Profile page: minted once, usable as a Bearer token against /api/v1, and
 * dead the moment they are deleted. Its own admin, so testadmin's token list stays empty.
 */
import { test, expect, request as playwrightRequest } from '@playwright/test';
import * as seed from '../helpers/seed';
import { waitForHydration } from '../helpers/hydration';
import { signInWithCredentials } from '../helpers/sign-in';

const BASE = 'http://localhost:3000';
const USER = { username: 'apitokenuser', password: 'ApiTokenUser2026!' };

async function withBearer(token: string) {
  const ctx = await playwrightRequest.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    return (
      await ctx.get(`${BASE}/api/v1/proxy-hosts`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status();
  } finally {
    await ctx.dispose();
  }
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
  await page.getByPlaceholder('e.g. CI/CD Pipeline').fill(name);
  await page.getByRole('button', { name: /^create token$/i }).click();
  await expect(page.getByText(/copy this token now/i)).toBeVisible({ timeout: 15_000 });
  const token = (
    await page
      .locator('pre, code')
      .filter({ hasText: /\S{20,}/ })
      .first()
      .innerText()
  ).trim();
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
