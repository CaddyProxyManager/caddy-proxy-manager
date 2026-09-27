/**
 * `data-astryx-theme` lands on `<html>` in the client root's commit (the layout never renders it,
 * and no Suspense boundary sits above a page), which also attaches every handler. Before it, `fill`
 * leaves state empty and a submit GETs `/login?username=...&password=...` - both silently.
 */
import { expect, type Page } from '@playwright/test';

export async function waitForHydration(page: Page, timeout = 15_000): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-astryx-theme', /\S/, { timeout });
}
