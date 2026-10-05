import { test, expect } from '@playwright/test';
import { expectStaged } from '../../helpers/staged-settings';
import { waitForHydration } from '../../helpers/hydration';

test.describe('WAF', () => {
  // A zone away from UTC, so a range read as UTC - or in the runner's own zone - fails.
  test.use({ timezoneId: 'America/New_York' });

  test('WAF events period filters support presets, custom range, and reset to all time', async ({
    page,
    context,
  }) => {
    const customFrom = '2026-05-01T09:00';
    const customTo = '2026-05-02T09:30';
    // The range fields are local time. New York is UTC-4 in May.
    const expectedFrom = Math.floor(Date.parse('2026-05-01T13:00:00Z') / 1000);
    const expectedTo = Math.floor(Date.parse('2026-05-02T13:30:00Z') / 1000);

    await page.goto('/waf');
    // The first render is UTC until the browser records its zone and the page refreshes; a refresh
    // mid-way through the filter clicks below would lose them.
    await expect
      .poll(async () => (await context.cookies()).find((c) => c.name === 'cpm-tz')?.value)
      .toBe('America/New_York');
    await page.waitForLoadState('networkidle');

    await page.getByRole('radio', { name: '24h' }).click();
    await expect(page).toHaveURL(/range=24h/);
    await expect(page.getByRole('radio', { name: '24h' })).toBeVisible();

    await page.getByRole('radio', { name: '7d' }).click();
    await expect(page).toHaveURL(/range=7d/);
    await expect(page.getByRole('radio', { name: '7d' })).toBeVisible();

    await page.getByRole('radio', { name: '30d' }).click();
    await expect(page).toHaveURL(/range=30d/);
    await expect(page.getByRole('radio', { name: '30d' })).toBeVisible();

    await page.getByRole('radio', { name: 'Custom' }).click();

    // A date combobox (ISO input) plus a time field, each committing on blur.
    const fromDate = page.getByRole('combobox', { name: 'From', exact: true });
    const fromTime = page.getByLabel('From time', { exact: true });
    const toDate = page.getByRole('combobox', { name: 'To', exact: true });
    const toTime = page.getByLabel('To time', { exact: true });
    await expect(fromDate).toBeVisible();

    const [fromDay, fromClock] = customFrom.split('T');
    const [toDay, toClock] = customTo.split('T');
    for (const [field, text] of [
      [fromDate, fromDay],
      [fromTime, fromClock],
      [toDate, toDay],
      [toTime, toClock],
    ] as const) {
      await field.fill(text);
      await field.blur();
    }

    await page.getByRole('button', { name: /apply range/i }).click();

    await expect(page).toHaveURL(
      new RegExp(`range=custom.*from=${expectedFrom}.*to=${expectedTo}`),
    );
    // Re-rendered in the field's locale format, so assert the URL round-trip and a non-empty value.
    await expect(fromDate).not.toHaveValue('');
    await expect(toDate).not.toHaveValue('');

    await page.getByRole('radio', { name: 'All time' }).click();
    await expect(page).not.toHaveURL(/range=/);
    await expect(page).not.toHaveURL(/from=/);
    await expect(page).not.toHaveURL(/to=/);
    await expect(page.getByRole('radio', { name: 'All time' })).toBeVisible();
    await expect(fromDate).toHaveCount(0);
  });

  test('WAF page loads without redirecting to login', async ({ page }) => {
    await page.goto('/waf');
    await expect(page).not.toHaveURL(/login/);
    await expect(page.locator('body')).toBeVisible();
  });

  test('WAF page has global settings visible', async ({ page }) => {
    await page.goto('/waf');
    const hasWafContent = (await page.locator('text=/waf|mode|enabled|owasp/i').count()) > 0;
    expect(hasWafContent).toBe(true);
  });

  test('WAF page has Save WAF settings button', async ({ page }) => {
    await page.goto('/waf');
    await waitForHydration(page);
    await page.getByRole('button', { name: /settings/i }).click();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  });

  test('WAF page has tabs', async ({ page }) => {
    await page.goto('/waf');
    await expect(page.getByRole('button', { name: /events/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /exclusions/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /hosts/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /settings/i })).toBeVisible();
  });

  test('WAF settings toggle persists after save and navigation', async ({ page }) => {
    await page.goto('/waf');
    await waitForHydration(page);
    await page.getByRole('button', { name: /settings/i }).click();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();

    const blocking = page.getByRole('radio', { name: 'Blocking', exact: true });
    const owaspCheckbox = page.getByRole('switch', { name: /load owasp core rule set/i });

    await blocking.click();
    await expect(blocking).toBeChecked();

    if (!(await owaspCheckbox.isChecked())) {
      await owaspCheckbox.click();
      await expect(owaspCheckbox).toBeChecked();
    }

    // The button never disables while saving, so waiting on it returns before the edit is staged.
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expectStaged(page);

    await page.goto('/hosts');
    await expect(page).not.toHaveURL(/login/);
    await page.goto('/waf');
    await waitForHydration(page);
    await page.getByRole('button', { name: /settings/i }).click();

    await expect(blocking).toBeChecked();
    await expect(owaspCheckbox).toBeChecked();
  });

  test('WAF settings offer detection only and CRS tuning', async ({ page }) => {
    await page.goto('/waf');
    await waitForHydration(page);
    await page.getByRole('button', { name: /settings/i }).click();

    await page.getByRole('radio', { name: 'Detection only', exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Detection only', exact: true })).toBeChecked();
    await expect(page.getByText('Paranoia level')).toBeVisible();
    await expect(page.getByLabel('Inbound anomaly threshold')).toBeVisible();
  });

  test('WAF exclusions tab adds and removes a scoped exclusion', async ({ page }) => {
    await page.goto('/waf');
    await waitForHydration(page);
    await page.getByRole('button', { name: /exclusions/i }).click();
    await page.getByRole('button', { name: 'Add exclusion' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Rule ID').fill('920350');
    await dialog.getByLabel('Path').fill('/e2e-upload');
    await dialog.getByLabel('Reason').fill('e2e');
    await dialog.getByRole('button', { name: 'Save exclusion' }).click();

    const row = page.getByRole('row').filter({ hasText: '/e2e-upload' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: /actions for the exclusion/i }).click();
    await page.getByRole('menuitem', { name: 'Remove exclusion' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove exclusion' }).click();
    await expect(row).toHaveCount(0);
  });
});
