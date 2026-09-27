/**
 * The restore itself is not run here: it signs out every session, including the shared admin the
 * other specs run as in parallel. tests/integration/backup-restore.test.ts covers it.
 */
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { waitForHydration } from '../helpers/hydration';

const PASSPHRASE = 'e2e backup passphrase';

test('downloads an encrypted backup, and previews it for restoring', async ({ page }) => {
  await page.goto('/settings/backup');
  await waitForHydration(page);

  const download = page.getByRole('button', { name: /download backup/i });
  await expect(download).toBeDisabled();
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel(/confirm the passphrase/i).fill(PASSPHRASE);

  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  expect(file.suggestedFilename()).toMatch(/^cpm-backup-.+\.cpmbak$/);
  const path = await file.path();
  const contents = readFileSync(path, 'utf8');
  expect(contents.startsWith('CPMBAK1\n')).toBe(true);
  // Sealed: the admin's own email is in the users table, and must not be readable in the file.
  expect(contents).not.toContain('@localhost');

  // Downloads are saved under a random name; the picker only takes .cpmbak files.
  await page.locator('input[type="file"]').setInputFiles({
    name: file.suggestedFilename(),
    mimeType: 'application/octet-stream',
    buffer: readFileSync(path),
  });
  await expect(page.getByText(/made by version/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /^restore$/i })).toBeDisabled();
});
