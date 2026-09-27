/**
 * WAF directives are linted as typed and validated by a real Caddy on save; the only end-to-end
 * test of the agent's `caddy validate`, socket proxy and all.
 */
import { test, expect, type Page } from '@playwright/test';
import { waitForHydration } from '../../helpers/hydration';
import { runSeedScript } from '../../helpers/seed';

async function openNewPreset(page: Page) {
  await page.goto('/waf');
  await waitForHydration(page);
  await page.getByRole('button', { name: 'Presets', exact: true }).click();
  await page.getByRole('button', { name: 'New preset' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New preset' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe
  .serial('WAF config validation', () => {
    test.afterAll(() => {
      runSeedScript(`
        await sql\`DELETE FROM waf_presets WHERE name LIKE 'e2e-validate-%'\`;
        await sql.close();
      `);
    });

    test('the editor names a line Coraza would refuse, as it is typed', async ({ page }) => {
      const dialog = await openNewPreset(page);
      await dialog
        .getByRole('textbox', { name: 'SecLang directives' })
        .fill('SecAction "id:9800,phase:1,pass,nolog"\nSecRule ARGS "@rxx a" "id:9801,pass"');
      await expect(
        dialog.getByText('Line 2: "@rxx" is not an operator Coraza knows', { exact: false }),
      ).toBeVisible();
    });

    test('Caddy refuses what only it can know, and nothing is saved', async ({ page }) => {
      const dialog = await openNewPreset(page);
      await dialog.getByRole('textbox', { name: 'Name' }).fill('e2e-validate-broken');
      // The linter passes it; Go's regexp refuses the reversed range when Coraza compiles it.
      await dialog
        .getByRole('textbox', { name: 'SecLang directives' })
        .fill('SecRule ARGS "@rx [z-a]" "id:9802,phase:1,pass,nolog"');
      await expect(dialog.getByRole('list', { name: 'Problems found in this text' })).toHaveCount(
        0,
      );
      await dialog.getByRole('button', { name: 'Create' }).click();

      await expect(
        dialog.getByText('Coraza refused to load the preset', { exact: false }),
      ).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        dialog.getByText('invalid character class range', { exact: false }),
      ).toBeVisible();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByRole('row').filter({ hasText: 'e2e-validate-broken' })).toHaveCount(0);
    });

    test('a preset Caddy accepts is saved', async ({ page }) => {
      const dialog = await openNewPreset(page);
      await dialog.getByRole('textbox', { name: 'Name' }).fill('e2e-validate-ok');
      await dialog
        .getByRole('textbox', { name: 'SecLang directives' })
        .fill('SecRule ARGS "@rx [a-z]" "id:9803,phase:1,pass,nolog"');
      await dialog.getByRole('button', { name: 'Create' }).click();

      await expect(dialog).not.toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('row').filter({ hasText: 'e2e-validate-ok' })).toBeVisible();
    });
  });
