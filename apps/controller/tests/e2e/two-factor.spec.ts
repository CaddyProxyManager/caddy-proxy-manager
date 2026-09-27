/** Uses its own account, so the admin every other spec runs as is untouched. */
import { test, expect, type Browser, type Page } from '@playwright/test';
import * as seed from '../helpers/seed';
import { waitForHydration } from '../helpers/hydration';
import { signInWithCredentials } from '../helpers/sign-in';
import { totpCode } from '../helpers/totp';

const BASE = 'http://localhost:3000';
const USERNAME = 'twofactortest';
const EMAIL = `${USERNAME}@localhost`;
const PASSWORD = 'TwoFactorTest2026!';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

let secret = '';
let backupCodes: string[] = [];

async function startSignIn(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/login`);
  await waitForHydration(page);
  await signInWithCredentials(page, USERNAME, PASSWORD);
  return page;
}

/** A fresh code, waiting out the current window if it's about to roll over mid-submit. */
async function freshCode(page: Page): Promise<string> {
  const remaining = 30_000 - (Date.now() % 30_000);
  if (remaining < 4_000) await page.waitForTimeout(remaining + 250);
  return totpCode(secret);
}

test.describe('Two-factor sign-in', () => {
  test.beforeAll(() => {
    seed.ensureTestUser(USERNAME, PASSWORD, 'user');
    seed.resetTwoFactor(EMAIL);
  });

  test.afterAll(() => {
    seed.resetTwoFactor(EMAIL);
  });

  test('turns on from the Profile page and shows backup codes once', async ({ browser }) => {
    const page = await startSignIn(browser);
    await page.waitForURL((url) => !url.pathname.includes('/login'));
    await page.goto(`${BASE}/profile`);
    await waitForHydration(page);

    await page.getByRole('button', { name: /^turn on$/i }).click();
    const passwordDialog = page.getByRole('dialog');
    await passwordDialog.getByLabel(/current password/i).fill(PASSWORD);
    await passwordDialog.getByRole('button', { name: /^continue$/i }).click();

    const scan = page.getByRole('dialog', { name: /scan with your authenticator/i });
    await expect(scan.getByRole('img', { name: /qr code/i })).toBeVisible();
    secret = (await scan.locator('pre, code').first().innerText()).trim();
    expect(secret).toMatch(/^[A-Z2-7]+=*$/);

    await scan.getByLabel(/6-digit code/i).fill(await freshCode(page));
    await scan.getByRole('button', { name: /^turn on$/i }).click();

    const codes = page.getByRole('dialog', { name: /your backup codes/i });
    await expect(codes).toBeVisible({ timeout: 15_000 });
    backupCodes = (await codes.locator('pre, code').first().innerText())
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    expect(backupCodes.length).toBeGreaterThanOrEqual(5);
    await codes.getByRole('button', { name: /saved them/i }).click();

    await expect(page.getByText(/^on$/i).first()).toBeVisible({ timeout: 15_000 });
    await page.context().close();
  });

  test('asks for a code after the password, and signs in with it', async ({ browser }) => {
    const page = await startSignIn(browser);
    const code = page.getByLabel(/authentication code/i);
    await expect(code).toBeVisible({ timeout: 15_000 });
    // Still on /login: the password alone did not sign anyone in.
    expect(new URL(page.url()).pathname).toBe('/login');

    await code.fill('000000');
    await page.getByRole('button', { name: /^verify$/i }).click();
    await expect(page.getByText(/that code is not valid/i)).toBeVisible();

    await code.fill(await freshCode(page));
    await page.getByRole('button', { name: /^verify$/i }).click();
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 });
    await page.context().close();
  });

  test('signs in with a backup code, which then stops working', async ({ browser }) => {
    const page = await startSignIn(browser);
    await page.getByRole('button', { name: /use a backup code/i }).click();
    await page.getByLabel(/backup code/i).fill(backupCodes[0]);
    await page.getByRole('button', { name: /^verify$/i }).click();
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 });
    await page.context().close();

    const again = await startSignIn(browser);
    await again.getByRole('button', { name: /use a backup code/i }).click();
    await again.getByLabel(/backup code/i).fill(backupCodes[0]);
    await again.getByRole('button', { name: /^verify$/i }).click();
    await expect(again.getByText(/that code is not valid/i)).toBeVisible();
    await again.context().close();
  });
});
