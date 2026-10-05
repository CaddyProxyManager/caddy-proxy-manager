/**
 * Account self-service and its administration: changing a password, a profile picture, a password
 * added to and removed from a Dex-only account, the admin two-factor policy, and an admin (or the
 * server console) resetting someone's second factor and passkeys. Each part uses its own account.
 */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as seed from '../../helpers/seed';
import { waitForHydration } from '../../helpers/hydration';
import { signInWithCredentials } from '../../helpers/sign-in';
import { applyStagedChanges, expectStaged } from '../../helpers/staged-settings';
import { turnOnTwoFactor } from '../../helpers/two-factor';

const BASE = 'http://localhost:3000';
const API = `${BASE}/api/v1`;

async function freshContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ storageState: { cookies: [], origins: [] } });
}

async function signIn(browser: Browser, username: string, password: string): Promise<Page> {
  const page = await (await freshContext(browser)).newPage();
  await page.goto(`${BASE}/login`);
  await waitForHydration(page);
  await signInWithCredentials(page, username, password);
  return page;
}

async function passwordWorks(browser: Browser, username: string, password: string) {
  const ctx = await freshContext(browser);
  try {
    const res = await ctx.request.post(`${BASE}/api/auth/sign-in/username`, {
      headers: { Origin: BASE },
      data: { username, password },
    });
    // 200 with twoFactorRedirect when a code is still wanted.
    return { ok: res.status() === 200, body: res.ok() ? await res.json() : null };
  } finally {
    await ctx.close();
  }
}

async function openUser(page: Page, email: string) {
  await page.goto('/users');
  await waitForHydration(page);
  await page
    .getByRole('navigation', { name: 'Users' })
    .getByRole('listitem')
    .filter({ hasText: email })
    .click();
  await expect(page.getByText(email).nth(1)).toBeVisible();
}

