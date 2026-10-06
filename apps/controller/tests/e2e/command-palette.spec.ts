/**
 * The palette is global: the shortcut and the rail button open it on any dashboard page. Settings'
 * own palette behaviour is in settings.spec.ts. Runs as admin.
 */
import { test, expect, type Page } from '@playwright/test';
import { waitForHydration } from '../helpers/hydration';

/**
 * The shortcut binds in an effect, so a single press can land before the listener exists. Retrying
 * the press is the only way to wait for a listener with no DOM of its own.
 */
async function openWithKeyboard(page: Page) {
  await expect(async () => {
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

test.describe('Global command palette', () => {
  test('the shortcut opens it outside Settings, listing pages and settings', async ({ page }) => {
    await page.goto('/proxy-hosts');
    await waitForHydration(page);
    await openWithKeyboard(page);

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Pages', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Settings', { exact: true }).first()).toBeVisible();
    await expect(dialog.getByText('Audit log', { exact: true })).toBeVisible();
  });

  test('the rail button opens it', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);
    await page.getByRole('button', { name: /^Search…/ }).click();
    await expect(page.getByRole('dialog').getByPlaceholder(/search/i)).toBeVisible();
  });

  test('choosing a page navigates to it', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);
    await openWithKeyboard(page);

    const dialog = page.getByRole('dialog');
    const input = dialog.getByPlaceholder(/search/i);
    await input.pressSequentially('audit');
    await expect(dialog.getByRole('option').first()).toContainText('Audit log');
    // Nothing is highlighted - no arrow key, no pointer over the list - and Enter still takes the
    // top result, which is what typing a name and pressing Enter means.
    await expect(input).not.toHaveAttribute('aria-activedescendant', /.+/);
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/audit-log$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('a setting is found by the environment variable it owns', async ({ page }) => {
    await page.goto('/users');
    await waitForHydration(page);
    await openWithKeyboard(page);

    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder(/search/i).fill('DASHBOARD_DOMAIN');
    await dialog.getByText('Dashboard host', { exact: true }).click();

    await expect(page).toHaveURL(/\/settings\/dashboard$/);
  });
});
