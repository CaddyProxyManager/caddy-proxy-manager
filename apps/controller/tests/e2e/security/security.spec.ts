import { test, expect } from '@playwright/test';
import { waitForHydration } from '../../helpers/hydration';

test.describe('Security', () => {
  test('security events page shows the rule set and keeps its range in the URL', async ({
    page,
  }) => {
    await page.goto('/security');
    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByRole('heading', { name: 'Security events', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Rule set' })).toBeVisible();

    await waitForHydration(page);
    await page.getByRole('radio', { name: '7d' }).click();
    await expect(page).toHaveURL(/range=7d/);
  });

  test('blocks and unblocks an address', async ({ page }) => {
    const address = '198.51.100.77';
    await page.goto('/security/blocked-sources');
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Block a source' }).first().click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: /^Source/ }).fill(address);
    await dialog.getByLabel('Reason').fill('e2e');
    await dialog.getByRole('button', { name: 'Block', exact: true }).click();

    const row = page.getByRole('row').filter({ hasText: address });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: `Unblock ${address}` }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Unblock' }).click();
    await expect(row).toHaveCount(0);
  });

  test('refuses a /0 network', async ({ page }) => {
    await page.goto('/security/blocked-sources');
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Block a source' }).first().click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox', { name: 'Type' }).click();
    await page.getByRole('option', { name: 'Network', exact: true }).click();
    await dialog.getByRole('textbox', { name: /^Source/ }).fill('0.0.0.0/0');
    await dialog.getByRole('button', { name: 'Block', exact: true }).click();
    await expect(dialog.getByText(/every address on the internet/)).toBeVisible();
  });
});
