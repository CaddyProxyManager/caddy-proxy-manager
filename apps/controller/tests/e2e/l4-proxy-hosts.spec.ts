/** E2E: L4 Proxy Hosts page - navigation, list, create/edit/delete dialogs. */
import { test, expect, type Page } from '@playwright/test';
import { waitForHydration } from '../helpers/hydration';

const API_L4_HOSTS = 'http://localhost:3000/api/v1/l4-proxy-hosts';
const ORIGIN = 'http://localhost:3000';

/** Sortable headers need rows; owning the fixture keeps these tests order-independent. */
async function createFixtureHost(page: Page, name: string, listenAddress: string) {
  const res = await page.request.post(API_L4_HOSTS, {
    headers: { Origin: ORIGIN },
    data: {
      name,
      protocol: 'tcp',
      listenAddress,
      upstreams: ['tcp-echo:9000'],
      matcherType: 'none',
    },
  });
  expect(res.ok(), `L4 fixture host create failed: ${res.status()} ${await res.text()}`).toBe(true);
  return ((await res.json()) as { uuid: string }).uuid;
}

test.describe('L4 Proxy Hosts page', () => {
  test('is accessible from sidebar navigation', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /l4 proxy hosts/i }).click();
    await expect(page).toHaveURL(/\/l4-proxy-hosts/);
    // Non-exact would also match the empty state's "No L4 proxy hosts found".
    await expect(page.getByRole('heading', { name: 'L4 proxy hosts', exact: true })).toBeVisible();
  });

  test('shows empty state when search has no results', async ({ page }) => {
    await page.goto('/l4-proxy-hosts');
    await waitForHydration(page);
    await page.getByPlaceholder(/search/i).fill('zzz-nonexistent-host-zzz');
    await expect(page.getByText(/no l4 hosts match/i).last()).toBeVisible({ timeout: 5_000 });
  });

  test('create dialog opens and contains expected fields', async ({ page }) => {
    await page.goto('/l4-proxy-hosts');
    await waitForHydration(page);
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await expect(page.getByLabel('Name')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Protocol' }).first()).toBeVisible();
    await expect(page.getByLabel('Listen address')).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^Upstreams/ })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Matcher' }).first()).toBeVisible();
  });

  test.describe('column sorting', () => {
    let fixtureId: string | null = null;

    test.beforeAll(async ({ browser }) => {
      const page = await browser.newPage();
      fixtureId = await createFixtureHost(page, 'L4 Sort Fixture', ':15999');
      await page.close();
    });

    test.afterAll(async ({ browser }) => {
      if (fixtureId == null) return;
      const page = await browser.newPage();
      await page.request.delete(`${API_L4_HOSTS}/${fixtureId}`, { headers: { Origin: ORIGIN } });
      await page.close();
    });

    test('clicking Name / Matcher header sorts the table', async ({ page }) => {
      await page.goto('/l4-proxy-hosts');
      const sortBtn = page.getByRole('button', { name: 'Name / matcher' });
      await expect(sortBtn).toBeVisible();

      await sortBtn.click();
      await expect(page).toHaveURL(/sortBy=name/);
      await expect(page).toHaveURL(/sortDir=asc/);

      await sortBtn.click();
      await expect(page).toHaveURL(/sortDir=desc/);
    });

    test('clicking Protocol header sorts by protocol', async ({ page }) => {
      await page.goto('/l4-proxy-hosts');
      const sortBtn = page.getByRole('button', { name: 'Protocol' });
      await expect(sortBtn).toBeVisible();

      await sortBtn.click();
      await expect(page).toHaveURL(/sortBy=protocol/);
    });

    test('clicking Listen header sorts by listen address', async ({ page }) => {
      await page.goto('/l4-proxy-hosts');
      const sortBtn = page.getByRole('button', { name: 'Listen' });
      await expect(sortBtn).toBeVisible();

      await sortBtn.click();
      await expect(page).toHaveURL(/sortBy=listenAddress/);
    });
  });

  test('creates a new L4 proxy host', async ({ page }) => {
    await page.goto('/l4-proxy-hosts');
    await waitForHydration(page);
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByLabel('Name').fill('E2E Test Host');
    await page.getByLabel('Listen address').fill(':19999');
    await page.getByRole('textbox', { name: /^Upstreams/ }).fill('10.0.0.1:5432');

    await page.getByRole('button', { name: /^create$/i }).click();

    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('table').getByText('E2E Test Host', { exact: true })).toBeVisible();
    await expect(page.getByRole('table').getByText(':19999', { exact: true })).toBeVisible();
  });

  // Upstream #295: SO_REUSEPORT lets a second listener on 80/443/2019 bind silently and split traffic.
  test('rejects a listen address on reserved port 443', async ({ page }) => {
    await page.goto('/l4-proxy-hosts');
    await waitForHydration(page);
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByLabel('Name').fill('E2E Reserved Port Host');
    await page.getByLabel('Listen address').fill(':443');
    await page.getByRole('textbox', { name: /^Upstreams/ }).fill('10.0.0.1:8443');

    await page.getByRole('button', { name: /^create$/i }).click();

    await expect(page.getByRole('dialog').getByText(/port 443 is reserved/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('table').getByText('E2E Reserved Port Host')).not.toBeVisible();
  });

  test('listen address field documents the reserved ports', async ({ page }) => {
    await page.goto('/l4-proxy-hosts');
    await waitForHydration(page);
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(
      page.getByRole('dialog').getByText(/ports 80, 443, 2019, 3000, 9090/i),
    ).toBeVisible();
  });

  test('deletes the created L4 proxy host', async ({ page }) => {
    await page.goto('/l4-proxy-hosts');
    await expect(page.getByRole('table').getByText('E2E Test Host', { exact: true })).toBeVisible();

    const row = page.locator('tr', { hasText: 'E2E Test Host' });
    await row.getByRole('button').first().click();
    await page.getByRole('menuitem', { name: /delete/i }).click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText(/Delete the L4 proxy host/i)).toBeVisible();
    await page.getByRole('button', { name: /delete/i }).click();

    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('E2E Test Host')).not.toBeVisible({ timeout: 5_000 });
  });

  /** #241: back-to-back creates left the table stale until a reload. */
  test('rapid successive creates are all reflected in the table without reload', async ({
    page,
  }) => {
    await page.goto('/l4-proxy-hosts');
    await waitForHydration(page);

    for (let i = 1; i <= 3; i++) {
      // Re-opening each time is what exercised the stale useActionState bug.
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByLabel('Name').fill(`E2E Rapid Host ${i}`);
      await page.getByLabel('Listen address').fill(`:2000${i}`);
      await page.getByRole('textbox', { name: /^Upstreams/ }).fill('10.0.0.1:5432');

      await page.getByRole('button', { name: /^create$/i }).click();

      await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 });
      // exact: the row's switch is labelled `Enable <name>`, which contains the name.
      await expect(
        page.getByRole('table').getByText(`E2E Rapid Host ${i}`, { exact: true }),
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  /** #241: the row kept its old status until a reload. */
  test('toggling enabled updates the row status without reload', async ({ page }) => {
    await page.goto('/l4-proxy-hosts');
    await waitForHydration(page);
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByLabel('Name').fill('E2E Toggle Host');
    await page.getByLabel('Listen address').fill(':20010');
    await page.getByRole('textbox', { name: /^Upstreams/ }).fill('10.0.0.1:5432');
    await page.getByRole('button', { name: /^create$/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 });

    const row = page.locator('tr', { hasText: 'E2E Toggle Host' });
    const rowSwitch = row.getByRole('switch').first();
    await expect(row).toBeVisible();

    await expect(rowSwitch).toBeChecked();
    await rowSwitch.click();
    await expect(rowSwitch).not.toBeChecked({ timeout: 10_000 });

    await rowSwitch.click();
    await expect(rowSwitch).toBeChecked({ timeout: 10_000 });

    await row.getByRole('button').first().click();
    await page.getByRole('menuitem', { name: /delete/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: /delete/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('E2E Toggle Host', { exact: true })).not.toBeVisible({
      timeout: 5_000,
    });
  });

  /** Unconditional, via the API: a mid-test failure would leak hosts and their listen ports. */
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      const res = await page.request.get(API_L4_HOSTS);
      if (!res.ok()) return;
      const hosts = (await res.json()) as Array<{ uuid: string; name: string }>;
      for (const host of hosts) {
        if (!/^E2E (Rapid|Toggle) Host/.test(host.name)) continue;
        await page.request.delete(`${API_L4_HOSTS}/${host.uuid}`, { headers: { Origin: ORIGIN } });
      }
    } finally {
      await page.close();
    }
  });
});
