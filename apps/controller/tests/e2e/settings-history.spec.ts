import { test, expect, type Page } from '@playwright/test';
import { applyStagedChanges, expectStaged } from '../helpers/staged-settings';
import { goToSetting, savePage } from '../helpers/settings-nav';
import { waitForHydration } from '../helpers/hydration';

const API_SETTINGS_GENERAL = 'http://localhost:3000/api/v1/settings/general';
const SETTINGS_ORIGIN = 'http://localhost:3000';

async function applyDefaultDomain(page: Page, domain: string) {
  await goToSetting(page, 'General');
  await page.locator('input[name="defaultDomain"]').fill(domain);
  await savePage(page);
  await expectStaged(page);
  await applyStagedChanges(page);
}

test.describe('Settings - revision history', () => {
  test.afterAll(async ({ request }) => {
    await request.put(API_SETTINGS_GENERAL, {
      headers: { Origin: SETTINGS_ORIGIN },
      data: { defaultDomain: 'caddyproxymanager.com', acmeEmail: '' },
    });
  });

  test('compares the last two revisions and restores the earlier one', async ({ page }) => {
    await applyDefaultDomain(page, 'history-one.local');
    await applyDefaultDomain(page, 'history-two.local');

    await page.goto('/settings/history');
    await waitForHydration(page);

    const rows = page.getByTestId('revision-list').locator('[data-testid^="revision-"]');
    await expect(rows.first()).toBeVisible();

    const comparison = page.getByTestId('revision-comparison');
    await expect(comparison.getByText(/"history-one\.local"/).first()).toBeVisible();
    await expect(comparison.getByText(/"history-two\.local"/).first()).toBeVisible();

    // The second row is the first apply above; view it, then restore it.
    await rows.nth(1).getByRole('button', { name: 'View' }).click();
    const restore = comparison.getByTestId('restore-revision');
    await expect(restore).toBeVisible();
    await restore.click();
    await expect(comparison.getByText(/1 change staged/)).toBeVisible({ timeout: 10_000 });

    await applyStagedChanges(page);
    const res = await page.request.get(API_SETTINGS_GENERAL);
    expect((await res.json()).defaultDomain).toBe('history-one.local');
  });

  test('the settings rail leads to the history', async ({ page }) => {
    await page.goto('/settings');
    await waitForHydration(page);
    await page.getByTestId('settings-rail').getByRole('link', { name: 'History' }).click();
    await expect(page).toHaveURL(/\/settings\/history/);
    await expect(page.getByRole('heading', { level: 1, name: 'Revision history' })).toBeVisible();
  });
});
