import { test, expect } from '@playwright/test';
import { waitForHydration } from '../../helpers/hydration';

const API_PROXY_HOSTS = 'http://localhost:3000/api/v1/proxy-hosts';

const NAMES = ['Tags E2E One', 'Tags E2E Two'];

test.describe('Proxy host tags and duplicate', () => {
  test('tag two hosts in bulk, then filter the list by that tag', async ({ page }) => {
    await page.goto('/proxy-hosts');
    const origin = new URL(page.url()).origin;
    const ids: string[] = [];
    for (const [index, name] of NAMES.entries()) {
      const response = await page.request.post(API_PROXY_HOSTS, {
        headers: { Origin: origin },
        data: {
          name,
          domains: [`tags-e2e-${index}.local`],
          upstreams: ['localhost:9977'],
          tags: index === 0 ? ['e2e-first'] : [],
        },
      });
      expect(response.ok()).toBeTruthy();
      ids.push(((await response.json()) as { uuid: string }).uuid);
    }

    try {
      await page.goto('/proxy-hosts?search=tags-e2e');
      await waitForHydration(page);
      const table = page.getByRole('table');
      await expect(table.getByText(NAMES[1], { exact: true })).toBeVisible({ timeout: 10_000 });

      for (const name of NAMES)
        await page.getByRole('checkbox', { name: `Select ${name}` }).check();
      const bar = page.getByRole('toolbar', { name: 'Bulk actions' });
      await bar.getByRole('button', { name: 'More bulk actions' }).click();
      await page.getByRole('menuitem', { name: 'Tag', exact: true }).click();

      const dialog = page.getByRole('dialog');
      const tagField = dialog.getByRole('combobox', { name: 'Tag' });
      await tagField.fill('E2E-Batch');
      // Picks the typed tag and closes the suggestions, which could cover the button.
      await tagField.press('Enter');
      await dialog.getByRole('button', { name: 'Apply' }).click();
      await expect(dialog).not.toBeVisible({ timeout: 10_000 });

      const tagsOf = async (id: string) =>
        ((await (await page.request.get(`${API_PROXY_HOSTS}/${id}`)).json()) as { tags: string[] })
          .tags;
      expect(await tagsOf(ids[0])).toEqual(['e2e-batch', 'e2e-first']);
      expect(await tagsOf(ids[1])).toEqual(['e2e-batch']);

      await page.goto('/proxy-hosts?search=tags-e2e&tag=e2e-first');
      await waitForHydration(page);
      await expect(table.getByText(NAMES[0], { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(table.getByText(NAMES[1], { exact: true })).toHaveCount(0);
    } finally {
      for (const id of ids) {
        await page.request.delete(`${API_PROXY_HOSTS}/${id}`, { headers: { Origin: origin } });
      }
    }
  });

  test('duplicate opens the create editor without the domains', async ({ page }) => {
    await page.goto('/proxy-hosts');
    const origin = new URL(page.url()).origin;
    const response = await page.request.post(API_PROXY_HOSTS, {
      headers: { Origin: origin },
      data: {
        name: 'Duplicate E2E',
        domains: ['duplicate-e2e.local'],
        upstreams: ['localhost:9977'],
        tags: ['dup'],
      },
    });
    expect(response.ok()).toBeTruthy();
    const { uuid: id } = (await response.json()) as { uuid: string };

    try {
      await page.goto('/proxy-hosts?search=duplicate-e2e');
      await waitForHydration(page);
      await page.getByRole('button', { name: 'Actions for Duplicate E2E' }).click();
      await page.getByRole('menuitem', { name: 'Duplicate' }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue(
        'Duplicate E2E (copy)',
      );
      await expect(dialog.getByRole('textbox', { name: 'Domains' })).toHaveValue('');
      await expect(dialog.getByText('dup', { exact: true })).toBeVisible();
    } finally {
      await page.request.delete(`${API_PROXY_HOSTS}/${id}`, { headers: { Origin: origin } });
    }
  });
});
