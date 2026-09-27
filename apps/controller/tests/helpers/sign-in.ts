import type { Page } from '@playwright/test';

/**
 * Drive the credentials half of /login or /portal. The password field is mounted but hidden until
 * `Continue`, and Playwright can neither fill nor find by role inside a hidden subtree, so this
 * steps through the button. Returns once submit is clicked; the caller decides what to await.
 */
export async function signInWithCredentials(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  await page.getByRole('textbox', { name: /username/i }).fill(username);
  // Anchored: `Continue with <provider>` is an SSO button on the same screen.
  await page.getByRole('button', { name: /^continue$/i }).click();
  await page.getByRole('textbox', { name: /password/i }).fill(password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
}

/** Step one only, for tests that assert what the password step looks like. */
export async function submitUsername(page: Page, username: string): Promise<void> {
  await page.getByRole('textbox', { name: /username/i }).fill(username);
  await page.getByRole('button', { name: /^continue$/i }).click();
}
