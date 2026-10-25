/**
 * E2E: a proxy host's page. The row opens it, Edit in the row menu and a section line open its
 * edit page, and the editor's old list link lands there too.
 */
import { test, expect } from '@playwright/test';
import { PROXY_HOSTS_NEWEST_FIRST } from '../../helpers/proxy-api';
import { waitForHydration } from '../../helpers/hydration';

const API_PROXY_HOSTS = 'http://localhost:3000/api/v1/proxy-hosts';
const NAME = 'Host Page E2E';

test.describe('Proxy host page', () => {
  let id: string;
  let origin: string;

  test.beforeEach(async ({ page }) => {
    await page.goto(PROXY_HOSTS_NEWEST_FIRST);
    origin = new URL(page.url()).origin;
    const response = await page.request.post(API_PROXY_HOSTS, {
      headers: { Origin: origin },
      data: { name: NAME, domains: ['host-page-e2e.local'], upstreams: ['localhost:9978'] },
    });
    expect(response.ok()).toBeTruthy();
    id = ((await response.json()) as { uuid: string }).uuid;
  });

  test.afterEach(async ({ page }) => {
    await page.request.delete(`${API_PROXY_HOSTS}/${id}`, { headers: { Origin: origin } });
  });

  test('a row click opens the page; the menu opens its edit page', async ({ page }) => {
    await page.goto('/proxy-hosts?search=host-page-e2e');
    await waitForHydration(page);
    const row = page.locator('tr', { hasText: NAME });
    await expect(row).toBeVisible({ timeout: 10_000 });

    await row.getByRole('button', { name: /^Actions for / }).click();
    await page.getByRole('menuitem', { name: /edit/i }).click();
    await expect(page).toHaveURL(new RegExp(`/proxy-hosts/${id}/edit/general$`));
    await expect(page.getByRole('region', { name: 'Edit proxy host' })).toBeVisible({
      timeout: 10_000,
    });
    await page.goto('/proxy-hosts?search=host-page-e2e');
    await waitForHydration(page);

    // The upstream cell holds no control, so the click belongs to the row.
    await row.getByText('localhost:9978').click();
    await expect(page).toHaveURL(new RegExp(`/proxy-hosts/${id}$`));
    await expect(page.getByRole('heading', { name: NAME, level: 1 })).toBeVisible();
    // Needs attention shows only with something in it, which a fresh host may not have.
    await expect(page.getByRole('heading', { name: 'Configuration', level: 2 })).toBeVisible();
  });

  test('a section line opens the edit page on that section', async ({ page }) => {
    await page.goto(`/proxy-hosts/${id}`);
    await waitForHydration(page);
    await page
      .getByRole('link', { name: /^Upstreams/ })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/proxy-hosts/${id}/edit/upstreams$`));
    const editor = page.getByRole('region', { name: 'Edit proxy host' });
    await expect(editor).toBeVisible({ timeout: 10_000 });
    // One section at a time: the upstreams show, the name sits hidden under General.
    await expect(editor.getByText('localhost:9978').first()).toBeVisible();
    await expect(editor.getByRole('textbox', { name: 'Name' })).toBeHidden();
    await expect(page.locator('.cpm-page-tabs [aria-current="true"]')).toHaveText(/Edit/);
  });

  test('the old editor link goes to the edit page, on the section in its hash', async ({
    page,
  }) => {
    await page.goto(`/proxy-hosts?edit=${id}#access`);
    await expect(page).toHaveURL(new RegExp(`/proxy-hosts/${id}/edit/access$`));
    // TLS is no longer a section of its own; its old address lands on General.
    await page.goto(`/proxy-hosts/${id}/edit/tls`);
    await expect(page).toHaveURL(new RegExp(`/proxy-hosts/${id}/edit/general$`));
    await page.goto(`/proxy-hosts?edit=${id}`);
    await expect(page).toHaveURL(new RegExp(`/proxy-hosts/${id}/edit/general$`));
    await expect(page.getByRole('region', { name: 'Edit proxy host' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('an unknown host is not found', async ({ page }) => {
    const response = await page.goto('/proxy-hosts/00000000-0000-4000-8000-000000000000');
    expect(response?.status()).toBe(404);
  });
});
