/**
 * Exports the configuration and previews importing it back into the instance it came from, which
 * finds nothing to do. Applying is left to tests/integration/config-transfer: it reloads Caddy
 * for every spec running beside this one.
 */
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { waitForHydration } from '../../helpers/hydration';
import { signInWithCredentials } from '../../helpers/sign-in';

const PASSPHRASE = 'e2e config passphrase';

// The export wants a sign-in from the last ten minutes, which the shared one may not be by now.
test.use({ storageState: { cookies: [], origins: [] } });

test('exports a readable configuration with its secrets sealed, and previews importing it', async ({
  page,
}) => {
  await page.goto('/login');
  await signInWithCredentials(page, 'testadmin', 'TestPassword2026!');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 });
  await page.goto('/settings/backup');
  await waitForHydration(page);

  const exportButton = page.getByRole('button', { name: /^export$/i });
  await expect(exportButton).toBeDisabled();
  await page.getByLabel('Export passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel(/confirm the export passphrase/i).fill(PASSPHRASE);

  const [file] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
  expect(file.suggestedFilename()).toMatch(/^cpm-config-.+\.json$/);
  const contents = readFileSync(await file.path(), 'utf8');
  const parsed = JSON.parse(contents);
  expect(parsed.format).toBe('cpm-config');
  expect(typeof parsed.mac).toBe('string');
  expect(parsed.tables.users).toBeUndefined();
  expect(contents).not.toContain('enc:v1:');

  await page
    .locator('input[type="file"]')
    .last()
    .setInputFiles({
      name: file.suggestedFilename(),
      mimeType: 'application/json',
      buffer: readFileSync(await file.path()),
    });
  await expect(page.getByText(/exported by version/i)).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("The file's passphrase").fill(PASSPHRASE);
  await page.getByRole('button', { name: /^preview$/i }).click();
  await expect(page.getByText(/nothing would change/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /^import$/i })).toBeDisabled();
});
