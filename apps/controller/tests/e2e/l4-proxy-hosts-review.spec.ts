/** E2E: the L4 editor opened from an `?edit=` link - its review step, and closing on save. */
import { test, expect } from '@playwright/test';
import { waitForHydration } from '../helpers/hydration';
import { saveThroughReview } from '../helpers/host-editor';

const API_L4_HOSTS = 'http://localhost:3000/api/v1/l4-proxy-hosts';
const ORIGIN = 'http://localhost:3000';

test('L4 review shows the listen change and the port apply it needs', async ({ page }) => {
  const response = await page.request.post(API_L4_HOSTS, {
    headers: { Origin: ORIGIN },
    data: {
      name: 'L4 Review E2E',
      protocol: 'tcp',
      listenAddress: ':19871',
      upstreams: ['10.0.0.1:5432'],
    },
  });
  expect(response.ok(), `create failed: ${response.status()}`).toBe(true);
  const id = ((await response.json()) as { uuid: string }).uuid;
  try {
    await page.goto(`/l4-proxy-hosts?edit=${id}#listener`);
    await waitForHydration(page);
    const editor = page.getByRole('dialog', { name: 'Edit L4 proxy host' });
    await expect(editor).toBeVisible({ timeout: 10_000 });

    await editor.getByLabel('Listen address').fill(':19872');
    await editor.getByRole('button', { name: 'Review', exact: true }).click();

    const review = page.getByRole('dialog', { name: 'Review changes' });
    await expect(review.getByText(':19871 to :19872')).toBeVisible({ timeout: 15_000 });
    await expect(review.getByText(/apply the ports from the banner/i)).toBeVisible();
    await review.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(review).not.toBeVisible();
    await expect(editor).toBeVisible();
  } finally {
    await page.request.delete(`${API_L4_HOSTS}/${id}`, { headers: { Origin: ORIGIN } });
  }
});

// The refreshed `?edit=` target re-rendered the dialog inside the close delay, cancelling it.
test('a deep-linked L4 editor closes after saving', async ({ page }) => {
  const response = await page.request.post(API_L4_HOSTS, {
    headers: { Origin: ORIGIN },
    data: {
      name: 'L4 Deep Link Save E2E',
      protocol: 'tcp',
      listenAddress: ':19873',
      upstreams: ['10.0.0.1:5432'],
    },
  });
  expect(response.ok(), `create failed: ${response.status()}`).toBe(true);
  const id = ((await response.json()) as { uuid: string }).uuid;
  try {
    await page.goto(`/l4-proxy-hosts?edit=${id}`);
    await waitForHydration(page);
    const editor = page.getByRole('dialog', { name: 'Edit L4 proxy host' });
    await expect(editor).toBeVisible({ timeout: 10_000 });

    await editor.getByLabel('Notes').fill('Saved from a deep link');
    await saveThroughReview(page, editor);

    await expect(editor).not.toBeVisible({ timeout: 10_000 });
    await expect(page).not.toHaveURL(/[?&]edit=/);

    const saved = await page.request.get(`${API_L4_HOSTS}/${id}`, { headers: { Origin: ORIGIN } });
    expect(((await saved.json()) as { description: string | null }).description).toBe(
      'Saved from a deep link',
    );
  } finally {
    await page.request.delete(`${API_L4_HOSTS}/${id}`, { headers: { Origin: ORIGIN } });
  }
});
