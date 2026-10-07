/**
 * A JSON lines file sink: tested from the form, saved, caught up with the audit log, deleted.
 */
import { test, expect } from '@playwright/test';
import { waitForHydration } from '../../helpers/hydration';

test('adds a file sink, tests it, and sees it catch up', async ({ page }) => {
  const name = `e2e-sink-${Date.now()}`;

  await page.goto('/settings/audit-streaming');
  await waitForHydration(page);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: /^name/i }).fill(name);
  await dialog.getByRole('combobox', { name: /^transport/i }).click();
  await page.getByRole('option', { name: 'JSON lines file' }).click();
  await dialog.getByRole('textbox', { name: /^file name/i }).fill(`${name}.jsonl`);
  await dialog.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(dialog.getByText('Test record delivered')).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();

  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('JSON lines file');
  // The leader streams every few seconds; the page shows where it stands when loaded.
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('row').filter({ hasText: name })).toContainText('Up to date');
  }).toPass({ timeout: 60_000 });

  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(0);
});
