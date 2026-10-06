import { test, expect, type Page } from '@playwright/test';
import { waitForHydration } from '../../helpers/hydration';

// Unique per run: a preset name is unique, and a retry would otherwise collide with the first try.
const NAME = `E2E Preset ${Date.now()}`;

// Continued with trailing backslashes: the allowlist has to judge the joined rule, not each line.
const MULTI_LINE_RULE = [
  'SecRule REQUEST_FILENAME "@beginsWith /remote.php/dav" \\',
  '    "id:9900,phase:1,pass,nolog,\\',
  '    ctl:ruleRemoveById=920420"',
].join('\n');

async function openPresetsTab(page: Page) {
  await page.goto('/waf');
  await waitForHydration(page);
  await page.getByRole('button', { name: 'Presets', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Presets', level: 2 })).toBeVisible();
}

async function openRowMenu(page: Page, item: 'Edit' | 'Delete') {
  await page.getByRole('button', { name: `Actions for ${NAME}` }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

test.describe
  .serial('WAF presets', () => {
    test('refuses a directive the allowlist would drop, then creates a multi-line preset', async ({
      page,
    }) => {
      await openPresetsTab(page);
      await page.getByRole('button', { name: 'New', exact: true }).first().click();

      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Name').fill(NAME);
      await dialog.getByLabel('Description').fill('WebDAV exclusions');
      const directives = dialog.locator('textarea');
      await directives.fill('SecRuleEngine Off');
      await dialog.getByRole('button', { name: 'Create' }).click();

      // Refused and named, and the dialog stays open with what was typed.
      await expect(dialog.getByText(/would be dropped.*SecRuleEngine Off/)).toBeVisible();
      await expect(dialog.getByLabel('Name')).toHaveValue(NAME);

      await directives.fill(MULTI_LINE_RULE);
      await dialog.getByRole('button', { name: 'Create' }).click();

      await expect(dialog).not.toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(`Created preset ${NAME}`)).toBeVisible();
      const row = page.getByRole('row').filter({ hasText: NAME });
      await expect(row).toBeVisible();
      await expect(row.getByText('Not selected')).toBeVisible();
    });

    test('edits a preset and keeps its directives line for line', async ({ page }) => {
      await openPresetsTab(page);
      await openRowMenu(page, 'Edit');

      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: `Edit ${NAME}` })).toBeVisible();
      // A form posts CRLF; the stored preset must come back as the LF it was typed as.
      await expect(dialog.locator('textarea')).toHaveValue(MULTI_LINE_RULE);

      await dialog.getByLabel('Description').fill('Nextcloud WebDAV exclusions');
      await dialog.getByRole('button', { name: 'Save' }).click();

      await expect(dialog).not.toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(`Saved preset ${NAME}`)).toBeVisible();
      await expect(
        page.getByRole('row').filter({ hasText: NAME }).getByText('Nextcloud WebDAV exclusions'),
      ).toBeVisible();
    });

    test('offers the preset in the global WAF settings', async ({ page }) => {
      await openPresetsTab(page);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      // Opened and read only: saving here would stage a settings change other specs would see.
      await page.getByRole('combobox', { name: 'Rule presets' }).click();
      await expect(page.getByRole('option', { name: NAME })).toBeVisible();
      await page.keyboard.press('Escape');
    });

    test('deletes an unused preset', async ({ page }) => {
      await openPresetsTab(page);
      await openRowMenu(page, 'Delete');

      const confirm = page.getByRole('alertdialog');
      await expect(confirm.getByText(`Delete the preset "${NAME}"?`)).toBeVisible();
      await confirm.getByRole('button', { name: 'Delete preset' }).click();

      await expect(page.getByText('Preset deleted')).toBeVisible();
      await expect(page.getByRole('row').filter({ hasText: NAME })).toHaveCount(0);
    });
  });
