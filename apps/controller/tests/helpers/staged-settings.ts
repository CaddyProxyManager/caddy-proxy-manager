/** Settings forms stage, so a spec checking the API or Caddy after a UI save must apply first. */
import { expect, type Locator, type Page } from '@playwright/test';

/** Fails on an empty change set rather than skipping quietly. */
export async function applyStagedChanges(page: Page): Promise<void> {
  const bar = page.getByTestId('staged-bar');
  await expect(bar).toBeVisible({ timeout: 10_000 });

  await bar.getByRole('button', { name: /^review\b/i }).click();

  const apply = page.getByRole('dialog').getByRole('button', { name: /^apply$/i });
  await expect(apply).toBeVisible({ timeout: 10_000 });
  await apply.click();

  // The bar hiding means the apply committed, not merely that the click landed.
  await expect(bar).toBeHidden({ timeout: 30_000 });
}

/**
 * Asserts on the status banner, not /staged|saved/: an earlier spec's value ("X-Cpm-Ui: saved")
 * can sit hidden in the DOM and match first.
 */
export async function expectStaged(scope: Page | Locator, timeout = 10_000): Promise<void> {
  await expect(
    scope
      .getByRole('status')
      .filter({ hasText: /^Staged\. Review and apply/ })
      .first(),
  ).toBeVisible({ timeout });
}
