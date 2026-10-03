/**
 * Passkeys end to end, on Chromium's virtual authenticator (CDP): added on Profile, then used to
 * sign in to the dashboard and through the forward-auth portal, with no password typed. Uses its
 * own account, so the admin every other spec runs as is untouched. Domain: passkey-portal.test
 */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import * as seed from '../helpers/seed';
import { waitForHydration } from '../helpers/hydration';
import { waitForStatus } from '../helpers/http';
import { signInWithCredentials } from '../helpers/sign-in';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://localhost:3000';
const API = `${BASE}/api/v1`;
const USERNAME = 'passkeytest';
const EMAIL = `${USERNAME}@localhost`;
const PASSWORD = 'PasskeyTest2026!';
const PORTAL_DOMAIN = 'passkey-portal.test';
// global-setup's admin session, for the API calls this file's own empty storage cannot make.
const ADMIN_STATE = resolve(dirname(fileURLToPath(import.meta.url)), '../.auth/admin.json');

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
let proxyHostId: number | null = null;

/**
 * A platform authenticator holding discoverable credentials, which verifies the user (a PIN or a
 * fingerprint) every time. Attached to the tab, so it survives navigation and signing out.
 */
async function attachAuthenticator(target: Page) {
  const cdp = await target.context().newCDPSession(target);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    credentials: async () =>
      (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials,
  };
}

/**
 * With automatic presence the virtual authenticator completes the username field's autofill
 * ceremony unprompted, ~100ms after hydration, racing any click. Conditional UI is off unless this
 * cookie is set, so each test drives exactly one ceremony.
 */
const AUTOFILL_COOKIE = 'e2e-passkey-autofill';

async function gateConditionalUi(target: BrowserContext) {
  await target.addInitScript((cookie) => {
    if (!window.PublicKeyCredential) return;
    PublicKeyCredential.isConditionalMediationAvailable = () =>
      Promise.resolve(document.cookie.includes(`${cookie}=1`));
  }, AUTOFILL_COOKIE);
}

async function admin(browser: Browser) {
  return (await browser.newContext({ storageState: ADMIN_STATE })).request;
}

test.describe('Passkeys', () => {
  let authenticator: Awaited<ReturnType<typeof attachAuthenticator>>;

  test.beforeAll(async ({ browser }) => {
    seed.ensureTestUser(USERNAME, PASSWORD, 'user');
    seed.clearPasskeys(EMAIL);
    context = await browser.newContext();
    await gateConditionalUi(context);
    page = await context.newPage();
    authenticator = await attachAuthenticator(page);
  });

  test.afterAll(async ({ browser }) => {
    seed.clearPasskeys(EMAIL);
    if (proxyHostId !== null) {
      const request = await admin(browser);
      await request.delete(`${API}/proxy-hosts/${proxyHostId}`, { headers: { Origin: BASE } });
    }
    await context?.close();
  });

  test('adds one from the Profile page, on a sign-in minutes old', async () => {
    await page.goto(`${BASE}/login`);
    await waitForHydration(page);
    await signInWithCredentials(page, USERNAME, PASSWORD);
    await page.waitForURL((url) => !url.pathname.includes('/login'));

    await page.goto(`${BASE}/profile`);
    await waitForHydration(page);
    await page.getByRole('button', { name: /^add a passkey$/i }).click();
    const dialog = page.getByRole('dialog', { name: /add a passkey/i });
    await dialog.getByLabel(/^name/i).fill('E2E authenticator');
    await dialog.getByRole('button', { name: /^add a passkey$/i }).click();

    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText('E2E authenticator')).toBeVisible({ timeout: 15_000 });
    expect(await authenticator.credentials()).toHaveLength(1);
  });

  test('signs in with it after signing out, with no username or password', async () => {
    await context.clearCookies();
    await page.goto(`${BASE}/login`);
    await waitForHydration(page);

    await page.getByRole('button', { name: /sign in with a passkey/i }).click();

    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15_000 });
    await page.goto(`${BASE}/profile`);
    await expect(page.getByText(EMAIL).first()).toBeVisible();
  });

  test('signs in from the username field autofill, with no click at all', async () => {
    await context.clearCookies();
    await context.addCookies([{ name: AUTOFILL_COOKIE, value: '1', url: BASE }]);
    try {
      await page.goto(`${BASE}/login`);
      await waitForHydration(page);
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15_000 });
      await page.goto(`${BASE}/profile`);
      await expect(page.getByText(EMAIL).first()).toBeVisible();
    } finally {
      await context.clearCookies({ name: AUTOFILL_COOKIE });
    }
  });

  test('signs in through the forward-auth portal', async ({ browser }) => {
    const request = await admin(browser);
    const created = await request.post(`${API}/proxy-hosts`, {
      data: {
        name: 'Passkey portal test',
        domains: [PORTAL_DOMAIN],
        upstreams: ['echo-server:8080'],
        sslForced: false,
        cpmForwardAuth: { enabled: true },
      },
      headers: { 'Content-Type': 'application/json', Origin: BASE },
    });
    expect(created.status()).toBe(201);
    proxyHostId = (await created.json()).id;
    const access = await request.put(`${API}/proxy-hosts/${proxyHostId}/forward-auth-access`, {
      data: { userIds: [seed.getUserId(EMAIL)], groupIds: [] },
      headers: { 'Content-Type': 'application/json', Origin: BASE },
    });
    expect(access.status()).toBe(200);
    await waitForStatus(PORTAL_DOMAIN, 302, 20_000);

    // Signed out, so the portal shows its form rather than exchanging a session straight away.
    await context.clearCookies();
    let redirectTo: string | null = null;
    await page.route('**/api/forward-auth/session-login', async (route) => {
      const response = await route.fetch();
      redirectTo ??= (await response.json()).redirectTo ?? null;
      // Not followed: the test domain resolves only through the test's own HTTP helper.
      await route.fulfill({ status: 200, json: {} });
    });
    await page.goto(`${BASE}/portal?rd=http://${PORTAL_DOMAIN}/`);
    await waitForHydration(page);

    await page.getByRole('button', { name: /sign in with a passkey/i }).click();

    await expect.poll(() => redirectTo, { timeout: 15_000 }).toContain('/.cpm-auth/callback');
    expect(redirectTo).toContain('code=');
    await page.unroute('**/api/forward-auth/session-login');
  });
});
