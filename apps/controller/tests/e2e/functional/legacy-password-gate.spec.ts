/**
 * The legacy-password gate end to end. Unit tests cover the decision; only a real browser shows the
 * redirect terminates - if /password-change moved inside the dashboard group, they would bounce.
 */
import { test, expect } from '@playwright/test';
import {
  ensureTestUser,
  downgradeUserToBcrypt,
  getUserHashAlgorithm,
  setSettingRow,
  clearSettingRow,
} from '../../helpers/seed';
import { waitForHydration } from '../../helpers/hydration';
import { signInWithCredentials } from '../../helpers/sign-in';

const USERNAME = 'legacyhashuser';
const EMAIL = `${USERNAME}@localhost`;
const OLD_PASSWORD = 'LegacyPassword2026!';
const NEW_PASSWORD = 'ReplacementPassword2026!';
const POLICY_KEY = 'password_policy';

// This user must sign in as itself, so no pre-authenticated state.
test.use({ storageState: { cookies: [], origins: [] } });

async function signIn(page: import('@playwright/test').Page, password: string) {
  await page.goto('/login');
  // Before hydration the form submits natively - a GET with the credentials in the query.
  await waitForHydration(page);
  await signInWithCredentials(page, USERNAME, password);
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

test.describe('Legacy password gate', () => {
  test.beforeEach(() => {
    ensureTestUser(USERNAME, OLD_PASSWORD, 'user');
    downgradeUserToBcrypt(EMAIL, OLD_PASSWORD);
    setSettingRow(POLICY_KEY, { requireChangeOnLegacyHash: true });
  });

  test.afterEach(() => {
    clearSettingRow(POLICY_KEY);
  });

  test('the fixture really is a bcrypt hash', () => {
    // If seeding silently wrote argon2id, everything below would pass for the wrong reason.
    expect(getUserHashAlgorithm(EMAIL)).toBe('$2b');
  });

  test('a bcrypt user is redirected to the reset screen and the redirect settles', async ({
    page,
  }) => {
    await signIn(page, OLD_PASSWORD);
    await expect(page).toHaveURL(/\/password-change/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: /update your password/i })).toBeVisible();
  });

  test('every dashboard route funnels to the reset screen', async ({ page }) => {
    await signIn(page, OLD_PASSWORD);
    for (const route of ['/proxy-hosts', '/certificates', '/profile']) {
      await page.goto(route);
      await expect(page).toHaveURL(/\/password-change/, { timeout: 15_000 });
    }
  });

  test('changing the password upgrades the hash and clears the gate', async ({ page }) => {
    await signIn(page, OLD_PASSWORD);
    await expect(page).toHaveURL(/\/password-change/, { timeout: 15_000 });

    await page.getByRole('textbox', { name: /^Current password/ }).fill(OLD_PASSWORD);
    await page.getByRole('textbox', { name: /^New password/ }).fill(NEW_PASSWORD);
    await page.getByRole('textbox', { name: /^Confirm new password/ }).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: /^save$/i }).click();

    await expect(page).not.toHaveURL(/\/password-change/, { timeout: 15_000 });
    expect(getUserHashAlgorithm(EMAIL)).toBe('$argon2id');

    // And stays there: the gate no longer matches on subsequent navigation.
    await page.goto('/proxy-hosts');
    await expect(page).toHaveURL(/\/proxy-hosts/);
  });

  test('the new password works on a fresh sign-in', async ({ page }) => {
    await signIn(page, OLD_PASSWORD);
    await page.getByRole('textbox', { name: /^Current password/ }).fill(OLD_PASSWORD);
    await page.getByRole('textbox', { name: /^New password/ }).fill(NEW_PASSWORD);
    await page.getByRole('textbox', { name: /^Confirm new password/ }).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page).not.toHaveURL(/\/password-change/, { timeout: 15_000 });

    await page.context().clearCookies();
    await signIn(page, NEW_PASSWORD);
    await expect(page).not.toHaveURL(/\/password-change/);
  });

  test('with the policy off, a bcrypt user is not gated at all', async ({ page }) => {
    clearSettingRow(POLICY_KEY);
    await signIn(page, OLD_PASSWORD);
    await page.goto('/proxy-hosts');
    await expect(page).toHaveURL(/\/proxy-hosts/);
    // Untouched: nothing rehashes behind the user's back.
    expect(getUserHashAlgorithm(EMAIL)).toBe('$2b');
  });
});
