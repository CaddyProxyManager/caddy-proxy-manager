/**
 * A webhook channel, a rule on it, and the rule's test alert in History. The receiver is the
 * whoami container on caddy-network, which answers any POST with 200: the controller reaches it
 * by name, and plain http is allowed because a single-label name is on this network.
 */
import { test, expect, type Page } from '@playwright/test';
import { waitForHydration } from '../helpers/hydration';

const RECEIVER = 'http://whoami-server/';

test.describe.configure({ mode: 'serial' });

async function openTab(page: Page, name: string) {
  await page.getByRole('tab', { name, exact: true }).click();
}

/** Opens a MultiSelector by its label, picks options by name, and closes it. */
async function pick(page: Page, label: RegExp, options: string[]) {
  await page.getByRole('dialog').getByRole('combobox', { name: label }).click();
  for (const option of options) {
    await page.getByRole('option', { name: option, exact: true }).click();
  }
  await page.keyboard.press('Escape');
}

test('tests a webhook channel, alerts through a rule and shows the delivery', async ({ page }) => {
  // A delivery waits out its channel's one-minute batch window before it is sent.
  test.setTimeout(240_000);
  const stamp = Date.now();
  const channel = `e2e-webhook-${stamp}`;
  const rule = `e2e-rule-${stamp}`;

  await page.goto('/alerts');
  await waitForHydration(page);

  await openTab(page, 'Channels');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const channelDialog = page.getByRole('dialog');
  await channelDialog.getByRole('textbox', { name: /^name/i }).fill(channel);
  await channelDialog.getByRole('textbox', { name: /^url/i }).fill(RECEIVER);
  await channelDialog.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(channelDialog.getByText('The test was delivered.')).toBeVisible({
    timeout: 20_000,
  });
  await channelDialog.getByRole('button', { name: 'Save', exact: true }).click();

  // A new webhook's signing secret is shown once.
  const secretDialog = page.getByRole('dialog', { name: 'Webhook signing secret' });
  await expect(secretDialog.getByText(/^whsec_/)).toBeVisible();
  await secretDialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(secretDialog).toBeHidden();
  const channelRow = page.getByRole('row').filter({ hasText: channel });
  await expect(channelRow).toContainText('Webhook');

  await page.getByRole('button', { name: `Actions for ${channel}` }).click();
  await page.getByRole('menuitem', { name: 'Test', exact: true }).click();
  await expect(page.getByText('The test was delivered.')).toBeVisible({ timeout: 20_000 });

  await openTab(page, 'Rules');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const ruleDialog = page.getByRole('dialog');
  await ruleDialog.getByRole('textbox', { name: /^name/i }).fill(rule);
  await pick(page, /^event groups/i, ['New release']);
  await pick(page, /^channels/i, [channel]);
  await ruleDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(ruleDialog).toBeHidden();
  await expect(page.getByRole('row').filter({ hasText: rule })).toContainText('On');

  await page.getByRole('button', { name: `Actions for ${rule}` }).click();
  await page.getByRole('menuitem', { name: 'Test', exact: true }).click();
  await expect(page.getByText(/a test alert is queued/i)).toBeVisible({ timeout: 15_000 });

  // Queued alerts go out on the notifier's next tick, so History is refreshed until it has.
  await openTab(page, 'History');
  const event = page.getByRole('row').filter({ hasText: `Test alert for ${rule}` });
  await expect
    .poll(
      async () => {
        await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        return event.getByText(`${channel}: Sent`).isVisible();
      },
      { timeout: 150_000, intervals: [5_000] },
    )
    .toBe(true);

  await openTab(page, 'Rules');
  await page.getByRole('button', { name: `Actions for ${rule}` }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: rule })).toHaveCount(0);

  await openTab(page, 'Channels');
  await page.getByRole('button', { name: `Actions for ${channel}` }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: channel })).toHaveCount(0);
});
