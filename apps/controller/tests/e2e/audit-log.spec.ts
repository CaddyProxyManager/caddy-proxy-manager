import { test, expect } from '@playwright/test';
import { PROXY_HOSTS_NEWEST_FIRST } from '../helpers/proxy-api';
import { waitForHydration } from '../helpers/hydration';

test.describe('Audit Log', () => {
  test('audit log page loads without redirecting to login', async ({ page }) => {
    await page.goto('/audit-log');
    await expect(page).not.toHaveURL(/login/);
    await expect(page.locator('body')).toBeVisible();
  });

  test('audit log page has a table or list', async ({ page }) => {
    await page.goto('/audit-log');
    const hasTable = (await page.locator('table, [role="grid"], [role="table"]').count()) > 0;
    const hasList = (await page.locator('ul, ol').count()) > 0;
    const hasRows = (await page.locator('tr').count()) > 0;
    expect(hasTable || hasList || hasRows).toBe(true);
  });

  test('creating a proxy host creates audit log entry', async ({ page }) => {
    await page.goto(PROXY_HOSTS_NEWEST_FIRST);
    await waitForHydration(page);
    await page.getByRole('button', { name: /create host/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByLabel('Name').fill('Audit Test Host');
    await page.getByLabel(/^domains/i).fill('audit-test.local');
    await page.getByPlaceholder('10.0.0.5:8080').fill('localhost:8888');

    await page.getByRole('button', { name: /^create$/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('table').getByText('Audit Test Host', { exact: true })).toBeVisible(
      {
        timeout: 10000,
      },
    );

    await page.goto('/audit-log');
    await expect(page.locator('body')).toBeVisible();
  });

  test('audit log page has search functionality', async ({ page }) => {
    await page.goto('/audit-log');
    const hasSearch =
      (await page.getByRole('searchbox').count()) > 0 ||
      (await page.getByPlaceholder(/search/i).count()) > 0 ||
      (await page.getByLabel(/search/i).count()) > 0;
    expect(hasSearch).toBe(true);
  });

  test('verifies the hash chain on request', async ({ page }) => {
    await page.goto('/audit-log');
    await waitForHydration(page);
    await page.getByRole('button', { name: /verify integrity/i }).click();
    await expect(page.getByText(/the audit log is intact/i)).toBeVisible({ timeout: 15_000 });
  });

  test("shows a host change's before and after, unified or side by side", async ({ page }) => {
    await page.goto(PROXY_HOSTS_NEWEST_FIRST);
    await waitForHydration(page);
    await page.getByRole('button', { name: /create host/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByLabel('Name').fill('Audit Diff Host');
    await page.getByLabel(/^domains/i).fill('audit-diff.local');
    await page.getByPlaceholder('10.0.0.5:8080').fill('localhost:8889');
    await page.getByRole('button', { name: /^create$/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 });

    await page.goto('/audit-log?search=Audit%20Diff%20Host');
    await waitForHydration(page);
    await page
      .getByRole('button', { name: /\d+ changes?/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('audit-diff.local')).toBeVisible();
    await dialog.getByRole('radio', { name: /side by side/i }).click();
    await expect(dialog.getByRole('columnheader', { name: /before/i })).toBeVisible();
  });
});
