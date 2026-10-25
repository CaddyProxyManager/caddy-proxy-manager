import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The host editors save through their review alone: Review opens the diff, and its Save sends
 * the form. The editor's toolbar is the only place to start from, there being no footer.
 */
export async function saveThroughReview(page: Page, editor: Locator): Promise<void> {
  await editor.getByRole('button', { name: 'Review', exact: true }).click();
  const review = page.getByRole('dialog', { name: /^Review/ });
  await expect(review).toBeVisible({ timeout: 10_000 });
  await review.getByRole('button', { name: /^(Save|Create|Submit)$/ }).click();
}

/** The edit page shows one section at a time; this switches to one by its tab. */
export async function showEditorSection(page: Page, label: string): Promise<void> {
  await page
    .locator('.cpm-host-editor-toolbar')
    .getByRole('link', { name: label, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/edit/${label.toLowerCase()}$`));
}
