/**
 * E2E: a proxy host's page. The row opens it, Edit stays in the row menu, and a section line opens
 * the editor at that section.
 */
import { test, expect } from '@playwright/test';
import { PROXY_HOSTS_NEWEST_FIRST } from '../../helpers/proxy-api';
import { waitForHydration } from '../../helpers/hydration';

const API_PROXY_HOSTS = 'http://localhost:3000/api/v1/proxy-hosts';
const NAME = 'Host Page E2E';

test.describe('Proxy host page', () => {
  let id: number;
  let origin: string;

  test.beforeEach(async ({ page }) => {
    await page.goto(PROXY_HOSTS_NEWEST_FIRST);
    origin = new URL(page.url()).origin;
    const response = await page.request.post(API_PROXY_HOSTS, {
      headers: { Origin: origin },
      data: { name: NAME, domains: ['host-page-e2e.local'], upstreams: ['localhost:9978'] },
    });
    expect(response.ok()).toBeTruthy();
    id = ((await response.json()) as { id: number }).id;
  });

  test.afterEach(async ({ page }) => {
    await page.request.delete(`${API_PROXY_HOSTS}/${id}`, { headers: { Origin: origin } });
  });

  test('a row click opens the page; the menu still edits in place', async ({ page }) => {
    await page.goto('/proxy-hosts?search=host-page-e2e');
    await waitForHydration(page);
    const row = page.locator('tr', { hasText: NAME });
    await expect(row).toBeVisible({ timeout: 10_000 });

    await row.getByRole('button', { name: /^Actions for / }).click();
    await page.getByRole('menuitem', { name: /edit/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page).toHaveURL(/\/proxy-hosts\?/);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();

    // The upstream cell holds no control, so the click belongs to the row.
    await row.getByText('localhost:9978').click();
    await expect(page).toHaveURL(new RegExp(`/proxy-hosts/${id}$`));
    await expect(page.getByRole('heading', { name: NAME, level: 1 })).toBeVisible();
    // Needs attention shows only with something in it, which a fresh host may not have.
    await expect(page.getByRole('heading', { name: 'Configuration', level: 2 })).toBeVisible();
  });

  test('a section line opens the editor on that host', async ({ page }) => {
    await page.goto(`/proxy-hosts/${id}`);
    await waitForHydration(page);
    await page
      .getByRole('link', { name: /^Upstreams/ })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/proxy-hosts\\?edit=${id}#upstreams$`));
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue(NAME);

    // Closing drops the edit target, so a reload does not reopen it.
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page).not.toHaveURL(/edit=/);
  });

  test('an unknown host is not found', async ({ page }) => {
    const response = await page.goto('/proxy-hosts/999999999');
    expect(response?.status()).toBe(404);
  });
});
