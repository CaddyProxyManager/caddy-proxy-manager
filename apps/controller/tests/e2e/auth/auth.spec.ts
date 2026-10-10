import { test, expect } from '@playwright/test';
import { waitForHydration } from '../../helpers/hydration';
import { signInWithCredentials, submitUsername } from '../../helpers/sign-in';

// Auth tests run WITHOUT pre-authenticated state
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Authentication', () => {
  test('unauthenticated access to / redirects to /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });

  test('unauthenticated access to /proxy-hosts redirects to /login', async ({ page }) => {
    await page.goto('/proxy-hosts');
    await expect(page).toHaveURL(/\/login/);
  });

  test('/login asks for the username first, then the password', async ({ page }) => {
    await page.goto('/login');
    await waitForHydration(page);

    await expect(page.getByRole('textbox', { name: /username/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^continue$/i })).toBeVisible();
    // Mounted from first paint so a password manager can fill both at once.
    await expect(page.getByRole('textbox', { name: /password/i })).toBeHidden();

    await submitUsername(page, 'testadmin');
    await expect(page.getByRole('textbox', { name: /password/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^sign in$/i })).toBeVisible();
  });

  test('/login step one advances for a username that does not exist', async ({ page }) => {
    // Refusing here would reveal whether the account exists.
    await page.goto('/login');
    await waitForHydration(page);

    await submitUsername(page, `nobody-${Date.now()}`);
    await expect(page.getByRole('textbox', { name: /password/i })).toBeVisible();
    await expect(page.getByRole('alert').first()).toBeHidden();
  });

  test('/login with wrong password shows an error message', async ({ page }) => {
    await page.goto('/login');
    // A pre-hydration native submit also stays on /login, so without this the test proves nothing.
    await waitForHydration(page);
    await signInWithCredentials(page, 'testadmin', 'WrongPassword!');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('text=/invalid|error|incorrect/i')).toBeVisible({ timeout: 5000 });
  });

  test('/login with correct credentials lands on dashboard', async ({ page }) => {
    await page.goto('/login');
    await waitForHydration(page);
    await signInWithCredentials(page, 'testadmin', 'TestPassword2026!');
    await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 });
  });

  test('logout redirects to /login on the correct host (not 0.0.0.0)', async ({ page }) => {
    // request.url inside Docker is 0.0.0.0, not BASE_URL.
    await page.goto('/login');
    await waitForHydration(page);
    await signInWithCredentials(page, 'testadmin', 'TestPassword2026!');
    await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 });

    await page.getByRole('button', { name: /log\s*out|sign\s*out/i }).click();

    await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
    const url = new URL(page.url());
    expect(url.hostname).not.toBe('0.0.0.0');
    expect(url.hostname).toBe('localhost');
  });

  test('hyphenated username passes validation (not rejected as invalid)', async ({ page }) => {
    // #112: better-auth's default validator rejected hyphens. 401 means it passed validation;
    // 422 would be the validator refusing the name.
    const res = await page.request.post('http://localhost:3000/api/auth/sign-in/username', {
      data: { username: 'test-hyphen', password: 'SomePassword123!' },
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
    });
    expect(res.status()).toBe(401);
  });

  test('email self-registration is disabled by default', async ({ page }) => {
    const res = await page.request.post('http://localhost:3000/api/auth/sign-up/email', {
      data: {
        name: 'Self Registration Test',
        email: `self-registration-${Date.now()}@test.invalid`,
        password: 'SelfRegistration2026!',
      },
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
    });

    expect(res.status()).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED',
    });

    // Nor is the form offered: the page sends a visitor back, and /login has no link to it.
    await page.goto('/login/sign-up');
    await expect(page).toHaveURL(/\/login$/);
    await waitForHydration(page);
    await expect(page.getByRole('link', { name: /create an account/i })).toHaveCount(0);
  });

  test('/login/sign-up creates an account and signs it in when self-registration is on', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      baseURL: 'http://localhost:3001',
      storageState: { cookies: [], origins: [] },
    });
    const page = await ctx.newPage();
    const email = `self-registration-form-${Date.now()}@test.invalid`;

    try {
      await page.goto('/login');
      await waitForHydration(page);
      await page.getByRole('link', { name: /create an account/i }).click();
      await expect(page).toHaveURL(/\/login\/sign-up$/);
      await waitForHydration(page);

      await page.getByRole('textbox', { name: /^name/i }).fill('Form Self Registration Test');
      await page.getByRole('textbox', { name: /email/i }).fill(email);
      await page.getByRole('textbox', { name: /^password/i }).fill('SelfRegistration2026!');
      await page.getByRole('textbox', { name: /confirm password/i }).fill('SelfRegistration2026!');
      await page.getByRole('button', { name: /^create account$/i }).click();

      await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 });
      const session = await page.request.get('/api/auth/get-session');
      expect(session.status()).toBe(200);
      await expect(session.json()).resolves.toMatchObject({ user: { email, role: 'user' } });
    } finally {
      await ctx.close();
    }
  });

  test('email self-registration can be enabled with AUTH_ALLOW_SELF_REGISTRATION', async ({
    playwright,
  }) => {
    const request = await playwright.request.newContext({
      baseURL: 'http://localhost:3001',
      extraHTTPHeaders: { Origin: 'http://localhost:3001' },
    });
    const email = `self-registration-enabled-${Date.now()}@test.invalid`;

    try {
      const signup = await request.post('/api/auth/sign-up/email', {
        data: {
          name: 'Enabled Self Registration Test',
          email,
          password: 'SelfRegistration2026!',
        },
      });

      expect(signup.status()).toBe(200);
      await expect(signup.json()).resolves.toMatchObject({
        user: {
          email,
          role: 'user',
          status: 'active',
        },
      });

      const session = await request.get('/api/auth/get-session');
      expect(session.status()).toBe(200);
      await expect(session.json()).resolves.toMatchObject({
        user: { email },
      });
    } finally {
      await request.dispose();
    }
  });
});
