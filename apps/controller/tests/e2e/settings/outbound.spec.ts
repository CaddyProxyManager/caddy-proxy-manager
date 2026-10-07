/**
 * Offline mode from Settings: the outbound connections list says which calls it turns off, and a
 * GeoIP database that is not one is refused on upload. Puts offline mode back off at the end.
 */
import { test, expect, type Page } from '@playwright/test';
import { waitForHydration } from '../../helpers/hydration';
import { savePage } from '../../helpers/settings-nav';

test.describe.configure({ mode: 'serial' });

function row(page: Page, name: string) {
  return page.getByRole('row').filter({ hasText: name });
}

async function setOffline(page: Page, on: boolean): Promise<void> {
  await page.goto('/settings/outbound');
  await waitForHydration(page);
  const toggle = page.getByRole('switch', { name: 'Offline mode' });
  if ((await toggle.isChecked()) !== on) {
    await toggle.click();
    await savePage(page);
    // Offline mode takes effect on save; it has nothing to stage.
    await expect(page.getByRole('status').filter({ hasText: /settings saved/i })).toBeVisible();
  }
}

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await setOffline(page, false);
  await page.close();
});

test('offline mode turns the internet calls off and leaves the rest', async ({ page }) => {
  await setOffline(page, false);
  await expect(row(page, 'LDAP directories')).toContainText('When configured');

  await setOffline(page, true);
  await page.reload();
  await expect(row(page, "Let's Debug")).toContainText('Off: offline mode');
  await expect(row(page, 'MaxMind GeoIP downloads')).toContainText('Off: offline mode');
  await expect(row(page, 'LDAP directories')).toContainText('When configured');
  await expect(row(page, 'ClickHouse')).toContainText('Always');
});

test('a file that is not a GeoIP database is refused on upload', async ({ page }) => {
  await page.goto('/settings/geo');
  await waitForHydration(page);
  // The labelled button opens the picker; the files go to its hidden input.
  await page.locator('input[type="file"][accept=".mmdb"]').setInputFiles({
    name: 'country.mmdb',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('not a database'),
  });
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByText(/is not a readable GeoLite2-Country database/)).toBeVisible();
});
