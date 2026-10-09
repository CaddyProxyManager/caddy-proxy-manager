/** E2E: the global search finds a setting by a word it never shows, as Settings' own did. */
import { test, expect, type Page } from '@playwright/test';
import { waitForHydration } from '../../helpers/hydration';

/** The shortcut binds in an effect, so a press can land before the listener exists. */
async function search(page: Page, query: string) {
  await page.goto('/settings');
  await waitForHydration(page);
  await expect(async () => {
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await page.getByRole('dialog').getByRole('combobox').fill(query);
}

test('searching "smtp" leads to the email settings', async ({ page }) => {
  await search(page, 'smtp');
  await page.getByRole('option', { name: /^Email/ }).click();
  await expect(page).toHaveURL(/\/settings\/email/);
});

test('a page outside the settings sections is found too', async ({ page }) => {
  await search(page, 'paranoia');
  await page.getByRole('option', { name: /WAF tuning/ }).click();
  await expect(page).toHaveURL(/\/waf\/settings$/);
});

test('the Settings overview has no search of its own', async ({ page }) => {
  await page.goto('/settings');
  await waitForHydration(page);
  await expect(page.getByRole('combobox', { name: 'Search settings' })).toHaveCount(0);
});
