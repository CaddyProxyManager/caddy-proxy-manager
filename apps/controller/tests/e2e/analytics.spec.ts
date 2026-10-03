import { test, expect } from '@playwright/test';
import { ANALYTICS_OFF } from '../helpers/compose';

test.describe('Analytics', () => {
  test('analytics page loads without redirecting to login', async ({ page }) => {
    await page.goto('/analytics');
    await expect(page).not.toHaveURL(/login/);
    await expect(page.locator('body')).toBeVisible();
  });

  test('analytics page renders content', async ({ page }) => {
    await page.goto('/analytics');
    const hasContent =
      (await page.locator('text=/analytics|traffic|requests|blocked/i').count()) > 0;
    expect(hasContent).toBe(true);
  });

  test('analytics page shows summary stat cards', async ({ page }) => {
    await page.goto('/analytics');
    // These card headers are rendered by AnalyticsClient. Scoped to the stat row: the same words
    // label the map's metric switch and the country table's columns.
    const stats = page.getByTestId('analytics-stats');
    await expect(stats.getByText('Total Requests', { exact: true })).toBeVisible({
      timeout: 10000,
    });
    await expect(stats.getByText('Unique IPs', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(stats.getByText('Blocked Requests', { exact: true })).toBeVisible({
      timeout: 10000,
    });
  });

  test('analytics page shows the disabled banner only while analytics is off', async ({ page }) => {
    await page.goto('/analytics');
    const banner = page.getByText('ClickHouse analytics is not enabled');
    const link = page.getByRole('link', { name: 'Turn analytics on in Settings' });
    if (ANALYTICS_OFF) {
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(link).toHaveAttribute('href', /\/settings/);
    } else {
      await expect(banner).not.toBeVisible();
    }
  });

  test('analytics page has time range toggle buttons', async ({ page }) => {
    await page.goto('/analytics');
    await expect(page.getByRole('radio', { name: '24h' })).toBeVisible();
    await expect(page.getByRole('radio', { name: '7d' })).toBeVisible();
  });

  test('analytics page does not show error content', async ({ page }) => {
    await page.goto('/analytics');
    await expect(page.locator('text=/500|internal server error/i')).not.toBeVisible();
  });
});
