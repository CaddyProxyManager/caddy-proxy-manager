import { test, expect, type Page } from '@playwright/test';

/**
 * Unchecked `response.json()` once put a failure's `{ error }` into array state and the first
 * `.map()` blanked the page. Routes are stubbed.
 */

const ANALYTICS_API = '**/api/analytics/**';

/** Uncaught render errors were the symptom of the original crash. */
function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

async function pageShellRendered(page: Page) {
  // A crashed tree unmounts the header too.
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('radio', { name: '24h' })).toBeVisible();
}

test.describe('Analytics API failures', () => {
  test('page survives every analytics endpoint returning 500', async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.route(ANALYTICS_API, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'ClickHouse unreachable' }),
      }),
    );

    await page.goto('/analytics');
    await pageShellRendered(page);

    const banner = page.getByTestId('analytics-load-error');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('ClickHouse unreachable');
    expect(errors, `uncaught errors crashed the page: ${JSON.stringify(errors)}`).toEqual([]);
  });

  test('error banner still appears when the server sends an empty error message', async ({
    page,
  }) => {
    // ECONNREFUSED reaches the browser as {"error":""}, and `{error && <Banner/>}` skips it.
    const errors = trackPageErrors(page);
    await page.route(ANALYTICS_API, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: '' }),
      }),
    );

    await page.goto('/analytics');
    await pageShellRendered(page);

    await expect(page.getByTestId('analytics-load-error')).toBeVisible({ timeout: 15_000 });
    expect(errors).toEqual([]);
  });

  test('page survives when only the hosts endpoint fails', async ({ page }) => {
    // The original crash: `allHosts.some is not a function`.
    const errors = trackPageErrors(page);
    await page.route('**/api/analytics/hosts', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'hosts query failed' }),
      }),
    );

    await page.goto('/analytics');
    await pageShellRendered(page);

    await expect(page.getByText('Traffic by Country')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible({ timeout: 15_000 });
    expect(errors, `uncaught errors crashed the page: ${JSON.stringify(errors)}`).toEqual([]);
  });

  test('page survives the report endpoint returning an unexpected payload', async ({ page }) => {
    // A 200 with an unexpected shape must not reach `.map()` unguarded.
    const errors = trackPageErrors(page);
    await page.route('**/api/analytics/explore**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ unexpected: 'shape', top: 'nope' }),
      }),
    );

    await page.goto('/analytics');
    await pageShellRendered(page);

    await expect(page.getByRole('combobox', { name: 'Filters' })).toBeVisible({ timeout: 15_000 });
    expect(errors, `uncaught errors crashed the page: ${JSON.stringify(errors)}`).toEqual([]);
  });
});
