/**
 * A local destination and a schedule, run by hand, then offered for restoring. The restore itself
 * is not run: it signs out every session, including the one the other specs share.
 */
import { test, expect } from '@playwright/test';
import { waitForHydration } from '../../helpers/hydration';

const PASSPHRASE = 'e2e scheduled passphrase';

test('runs a schedule to a local folder and offers the backup for restoring', async ({ page }) => {
  const stamp = Date.now();
  const destination = `e2e-local-${stamp}`;
  const schedule = `e2e-nightly-${stamp}`;

  await page.goto('/settings/backup');
  await waitForHydration(page);

  // The destinations card comes first, so its Add is the first one.
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  const destinationDialog = page.getByRole('dialog');
  await destinationDialog.getByRole('textbox', { name: /^name/i }).fill(destination);
  await destinationDialog.getByRole('radio', { name: 'Local folder' }).click();
  await destinationDialog.getByRole('textbox', { name: /^folder/i }).fill(`e2e/${stamp}`);
  await destinationDialog.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(destinationDialog.getByText(/the destination works/i)).toBeVisible({
    timeout: 15_000,
  });
  await destinationDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(destinationDialog).toBeHidden();
  await expect(page.getByRole('cell', { name: destination, exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Add', exact: true }).nth(1).click();
  const scheduleDialog = page.getByRole('dialog');
  await scheduleDialog.getByRole('textbox', { name: /^name/i }).fill(schedule);
  await scheduleDialog.getByRole('combobox', { name: /^destination/i }).click();
  await page.getByRole('option', { name: destination }).click();
  await expect(scheduleDialog.getByText(/runs next on/i)).toBeVisible({ timeout: 15_000 });
  await scheduleDialog.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await scheduleDialog.getByLabel(/confirm the passphrase/i).fill(PASSPHRASE);
  await scheduleDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(scheduleDialog).toBeHidden();

  await page.getByRole('button', { name: `Actions for ${schedule}` }).click();
  await page.getByRole('menuitem', { name: 'Run now' }).click();
  const runs = page.getByRole('table').filter({ hasText: 'File size' });
  await expect(runs.getByRole('row').filter({ hasText: schedule }).first()).toContainText(
    'Succeeded',
    { timeout: 30_000 },
  );

  await page.getByRole('radio', { name: 'A destination' }).click();
  await page.getByRole('combobox', { name: /^destination/i }).click();
  await page.getByRole('option', { name: destination }).click();
  await page.getByRole('combobox', { name: /^stored backup/i }).click();
  await page
    .getByRole('option', { name: /cpm-backup-.+-manual\.cpmbak$/ })
    .first()
    .click();
  await expect(page.getByText(/made by version/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /^restore$/i })).toBeDisabled();
});
