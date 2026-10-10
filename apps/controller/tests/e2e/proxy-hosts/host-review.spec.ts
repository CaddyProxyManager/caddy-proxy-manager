/**
 * E2E: the proxy host editor's review step - a section link opening the editor, the unsaved-change
 * count, Ctrl/Cmd+S opening the review, Undo leaving a field as stored, and the prompt before
 * closing over unsaved edits.
 */
import { test, expect, type Page } from '@playwright/test';
import { waitForHydration } from '../../helpers/hydration';

const API_PROXY_HOSTS = 'http://localhost:3000/api/v1/proxy-hosts';
const ORIGIN = 'http://localhost:3000';

async function createHost(page: Page, name: string, domain: string): Promise<string> {
  const response = await page.request.post(API_PROXY_HOSTS, {
    headers: { Origin: ORIGIN },
    data: { name, domains: [domain], upstreams: ['localhost:9977'] },
  });
  expect(response.ok(), `create failed: ${response.status()}`).toBe(true);
  return ((await response.json()) as { uuid: string }).uuid;
}

test.describe('Proxy host review before save', () => {
  test('review lists the changes, undo keeps a field, save writes the rest', async ({ page }) => {
    const id = await createHost(page, 'Review E2E', 'review-e2e.local');
    try {
      await page.goto(`/proxy-hosts?edit=${id}#upstreams`);
      await waitForHydration(page);
      const editor = page.getByRole('dialog', { name: 'Edit proxy host' });
      await expect(editor).toBeVisible({ timeout: 10_000 });
      await expect(editor.getByText('No unsaved changes')).toBeVisible();
      // No footer: the review is the only way to save, and it stays plain until something changes.
      await expect(editor.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
      const reviewButton = editor.getByRole('button', { name: 'Review', exact: true });
      await expect(reviewButton).toHaveAttribute('data-variant', 'secondary');

      await editor.getByLabel('Name').fill('Review E2E renamed');
      await expect(reviewButton).toHaveAttribute('data-variant', 'pink');
      await editor.getByLabel(/^domains/i).fill('review-e2e.local\nreview-e2e-2.local');
      await expect(editor.getByText('2 unsaved changes')).toBeVisible({ timeout: 5_000 });

      await page.keyboard.press('ControlOrMeta+s');
      const review = page.getByRole('dialog', { name: 'Review changes' });
      await expect(review).toBeVisible();
      await expect(review.getByText('Review E2E to Review E2E renamed')).toBeVisible({
        timeout: 15_000,
      });
      await expect(review.getByText('review-e2e-2.local', { exact: false }).first()).toBeVisible();

      const domainsRow = review.getByRole('listitem').filter({ hasText: 'Domains' });
      await domainsRow.getByRole('button', { name: 'Undo' }).click();
      await expect(review.getByText('Undone, left out of this save')).toBeVisible({
        timeout: 15_000,
      });

      await review.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(editor).not.toBeVisible({ timeout: 15_000 });

      const host = (await (await page.request.get(`${API_PROXY_HOSTS}/${id}`)).json()) as {
        name: string;
        domains: string[];
      };
      expect(host.name).toBe('Review E2E renamed');
      expect(host.domains).toEqual(['review-e2e.local']);
    } finally {
      await page.request.delete(`${API_PROXY_HOSTS}/${id}`, { headers: { Origin: ORIGIN } });
    }
  });

  test('closing over unsaved edits asks first', async ({ page }) => {
    const id = await createHost(page, 'Review E2E discard', 'review-e2e-discard.local');
    try {
      await page.goto(`/proxy-hosts?edit=${id}`);
      await waitForHydration(page);
      const editor = page.getByRole('dialog', { name: 'Edit proxy host' });
      await expect(editor).toBeVisible({ timeout: 10_000 });

      await editor.getByLabel('Name').fill('Never saved');
      await expect(editor.getByText('1 unsaved change')).toBeVisible({ timeout: 5_000 });
      await editor.getByRole('button', { name: 'Cancel' }).click();

      const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
      await expect(prompt).toBeVisible();
      await prompt.getByRole('button', { name: 'Keep editing' }).click();
      await expect(editor).toBeVisible();

      await editor.getByRole('button', { name: 'Cancel' }).click();
      await page
        .getByRole('alertdialog', { name: 'Discard unsaved changes?' })
        .getByRole('button', { name: 'Discard changes' })
        .click();
      await expect(editor).not.toBeVisible({ timeout: 10_000 });

      const host = (await (await page.request.get(`${API_PROXY_HOSTS}/${id}`)).json()) as {
        name: string;
      };
      expect(host.name).toBe('Review E2E discard');
    } finally {
      await page.request.delete(`${API_PROXY_HOSTS}/${id}`, { headers: { Origin: ORIGIN } });
    }
  });
});
