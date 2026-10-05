/** E2E: the Settings overview's search, which finds a setting by a word it never shows. */
import { test, expect } from '@playwright/test';
import { waitForHydration } from '../../helpers/hydration';

test('searching "smtp" leads to the email settings', async ({ page }) => {
  await page.goto('/settings');
  await waitForHydration(page);
  await page.getByRole('combobox', { name: 'Search settings' }).fill('smtp');
  await page.getByRole('option', { name: /SMTP Server/ }).click();
  await expect(page).toHaveURL(/\/settings\/email/);
});

test('a page outside the settings sections is found too', async ({ page }) => {
  await page.goto('/settings');
  await waitForHydration(page);
  await page.getByRole('combobox', { name: 'Search settings' }).fill('paranoia');
  await page.getByRole('option', { name: /WAF tuning/ }).click();
  await expect(page).toHaveURL(/\/waf\?tab=settings$/);
});
