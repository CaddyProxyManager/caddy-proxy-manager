import { test, expect } from '@playwright/test';

test.describe('API Docs page', () => {
  test('page loads without error', async ({ page }) => {
    await page.goto('/api-docs');
    await expect(page).not.toHaveURL(/login/);
  });

  test('bundled Swagger UI renders without loading executable CDN assets', async ({ page }) => {
    await page.goto('/api-docs');
    await expect(page.locator('.swagger-ui')).toBeVisible({ timeout: 10_000 });
    const thirdPartyScripts = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .filter((entry) => entry instanceof PerformanceResourceTiming)
        .filter((entry) => entry.initiatorType === 'script')
        .map((entry) => entry.name)
        .filter((url) => new URL(url).origin !== window.location.origin),
    );
    expect(thirdPartyScripts).toEqual([]);
  });

  test('OpenAPI spec endpoint returns valid JSON', async ({ request }) => {
    const response = await request.get('/api/v1/openapi.json');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('openapi');
    expect(body).toHaveProperty('paths');
  });
});

test.describe('API Docs page - unauthenticated access', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('unauthenticated access to /api-docs redirects to /login', async ({ page }) => {
    await page.goto('/api-docs');
    await expect(page).toHaveURL(/\/login/);
  });
});
