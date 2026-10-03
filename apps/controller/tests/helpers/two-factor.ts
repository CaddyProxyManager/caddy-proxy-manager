/** Turning on an authenticator through the app's own dialogs, as a person would. */
import { expect, type Page } from '@playwright/test';
import { totpCode } from './totp';

/** A fresh code, waiting out the current window if it's about to roll over mid-submit. */
export async function freshTotpCode(page: Page, secret: string): Promise<string> {
  const remaining = 30_000 - (Date.now() % 30_000);
  if (remaining < 4_000) await page.waitForTimeout(remaining + 250);
  return totpCode(secret);
}

/**
 * From the "Turn on" button, on Profile or the policy's setup page, to the backup codes dismissed.
 * Returns the TOTP secret.
 */
export async function turnOnTwoFactor(page: Page, password: string): Promise<string> {
  await page.getByRole('button', { name: /^turn on$/i }).click();
  const passwordDialog = page.getByRole('dialog');
  await passwordDialog.getByLabel(/current password/i).fill(password);
  await passwordDialog.getByRole('button', { name: /^continue$/i }).click();

  const scan = page.getByRole('dialog', { name: /scan with your authenticator/i });
  await expect(scan.getByRole('img', { name: /qr code/i })).toBeVisible();
  const secret = (await scan.locator('pre, code').first().innerText()).trim();
  await scan.getByLabel(/6-digit code/i).fill(await freshTotpCode(page, secret));
  await scan.getByRole('button', { name: /^turn on$/i }).click();

  const codes = page.getByRole('dialog', { name: /your backup codes/i });
  await expect(codes).toBeVisible({ timeout: 15_000 });
  await codes.getByRole('button', { name: /saved them/i }).click();
  return secret;
}
