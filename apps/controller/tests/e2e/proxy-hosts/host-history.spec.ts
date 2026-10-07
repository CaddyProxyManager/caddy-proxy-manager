/**
 * E2E: a host's history - two edits leave two revisions after the first, the History tab compares
 * them, and Revert loads the first into the editor, whose review shows what saving puts back
 * before the save records a rollback.
 */
import { test, expect, type Page } from '@playwright/test';
import { waitForHydration } from '../../helpers/hydration';

const API_PROXY_HOSTS = 'http://localhost:3000/api/v1/proxy-hosts';
const ORIGIN = 'http://localhost:3000';

type Revision = { id: number; operation: string; detail: { revision?: number } | null };

async function revisions(page: Page, id: number): Promise<Revision[]> {
  const response = await page.request.get(`${API_PROXY_HOSTS}/${id}/revisions`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { items: Revision[] }).items;
}

test.describe('Proxy host history', () => {
  test('compares two edits and rolls back through the review', async ({ page }) => {
    const created = await page.request.post(API_PROXY_HOSTS, {
      headers: { Origin: ORIGIN },
      data: { name: 'History E2E', domains: ['history-e2e.local'], upstreams: ['localhost:9977'] },
    });
    expect(created.ok()).toBe(true);
    const id = ((await created.json()) as { id: number }).id;
    try {
      for (const data of [{ name: 'History E2E v2' }, { upstreams: ['localhost:9978'] }]) {
        const response = await page.request.put(`${API_PROXY_HOSTS}/${id}`, {
          headers: { Origin: ORIGIN },
          data,
        });
        expect(response.ok()).toBe(true);
      }
      const [latest, second, first] = await revisions(page, id);
      expect([first.operation, second.operation, latest.operation]).toEqual([
        'create',
        'update',
        'update',
      ]);

      await page.goto(`/proxy-hosts/${id}`);
      await waitForHydration(page);
      await page.getByRole('link', { name: 'History' }).click();
      await expect(page).toHaveURL(new RegExp(`/proxy-hosts/${id}/history`));
      await waitForHydration(page);
      const list = page.getByTestId('host-revision-list');
      await expect(list.getByTestId(`host-revision-${first.id}`)).toBeVisible();
      await expect(list.getByTestId(`host-revision-${latest.id}`)).toContainText('Current');

      // The newest against the one before it: only the upstream moved.
      const comparison = page.getByTestId('host-revision-comparison');
      await expect(comparison.getByText('localhost:9978').first()).toBeVisible({ timeout: 10_000 });

      await list
        .getByTestId(`host-revision-${first.id}`)
        .getByRole('button', { name: 'View' })
        .click();
      await expect(page).toHaveURL(new RegExp(`to=${first.id}`));
      await comparison.getByTestId('rollback-revision').click();

      const editor = page.getByRole('dialog', { name: 'Edit proxy host' });
      await expect(editor).toBeVisible({ timeout: 10_000 });
      await expect(editor.getByTestId('rollback-notice')).toContainText(`#${first.id}`);
      await editor.getByRole('button', { name: 'Review' }).click();
      const review = page.getByRole('dialog', { name: 'Review changes' });
      await expect(review.getByText('History E2E v2 to History E2E')).toBeVisible({
        timeout: 15_000,
      });
      await review.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(editor).not.toBeVisible({ timeout: 15_000 });

      const host = (await (await page.request.get(`${API_PROXY_HOSTS}/${id}`)).json()) as {
        name: string;
        upstreams: string[];
      };
      expect(host.name).toBe('History E2E');
      // The editor writes the upstream as its field shows it, with the scheme.
      expect(host.upstreams).toEqual([expect.stringMatching(/localhost:9977$/)]);
      const [rolledBack] = await revisions(page, id);
      expect(rolledBack).toMatchObject({ operation: 'rollback', detail: { revision: first.id } });
    } finally {
      await page.request.delete(`${API_PROXY_HOSTS}/${id}`, { headers: { Origin: ORIGIN } });
    }
  });
});
