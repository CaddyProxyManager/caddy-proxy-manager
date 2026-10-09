import { test, expect } from '@playwright/test';
import { PROXY_HOSTS_NEWEST_FIRST } from '../../helpers/proxy-api';
import { waitForHydration } from '../../helpers/hydration';

const API_PROXY_HOSTS = 'http://localhost:3000/api/v1/proxy-hosts';

/** Searched to, so the pair shares a page with nothing earlier specs left behind. */
const NAMES = ['Bulk E2E One', 'Bulk E2E Two', 'Bulk E2E Three'];

test.describe('Proxy host bulk actions', () => {
  test('select two hosts and disable them together', async ({ page }) => {
    await page.goto(PROXY_HOSTS_NEWEST_FIRST);
    const origin = new URL(page.url()).origin;
    const ids: string[] = [];
    for (const [index, name] of NAMES.entries()) {
      const response = await page.request.post(API_PROXY_HOSTS, {
        headers: { Origin: origin },
        data: { name, domains: [`bulk-e2e-${index}.local`], upstreams: ['localhost:9977'] },
      });
      expect(response.ok()).toBeTruthy();
      ids.push(((await response.json()) as { uuid: string }).uuid);
    }

    try {
      await page.goto('/proxy-hosts?search=bulk-e2e');
      await waitForHydration(page);
      const table = page.getByRole('table');
      for (const name of NAMES) {
        await expect(table.getByText(name, { exact: true })).toBeVisible({ timeout: 10_000 });
      }

      await page.getByRole('checkbox', { name: `Select ${NAMES[0]}` }).check();
      await page.getByRole('checkbox', { name: `Select ${NAMES[1]}` }).check();

      const bar = page.getByRole('toolbar', { name: 'Bulk actions' });
      await expect(bar.getByText('2 selected')).toBeVisible();
      await bar.getByRole('button', { name: 'Disable', exact: true }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText(NAMES[0], { exact: true })).toBeVisible();
      await expect(dialog.getByText(NAMES[1], { exact: true })).toBeVisible();
      await expect(dialog.getByText(NAMES[2], { exact: true })).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Apply' }).click();
      await expect(dialog).not.toBeVisible({ timeout: 10_000 });
      await expect(bar).not.toBeVisible();

      const enabled = async (id: string) =>
        (
          (await (await page.request.get(`${API_PROXY_HOSTS}/${id}`)).json()) as {
            enabled: boolean;
          }
        ).enabled;
      expect(await enabled(ids[0])).toBe(false);
      expect(await enabled(ids[1])).toBe(false);
      expect(await enabled(ids[2])).toBe(true);

      const rowSwitch = (name: string) =>
        page.locator('tr', { hasText: name }).getByRole('switch').first();
      await expect(rowSwitch(NAMES[0])).not.toBeChecked({ timeout: 10_000 });
      await expect(rowSwitch(NAMES[1])).not.toBeChecked();
      await expect(rowSwitch(NAMES[2])).toBeChecked();
    } finally {
      for (const id of ids) {
        await page.request.delete(`${API_PROXY_HOSTS}/${id}`, { headers: { Origin: origin } });
      }
    }
  });
});
