/**
 * The custom favicon. The route is public on purpose, and its Content-Type comes from the bytes,
 * not the upload's claim, so nothing stored as an image is served as a document.
 */
import { test, expect, type Page } from '@playwright/test';
import { goToSetting, savePage } from '../../helpers/settings-nav';
import { applyStagedChanges, expectStaged } from '../../helpers/staged-settings';

const FAVICON_URL = '/api/branding/favicon';

/** A 1x1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function goToBranding(page: Page) {
  await goToSetting(page, 'Branding');
}

/** Saving stages; the favicon route serves only what Review has applied. */
async function saveAndApply(page: Page) {
  await savePage(page);
  await expectStaged(page);
  await applyStagedChanges(page);
}

async function uploadPng(page: Page) {
  await page.locator('input[type="file"]').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await saveAndApply(page);
}

async function removeIfPresent(page: Page) {
  const remove = page.getByRole('button', { name: /^Remove .*favicon/i });
  if (await remove.isVisible().catch(() => false)) {
    await remove.click();
    await saveAndApply(page);
  }
}

test.describe('Branding - custom favicon', () => {
  test.afterEach(async ({ page }) => {
    // Shared stack: other specs assert on unauthenticated pages.
    await goToBranding(page);
    await removeIfPresent(page);
  });

  test('serves 404 until one is uploaded, without redirecting to login', async ({ page }) => {
    // Public: login, portal and setup declare the icon before there is a session.
    const response = await page.request.get(FAVICON_URL);
    expect(response.status()).toBe(404);
  });

  test('every page declares the icon, signed in or not', async ({ page }) => {
    await page.goto('/settings/general');
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', FAVICON_URL);
  });

  test('an uploaded PNG is stored and served back with its own type', async ({ page }) => {
    await goToBranding(page);
    await uploadPng(page);

    const response = await page.request.get(FAVICON_URL);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('image/png');
    expect(Buffer.from(await response.body())).toEqual(PNG);
    // Lets the browser revalidate rather than re-download.
    expect(response.headers().etag).toMatch(/^"[0-9a-f]{32}"$/);
  });

  test('removing it goes back to 404', async ({ page }) => {
    await goToBranding(page);
    await uploadPng(page);
    expect((await page.request.get(FAVICON_URL)).status()).toBe(200);

    await page.getByRole('button', { name: /^Remove .*favicon/i }).click();
    await expect(page.getByText('is removed when you save')).toBeVisible();
    await saveAndApply(page);
    expect((await page.request.get(FAVICON_URL)).status()).toBe(404);
  });

  test('a file that only claims to be an image is refused', async ({ page }) => {
    // The upload's mimeType is attacker-controlled; trusted, it puts a document on our origin.
    await goToBranding(page);
    await page.locator('input[type="file"]').setInputFiles({
      name: 'evil.png',
      mimeType: 'image/png',
      buffer: Buffer.from('<html><script>alert(document.domain)</script></html>'),
    });
    await savePage(page);

    await expect(page.getByText(/does not look like an image/i)).toBeVisible({ timeout: 15_000 });
    expect((await page.request.get(FAVICON_URL)).status()).toBe(404);
  });
});
