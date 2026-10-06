/**
 * E2E: dashboard overview. The e2e stack has no proxied traffic, so traffic bands show their empty
 * states - what a fresh install sees, and where the two log sources must differ: server events are
 * recorded whether or not access logging was ever on.
 */
import { test, expect, type Page } from '@playwright/test';
import { waitForHydration } from '../helpers/hydration';

/**
 * Clicks the card surface, not `checkbox.click({ force: true })`: for the first ms after load the
 * 1px sr-only checkbox has no content quads, and `force` throws on that instead of retrying.
 */
async function selectTile(page: Page, name: string) {
  const checkbox = page.getByRole('checkbox', { name, exact: true });
  await checkbox.locator('xpath=..').click();
  return checkbox;
}

test.describe('Dashboard home page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // The tiles are plain markup until React attaches the card's click handler.
    await waitForHydration(page);
  });

  test('displays welcome header with user name', async ({ page }) => {
    await expect(page.getByText(/welcome back/i)).toBeVisible();
  });

  test('shows stat cards for Proxy Hosts, Certificates, and Access Lists', async ({ page }) => {
    await expect(page.getByRole('link', { name: /^Proxy hosts:\s*\d+/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Certificates:\s*\d+/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Access lists:\s*\d+/ })).toBeVisible();
  });

  /** The hidden <a> only names the card; the exact name keeps this off the sidebar links. */
  async function clickCard(page: Page, name: string | RegExp) {
    await page.getByRole('link', { name }).locator('xpath=..').click();
  }

  test('Proxy Hosts stat card navigates to /proxy-hosts', async ({ page }) => {
    await clickCard(page, /^Proxy hosts:\s*\d+/);
    await expect(page).toHaveURL(/\/proxy-hosts/);
  });

  test('Certificates stat card navigates to /certificates', async ({ page }) => {
    await clickCard(page, /^Certificates:\s*\d+/);
    await expect(page).toHaveURL(/\/certificates/);
  });

  test('Access Lists stat card navigates to /access-lists', async ({ page }) => {
    await clickCard(page, /^Access lists:\s*\d+/);
    await expect(page).toHaveURL(/\/access-lists/);
  });

  test('View analytics link navigates to /analytics', async ({ page }) => {
    await page.getByRole('link', { name: 'View analytics' }).click();
    await expect(page).toHaveURL(/\/analytics/);
  });

  test('shows every metric tile', async ({ page }) => {
    for (const label of [
      'Requests',
      'Server events',
      '5xx responses',
      '4xx responses',
      'Bandwidth out',
      'Blocked requests',
    ]) {
      await expect(page.getByRole('checkbox', { name: label, exact: true })).toBeVisible();
    }
  });

  test('plots every series until a tile is chosen', async ({ page }) => {
    // No tile is selected on load, so the chart carries the overlay.
    await expect(page.getByRole('heading', { name: 'All metrics', level: 2 })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Requests', exact: true })).not.toBeChecked();
  });

  test('selecting a tile drives the chart below it', async ({ page }) => {
    const tile = await selectTile(page, '5xx responses');
    await expect(tile).toBeChecked();
    // The heading is the visible proof the selection reached the bands below.
    await expect(page.getByRole('heading', { name: '5xx responses', level: 2 })).toBeVisible();
  });

  test('selecting the active tile again returns to the overlay', async ({ page }) => {
    const tile = await selectTile(page, '4xx responses');
    await expect(page.getByRole('heading', { name: '4xx responses', level: 2 })).toBeVisible();

    await selectTile(page, '4xx responses');
    await expect(tile).not.toBeChecked();
    await expect(page.getByRole('heading', { name: 'All metrics', level: 2 })).toBeVisible();
  });

  test('offers the time range control', async ({ page }) => {
    await expect(page.getByRole('radio', { name: '24h' })).toBeVisible();
    await page.getByRole('radio', { name: '7d' }).click();
    await expect(page.getByRole('radio', { name: '7d' })).toBeChecked();
  });

  test('shows the server log and names both its sources', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Server log', level: 2 })).toBeVisible();
    // Blended view: the note covers both stores, only one of which is gated on access logging.
    await expect(
      page.getByText(/traffic_events in ClickHouse, changes from the audit log/i),
    ).toBeVisible();
  });

  test('the Server events tile narrows the log to controller changes', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Server log', level: 2 })).toBeVisible();

    await selectTile(page, 'Server events');

    await expect(page.getByRole('heading', { name: 'Server log', level: 2 })).toBeVisible();
    await expect(page.getByText(/Recorded whether or not access logging is on/i)).toBeVisible();
  });

  test('the Proxy Hosts shortcut counts enabled against the total', async ({ page }) => {
    // A disabled host still exists, so the card names both numbers.
    await expect(
      page.getByRole('link', { name: /^Proxy hosts:\s*\d+ of \d+ enabled$/ }),
    ).toBeVisible();
  });

  test('server events survive an empty traffic window', async ({ page }) => {
    // No traffic, but the sign-in that got us here is a server event: the chart draws its line
    // rather than calling the range empty.
    await expect(page.getByRole('application', { name: /Server events/ })).toBeVisible();
    await expect(page.getByText(/No traffic in this range/i)).toBeHidden();

    await selectTile(page, '5xx responses');
    await expect(page.getByText(/No requests match this tile/i)).toBeVisible();

    // The audit log is recorded regardless, so the sign-in that got us here still shows.
    await selectTile(page, 'Server events');
    await expect(page.getByRole('main').getByRole('row').nth(1)).toBeVisible();
  });
});

test.describe('Needs attention and the setup checklist', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);
  });

  test('lists what needs attention, or says nothing does', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Needs attention', level: 2 })).toBeVisible();
    // Loaded after the page; either outcome is a finished load, never the spinner.
    await expect(
      page.getByText(/^(Nothing needs attention|Critical|Warning|Info)$/).first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Could not check what needs attention.')).toHaveCount(0);
  });

  test('a step can be marked done by hand and undone', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Get started', level: 2 })).toBeVisible();
    const step = page.getByRole('listitem').filter({ hasText: 'Invite a second user' });
    const mark = step.getByRole('button', { name: 'Mark done' });
    // The e2e stack may already have a second user, which ticks the step with no button.
    test.skip(!(await mark.isVisible()), 'detected already');
    await mark.click();
    await expect(step.getByText('Marked done')).toBeVisible();
    await step.getByRole('button', { name: 'Undo' }).click();
    await expect(step.getByRole('button', { name: 'Mark done' })).toBeVisible();
  });
});
