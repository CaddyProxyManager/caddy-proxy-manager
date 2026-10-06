/**
 * LDAP end to end, against the `openldap` service (tests/ldap/seed.ldif): an administrator adds
 * and tests a directory in Settings, then its user signs in to the dashboard and through the
 * forward-auth portal on the ordinary form, with no password stored here. Domain: ldap-portal.test
 */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import * as seed from '../../helpers/seed';
import { goToSetting } from '../../helpers/settings-nav';
import { waitForHydration } from '../../helpers/hydration';
import { waitForStatus } from '../../helpers/http';
import { signInWithCredentials } from '../../helpers/sign-in';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://localhost:3000';
const API = `${BASE}/api/v1`;
const DIRECTORY = 'E2E Directory';
const LDAP_USER = 'ldap-alice';
const LDAP_EMAIL = 'ldap-alice@example.org';
const LDAP_PASSWORD = 'AliceDirectory2026!';
const PORTAL_DOMAIN = 'ldap-portal.test';
const ADMIN_STATE = resolve(dirname(fileURLToPath(import.meta.url)), '../../.auth/admin.json');

test.describe.configure({ mode: 'serial' });

let proxyHostId: number | null = null;

async function signedOut(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  return { context, page: await context.newPage() };
}

test.describe('LDAP directories', () => {
  // A directory turns the login form's fallback on for everyone, so none may outlive this file.
  test.beforeAll(() => {
    seed.clearLdapDirectories();
    seed.deleteUserByEmail(LDAP_EMAIL);
  });

  test.afterAll(async ({ browser }) => {
    if (proxyHostId !== null) {
      const context = await browser.newContext({ storageState: ADMIN_STATE });
      await context.request.delete(`${API}/proxy-hosts/${proxyHostId}`, {
        headers: { Origin: BASE },
      });
      await context.close();
    }
    seed.clearLdapDirectories();
    seed.deleteUserByEmail(LDAP_EMAIL);
  });

  test('an administrator adds a directory and tests it before saving', async ({ page }) => {
    await goToSetting(page, 'Directories (LDAP)');
    await page.getByRole('button', { name: /^add directory$/i }).click();
    const dialog = page.getByRole('dialog', { name: /add a directory/i });

    await dialog.getByLabel(/^name/i).fill(DIRECTORY);
    await dialog.getByLabel(/server address/i).fill('ldap://openldap:389');
    await dialog.getByLabel(/^base dn/i).fill('dc=example,dc=org');
    await dialog.getByLabel(/^bind dn/i).fill('cn=admin,dc=example,dc=org');
    await dialog.getByLabel(/^bind password/i).fill('admin');
    await dialog.getByRole('switch', { name: 'Assign roles from groups' }).click();
    await dialog.getByLabel(/^operator groups/i).fill('CPM Operators');

    await dialog.getByLabel(/^test username/i).fill(LDAP_USER);
    await dialog.getByLabel(/^test password/i).fill(LDAP_PASSWORD);
    await dialog.getByRole('button', { name: /^test$/i }).click();
    await expect(dialog.getByText(/the test user signed in/i)).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByText('CPM Operators')).toBeVisible();

    await dialog.getByRole('button', { name: /^add directory$/i }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(DIRECTORY, { exact: true })).toBeVisible();
  });

  test('its user signs in on the ordinary form, and gets the mapped role', async ({ browser }) => {
    const { context, page } = await signedOut(browser);
    try {
      await page.goto(`${BASE}/login`);
      await waitForHydration(page);
      // One directory: no selector, the form falls back to it by itself.
      await expect(page.getByRole('combobox', { name: /sign in with/i })).toHaveCount(0);
      await signInWithCredentials(page, LDAP_USER, LDAP_PASSWORD);
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 20_000 });

      await page.goto(`${BASE}/profile`);
      await waitForHydration(page);
      await expect(page.getByText(LDAP_EMAIL).first()).toBeVisible();
      await expect(page.getByText(`Your password is managed by ${DIRECTORY}`)).toBeVisible();
      await expect(page.getByRole('button', { name: /^set password$/i })).toHaveCount(0);
      expect(seed.getUserRecord(LDAP_EMAIL).role).toBe('operator');
    } finally {
      await context.close();
    }
  });

  test('a wrong directory password is refused like any other', async ({ browser }) => {
    const { context, page } = await signedOut(browser);
    try {
      await page.goto(`${BASE}/login`);
      await waitForHydration(page);
      await signInWithCredentials(page, LDAP_USER, 'not-the-password');
      await expect(page.getByText(/invalid username or password/i)).toBeVisible({
        timeout: 15_000,
      });
      expect(page.url()).toContain('/login');
    } finally {
      await context.close();
    }
  });

  test('its user signs in through the forward-auth portal', async ({ browser }) => {
    const admin = await browser.newContext({ storageState: ADMIN_STATE });
    const created = await admin.request.post(`${API}/proxy-hosts`, {
      data: {
        name: 'LDAP portal test',
        domains: [PORTAL_DOMAIN],
        upstreams: ['echo-server:8080'],
        sslForced: false,
        cpmForwardAuth: { enabled: true },
      },
      headers: { 'Content-Type': 'application/json', Origin: BASE },
    });
    expect(created.status()).toBe(201);
    proxyHostId = (await created.json()).id;
    const access = await admin.request.put(
      `${API}/proxy-hosts/${proxyHostId}/forward-auth-access`,
      {
        data: { userIds: [seed.getUserId(LDAP_EMAIL)], groupIds: [] },
        headers: { 'Content-Type': 'application/json', Origin: BASE },
      },
    );
    expect(access.status()).toBe(200);
    await admin.close();
    await waitForStatus(PORTAL_DOMAIN, 302, 20_000);

    const { context, page } = await signedOut(browser);
    try {
      let redirectTo: string | null = null;
      await page.route('**/api/forward-auth/login', async (route) => {
        const response = await route.fetch();
        redirectTo = (await response.json()).redirectTo ?? null;
        // Not followed: the test domain resolves only through the test's own HTTP helper.
        await route.fulfill({ status: 200, json: {} });
      });
      await page.goto(`${BASE}/portal?rd=http://${PORTAL_DOMAIN}/`);
      await waitForHydration(page);
      await signInWithCredentials(page, LDAP_USER, LDAP_PASSWORD);

      await expect.poll(() => redirectTo, { timeout: 15_000 }).toContain('/.cpm-auth/callback');
      expect(redirectTo).toContain('code=');
    } finally {
      await context.close();
    }
  });
});