test.describe('Profile - password and picture', () => {
  const USER = { username: 'accountsectest', password: 'AccountSecOld2026!' };
  const NEW_PASSWORD = 'AccountSecNew2026!';

  test.beforeEach(() => seed.ensureTestUser(USER.username, USER.password, 'user'));

  test('a password change is policed, then takes effect', async ({ browser }) => {
    const page = await signIn(browser, USER.username, USER.password);
    await page.waitForURL((url) => !url.pathname.includes('/login'));

    // The server enforces the policy whatever the form does.
    const weak = await page.request.post(`${BASE}/api/user/change-password`, {
      headers: { Origin: BASE },
      data: { currentPassword: USER.password, newPassword: 'nouppercase2026!' },
    });
    expect(weak.status()).toBe(400);
    expect((await weak.json()).error).toMatch(/uppercase and lowercase/i);

    await page.goto('/profile');
    await waitForHydration(page);
    await page.getByRole('button', { name: /^change password$/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Current Password', { exact: true }).fill(USER.password);
    await dialog.getByLabel('New Password', { exact: true }).fill(NEW_PASSWORD);
    await dialog.getByLabel('Confirm New Password', { exact: true }).fill(NEW_PASSWORD);
    await dialog.getByRole('button', { name: /^change password$/i }).click();
    await expect(page.getByText(/password changed successfully/i)).toBeVisible({
      timeout: 15_000,
    });
    await page.context().close();

    expect((await passwordWorks(browser, USER.username, USER.password)).ok).toBe(false);
    expect((await passwordWorks(browser, USER.username, NEW_PASSWORD)).ok).toBe(true);
  });

  test('a profile picture uploads, persists, and is removed', async ({ browser, request }) => {
    const page = await signIn(browser, USER.username, USER.password);
    await page.waitForURL((url) => !url.pathname.includes('/login'));
    const id = seed.getUserId(`${USER.username}@localhost`);
    const avatarOf = async () =>
      ((await (await request.get(`${API}/users/${id}`)).json()) as { avatarUrl: string | null })
        .avatarUrl;

    await page.goto('/profile');
    await waitForHydration(page);
    // A 1x1 PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByText(/avatar updated/i)).toBeVisible({ timeout: 15_000 });
    await expect.poll(avatarOf).toMatch(/^data:image\/png;base64,/);

    await page.reload();
    await waitForHydration(page);
    await page.getByRole('button', { name: /remove profile picture/i }).click();
    await expect(page.getByText(/avatar removed/i)).toBeVisible({ timeout: 15_000 });
    await expect.poll(avatarOf).toBeNull();

    await page.context().close();
  });
});

test.describe('An OAuth-only account (Dex)', () => {
  const CAROL = { email: 'carol@test.local', password: 'password' };
  const LOCAL_PASSWORD = 'CarolLocal2026!pw';

  test.beforeAll(() => seed.deleteUserByEmail(CAROL.email));
  test.afterAll(() => seed.deleteUserByEmail(CAROL.email));

  test('adds a password after signing in with Dex, then removes it again', async ({ browser }) => {
    test.setTimeout(90_000);
    const page = await (await freshContext(browser)).newPage();
    await page.goto(`${BASE}/login`);
    await waitForHydration(page);
    await page.getByRole('button', { name: /continue with dex/i }).click();
    await page.waitForURL((url) => url.port === '5556', { timeout: 20_000 });
    const emailLogin = page.getByRole('link', { name: /log in with email/i });
    if (await emailLogin.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await emailLogin.click();
    }
    await page.getByRole('textbox', { name: /email/i }).fill(CAROL.email);
    await page.getByRole('textbox', { name: /password/i }).fill(CAROL.password);
    await page.getByRole('button', { name: /login/i }).click();
    await page.waitForURL((url) => url.port === '3000' && !url.pathname.startsWith('/login'), {
      timeout: 30_000,
    });

    await page.goto('/profile');
    await waitForHydration(page);
    await expect(page.getByText(/you are using oauth-only authentication/i)).toBeVisible();

    // A fresh Dex sign-in is the proof a first password asks for.
    await page.getByRole('button', { name: /^set password$/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('New Password', { exact: true }).fill(LOCAL_PASSWORD);
    await dialog.getByLabel('Confirm New Password', { exact: true }).fill(LOCAL_PASSWORD);
    await dialog.getByRole('button', { name: /^set password$/i }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await page.reload();
    await waitForHydration(page);
    await expect(page.getByText('Password is set')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /^remove password$/i }).click();
    const remove = page.getByRole('dialog', { name: /remove password/i });
    await expect(remove).toContainText('Dex');
    await remove.getByLabel(/current password/i).fill(LOCAL_PASSWORD);
    await remove.getByRole('button', { name: /^remove password$/i }).click();
    await expect(page.getByText(/password removed/i)).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await waitForHydration(page);
    await expect(page.getByText(/you are using oauth-only authentication/i)).toBeVisible({
      timeout: 15_000,
    });
    expect(seed.getUserHashAlgorithm(CAROL.email)).toBe('');
    await page.context().close();
  });
});

test.describe('Admin two-factor policy', () => {
  const ADMIN2 = { username: 'tfapolicyadmin', password: 'TfaPolicyAdmin2026!' };
  const EMAIL = `${ADMIN2.username}@localhost`;

  test.beforeAll(() => {
    seed.ensureTestUser(ADMIN2.username, ADMIN2.password, 'admin');
    seed.resetTwoFactor(EMAIL);
  });

  // Straight to the row: while the policy stands, the suite's own admin is caught by it too.
  test.afterAll(() => {
    seed.clearSettingRow('two_factor_policy');
    seed.resetTwoFactor(EMAIL);
    seed.deleteUserByEmail(EMAIL);
  });

  test('an administrator without an authenticator must enrol before anything else', async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/settings/authentication');
    await waitForHydration(page);
    const toggle = page.getByRole('switch', {
      name: /require two-factor sign-in for administrators/i,
    });
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    await page.getByTestId('settings-page-save').click({ force: true });
    await expectStaged(page);
    await applyStagedChanges(page);

    const admin2 = await signIn(browser, ADMIN2.username, ADMIN2.password);
    await admin2.waitForURL(/\/two-factor-setup$/, { timeout: 20_000 });
    await admin2.goto('/proxy-hosts');
    await expect(admin2).toHaveURL(/\/two-factor-setup$/);
    const api = await admin2.request.get(`${API}/proxy-hosts`);
    expect(api.status()).toBe(403);

    await waitForHydration(admin2);
    await turnOnTwoFactor(admin2, ADMIN2.password);
    await admin2.waitForURL((url) => !url.pathname.startsWith('/two-factor-setup'), {
      timeout: 20_000,
    });
    expect((await admin2.request.get(`${API}/proxy-hosts`)).status()).toBe(200);
    await admin2.context().close();

    // The policy is no respecter of persons: the suite's admin has no authenticator either.
    await page.goto('/proxy-hosts');
    await expect(page).toHaveURL(/\/two-factor-setup$/);
  });
});

test.describe('Resetting a second factor and passkeys', () => {
  const USER = { username: 'tfaresettest', password: 'TfaResetTest2026!' };
  const EMAIL = `${USER.username}@localhost`;

  test.beforeEach(async ({ browser }) => {
    seed.ensureTestUser(USER.username, USER.password, 'user');
    seed.resetTwoFactor(EMAIL);
    seed.clearPasskeys(EMAIL);
    const page = await signIn(browser, USER.username, USER.password);
    await page.waitForURL((url) => !url.pathname.includes('/login'));
    await page.goto('/profile');
    await waitForHydration(page);
    await turnOnTwoFactor(page, USER.password);
    await page.context().close();
    expect(
      (await passwordWorks(browser, USER.username, USER.password)).body?.twoFactorRedirect,
    ).toBe(true);
  });

  test.afterAll(() => {
    seed.resetTwoFactor(EMAIL);
    seed.clearPasskeys(EMAIL);
  });

  test('an admin resets both from the Users page', async ({ page, browser }) => {
    // Listed and removed by the admin action; what signs in with it is passkeys.spec.ts's concern.
    seed.runSeedScript(`
      const [user] = await sql\`SELECT id FROM users WHERE email = \${${JSON.stringify(EMAIL)}}\`;
      await sql\`INSERT INTO passkeys (name, "publicKey", "userId", "credentialID", counter,
                 "deviceType", "backedUp", "createdAt")
                 VALUES ('E2E key', 'pk', \${user.id}, \${${JSON.stringify(`cred-${Date.now()}`)}}, 0,
                 'singleDevice', false, \${new Date().toISOString()})\`;
      await sql.close();
    `);

    await openUser(page, EMAIL);
    const detail = page.getByRole('main');
    await detail.getByRole('button', { name: /^reset two-factor sign-in$/i }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: /^reset two-factor sign-in$/i })
      .click();
    await expect(page.getByRole('alertdialog')).toBeHidden({ timeout: 15_000 });
    await expect(detail.getByRole('button', { name: /^reset two-factor sign-in$/i })).toHaveCount(
      0,
    );

    await expect(detail.getByText('1 passkey')).toBeVisible();
    await detail.getByRole('button', { name: /^remove passkeys$/i }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: /^remove passkeys$/i })
      .click();
    await expect(page.getByRole('alertdialog')).toBeHidden({ timeout: 15_000 });
    await expect(detail.getByRole('button', { name: /^remove passkeys$/i })).toHaveCount(0);

    const after = await passwordWorks(browser, USER.username, USER.password);
    expect(after.ok).toBe(true);
    expect(after.body?.twoFactorRedirect ?? false, 'no code asked for any more').toBe(false);
  });

  test('the server console resets it with cpm-server --reset-2fa', async ({ browser }) => {
    const output = execFileSync(
      'docker',
      ['exec', 'caddy-proxy-manager-web', '/app/cpm-server', '--reset-2fa', USER.username],
      { encoding: 'utf8' },
    );
    expect(output).toContain(USER.username);
    const after = await passwordWorks(browser, USER.username, USER.password);
    expect(after.ok).toBe(true);
    expect(after.body?.twoFactorRedirect ?? false).toBe(false);

    // An unknown account is an error, not a silent success.
    let failed = false;
    try {
      execFileSync(
        'docker',
        [
          'exec',
          'caddy-proxy-manager-web',
          '/app/cpm-server',
          '--reset-2fa',
          'no-such-user-anywhere',
        ],
        { stdio: 'pipe' },
      );
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
