/**
 * Mail through a real SMTP server: Settings -> Email pointed at the stack's mailpit, which enforces
 * SMTP auth, then a test message, a self-service password reset under the password policy, and an
 * invitation sent from the Users page. The SMTP rows are removed afterwards.
 */
import { test, expect, type Browser } from '@playwright/test';
import * as seed from '../helpers/seed';
import { waitForHydration } from '../helpers/hydration';
import {
  SMTP_SETTING_KEYS,
  configureSmtp,
  deleteAllMail,
  firstLink,
  removeSmtp,
  waitForMail,
} from '../helpers/mailpit';
import { signInWithCredentials } from '../helpers/sign-in';

const BASE = 'http://localhost:3000';
// Unique per run: the reset request allows three per address an hour, and a fourth is silent.
const RESET_USER = { username: `resetmail-${Date.now()}`, password: 'ResetMailOld2026!' };
const RESET_EMAIL = `${RESET_USER.username}@localhost`;
const NEW_PASSWORD = 'ResetMailNew2026!';

test.describe.configure({ mode: 'serial' });

async function canSignIn(browser: Browser, username: string, password: string) {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const res = await ctx.request.post(`${BASE}/api/auth/sign-in/username`, {
      headers: { Origin: BASE },
      data: { username, password },
    });
    return res.status() === 200;
  } finally {
    await ctx.close();
  }
}

test.describe('Email - SMTP, password reset and invitations', () => {
  test.setTimeout(90_000);

  test.beforeAll(async () => {
    await deleteAllMail();
    seed.ensureTestUser(RESET_USER.username, RESET_USER.password, 'user');
  });

  test.afterAll(async ({ browser }) => {
    const page = await (await browser.newContext()).newPage();
    await removeSmtp(page);
    await page.context().close();
    for (const key of SMTP_SETTING_KEYS) seed.clearSettingRow(key);
    seed.deleteUserByEmail(RESET_EMAIL);
  });

  test('saved SMTP settings deliver a test message with the stored password', async ({ page }) => {
    await configureSmtp(page);
    await page.reload();
    await waitForHydration(page);
    await page.getByRole('textbox', { name: /send a test message to/i }).fill('e2e@example.com');
    await page.getByRole('button', { name: /^send test email$/i }).click();
    await expect(page.getByText(/test message sent to e2e@example.com/i)).toBeVisible({
      timeout: 20_000,
    });
    await waitForMail('e2e@example.com');
  });

  test('a forgotten password is reset from the emailed link, under the password policy', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE}/login/forgot-password`);
      await waitForHydration(page);
      await page.getByRole('textbox', { name: /username or email/i }).fill(RESET_USER.username);
      await page.getByRole('button', { name: /send reset link/i }).click();
      await expect(page.getByText(/check your email/i)).toBeVisible({ timeout: 15_000 });

      const mail = await waitForMail(RESET_EMAIL);
      const link = firstLink(mail.text, `${BASE}/login/reset-password`);

      await page.goto(link);
      await waitForHydration(page);
      const password = page.getByRole('textbox', { name: /^new password/i });
      const confirm = page.getByRole('textbox', { name: /^confirm new password/i });
      await expect(password).toBeVisible({ timeout: 15_000 });
      // No special character: refused before anything is sent.
      await password.fill('NoSpecialChar2026');
      await confirm.fill('NoSpecialChar2026');
      await page.getByRole('button', { name: /save new password/i }).click();
      await expect(page.getByRole('alert').filter({ hasText: /special/i })).toBeVisible();

      await password.fill(NEW_PASSWORD);
      await confirm.fill(NEW_PASSWORD);
      await page.getByRole('button', { name: /save new password/i }).click();
      await expect(page.getByText(/password saved/i)).toBeVisible({ timeout: 15_000 });

      expect(await canSignIn(browser, RESET_USER.username, RESET_USER.password)).toBe(false);
      expect(await canSignIn(browser, RESET_USER.username, NEW_PASSWORD)).toBe(true);

      // Single use. Via another page: the same path with a new fragment would not reload.
      await page.goto('about:blank');
      await page.goto(link);
      await expect(page.getByText(/this link no longer works/i)).toBeVisible({ timeout: 15_000 });
    } finally {
      await ctx.close();
    }
  });

  test('the server applies the policy to a reset too, whatever the form checked', async ({
    request,
  }) => {
    await deleteAllMail();
    const asked = await request.post(`${BASE}/api/password-reset/request`, {
      headers: { Origin: BASE },
      data: { identifier: RESET_USER.username },
    });
    expect(asked.ok()).toBe(true);
    const link = firstLink((await waitForMail(RESET_EMAIL)).text, `${BASE}/login/reset-password`);
    const token = new URL(link).hash.replace(/^#(token=)?/, '');

    const weak = await request.post(`${BASE}/api/password-reset/complete`, {
      headers: { Origin: BASE },
      data: { token, password: 'short' },
    });
    expect(weak.status()).toBe(400);
    expect((await weak.json()).code).toBe('PASSWORD_POLICY');
  });

  test('an invitation from the Users page lets the new user choose a password', async ({
    page,
    browser,
  }) => {
    const email = `invited-${Date.now()}@example.com`;
    await page.goto('/users');
    await waitForHydration(page);
    await page.getByRole('button', { name: /create user/i }).click();
    await page.getByTestId('create-email').fill(email);
    await page.getByTestId('create-name').fill('Invited User');
    await page.getByRole('radio', { name: /email an invitation/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText(`Invitation sent to ${email}.`)).toBeVisible({ timeout: 15_000 });

    const link = firstLink((await waitForMail(email)).text, `${BASE}/login/reset-password`);
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const invited = await ctx.newPage();
    try {
      await invited.goto(link);
      await waitForHydration(invited);
      await expect(invited.getByText(/set your password/i).first()).toBeVisible({
        timeout: 15_000,
      });
      await invited.getByRole('textbox', { name: /^new password/i }).fill('InvitedUser2026!pw');
      await invited
        .getByRole('textbox', { name: /^confirm new password/i })
        .fill('InvitedUser2026!pw');
      await invited.getByRole('button', { name: /^set password$/i }).click();
      await expect(invited.getByText(/password saved/i)).toBeVisible({ timeout: 15_000 });

      await invited.goto(`${BASE}/login`);
      await waitForHydration(invited);
      await signInWithCredentials(invited, email, 'InvitedUser2026!pw');
      await invited.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 20_000 });
    } finally {
      await ctx.close();
      seed.deleteUserByEmail(email);
    }
  });
});
