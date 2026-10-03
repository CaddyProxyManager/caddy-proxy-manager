/**
 * OIDC Back-Channel Logout against a real IdP: sign in through Keycloak, end the session there, and
 * CPM's own session is gone, delivered by Keycloak's POST to /api/auth/oidc/backchannel-logout.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { deleteUserByEmail } from '../../helpers/seed';
import {
  KC_USER,
  endSession,
  keycloakProviderBody,
  launchKeycloakBrowser,
  listUserSessions,
  logoutUserEverywhere,
  newSignedOutContext,
  signInThroughKeycloak,
} from '../../helpers/keycloak';

const BASE_URL = 'http://localhost:3000';
const API = `${BASE_URL}/api/v1`;
const ORIGIN = BASE_URL;

/** The session list answers only a live session. */
async function signedIn(page: Page): Promise<boolean> {
  const res = await page.request.get(`${BASE_URL}/api/v1/sessions`);
  return res.ok();
}

test.describe('OIDC back-channel logout (Keycloak)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  let kcBrowser: Browser;
  let providerId: string;
  const providerName = `Keycloak ${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    deleteUserByEmail(KC_USER.email);
    const created = await request.post(`${API}/oauth-providers`, {
      headers: { Origin: ORIGIN },
      data: keycloakProviderBody(providerName),
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    providerId = (await created.json()).id;
    kcBrowser = await launchKeycloakBrowser();
  });

  test.afterAll(async ({ request }) => {
    await kcBrowser?.close();
    await logoutUserEverywhere().catch(() => {});
    if (providerId) {
      await request.delete(`${API}/oauth-providers/${providerId}`, { headers: { Origin: ORIGIN } });
    }
    deleteUserByEmail(KC_USER.email);
  });

  test('a garbage logout token is refused with the spec error shape', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/auth/oidc/backchannel-logout`, {
      form: { logout_token: 'not-a-jwt' },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
    expect(res.headers()['cache-control']).toBe('no-store');
  });

  test('ending the Keycloak session ends the CPM session', async ({ page }) => {
    const ctx = await newSignedOutContext(kcBrowser);
    const user = await ctx.newPage();
    try {
      await signInThroughKeycloak(user, BASE_URL, providerName);
      await user.goto(`${BASE_URL}/profile`);
      await expect(user.getByText(KC_USER.email).first()).toBeVisible({ timeout: 15_000 });
      expect(await signedIn(user)).toBe(true);

      await logoutUserEverywhere();

      await expect.poll(() => signedIn(user), { timeout: 30_000 }).toBe(false);
      await user.goto(`${BASE_URL}/profile`);
      await expect(user).toHaveURL(/\/login/);

      const audit = await page.request.get(`${API}/audit-log?per_page=50`);
      expect(JSON.stringify(await audit.json())).toContain('back-channel logout');
    } finally {
      await ctx.close();
    }
  });

  test('a session-scoped logout ends only the CPM session bound to that sid', async () => {
    const first = await newSignedOutContext(kcBrowser);
    const second = await newSignedOutContext(kcBrowser);
    try {
      const a = await first.newPage();
      await signInThroughKeycloak(a, BASE_URL, providerName);
      const [sessionA] = await listUserSessions();
      expect(sessionA).toBeDefined();

      const b = await second.newPage();
      await signInThroughKeycloak(b, BASE_URL, providerName);
      expect(await listUserSessions()).toHaveLength(2);

      await endSession(sessionA.id);

      await expect.poll(() => signedIn(a), { timeout: 30_000 }).toBe(false);
      expect(await signedIn(b), 'the other device keeps its session').toBe(true);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
