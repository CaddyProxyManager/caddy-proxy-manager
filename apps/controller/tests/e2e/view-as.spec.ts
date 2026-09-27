/** Uses its own admin: the shared session every other spec runs as must never be narrowed. */
import { test, expect, type Page } from '@playwright/test';
import * as seed from '../helpers/seed';
import { waitForHydration } from '../helpers/hydration';
import { signInWithCredentials } from '../helpers/sign-in';

const BASE = 'http://localhost:3000';
const USERNAME = 'viewastest';
const PASSWORD = 'ViewAsTest2026!';

test.use({ storageState: { cookies: [], origins: [] } });

async function signIn(page: Page) {
  await page.goto(`${BASE}/login`);
  await waitForHydration(page);
  await signInWithCredentials(page, USERNAME, PASSWORD);
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 60_000 });
}

test.describe('View as', () => {
  test.beforeAll(() => {
    seed.ensureTestUser(USERNAME, PASSWORD, 'admin');
  });

  test('previews the dashboard as an operator, then returns', async ({ page }) => {
    await signIn(page);
    await page.goto(`${BASE}/users`);
    await waitForHydration(page);

    await page.getByRole('button', { name: /view as a role/i }).click();
    const dialog = page.getByRole('dialog', { name: /view the dashboard as/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /^view as$/i }).click();

    const banner = page.getByText(/viewing as an operator/i);
    await expect(banner).toBeVisible({ timeout: 15_000 });

    // Users is admin-only, so the operator view is refused it.
    await page.goto(`${BASE}/users`);
    await expect(page.getByRole('heading', { name: /^users$/i })).not.toBeVisible();

    await page.goto(`${BASE}/`);
    await waitForHydration(page);
    await page.getByRole('button', { name: /return to my view/i }).click();
    await expect(page.getByText(/viewing as an operator/i)).not.toBeVisible({ timeout: 15_000 });

    await page.goto(`${BASE}/users`);
    await waitForHydration(page);
    await expect(page.getByRole('heading', { name: /^users$/i })).toBeVisible();
  });
});
