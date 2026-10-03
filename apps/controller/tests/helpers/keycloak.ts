/**
 * The stack's Keycloak (tests/keycloak/cpm-realm.json). Its issuer names `keycloak:8180`, which web
 * resolves on the Compose network and a browser from `launchKeycloakBrowser` maps to the host port.
 */
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { waitForHydration } from './hydration';

export const KEYCLOAK_ISSUER = 'http://keycloak:8180/realms/cpm';
const ADMIN_BASE = 'http://localhost:8180';
export const KC_USER = {
  username: 'kc-alice',
  password: 'KcAlicePassword2026!',
  email: 'kc-alice@idp.example',
};

/** A browser that resolves `keycloak` as the host port does. Close it yourself. */
export function launchKeycloakBrowser(): Promise<Browser> {
  return chromium.launch({ args: ['--host-resolver-rules=MAP keycloak 127.0.0.1'] });
}

/**
 * Explicitly signed out: Playwright Test hands its `use` options, the admin's storageState
 * included, to contexts of browsers a spec launches itself.
 */
export function newSignedOutContext(browser: Browser) {
  return browser.newContext({ storageState: { cookies: [], origins: [] }, timezoneId: 'UTC' });
}

export function keycloakProviderBody(name: string) {
  return {
    name,
    type: 'oidc',
    clientId: 'cpm',
    clientSecret: 'cpm-keycloak-secret',
    // Discovery only, so every endpoint is Keycloak's own.
    issuer: KEYCLOAK_ISSUER,
    scopes: 'openid email profile',
  };
}

async function adminToken(): Promise<string> {
  const res = await fetch(`${ADMIN_BASE}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: 'admin',
      password: 'e2e-keycloak-admin',
    }),
  });
  expect(res.ok, `keycloak admin token: ${res.status}`).toBe(true);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function admin(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await adminToken();
  return fetch(`${ADMIN_BASE}/admin/realms/cpm${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

async function userId(): Promise<string> {
  const res = await admin(`/users?exact=true&username=${KC_USER.username}`);
  const [user] = (await res.json()) as { id: string }[];
  expect(user, 'realm user').toBeDefined();
  return user.id;
}

export async function listUserSessions(): Promise<{ id: string }[]> {
  const res = await admin(`/users/${await userId()}/sessions`);
  expect(res.ok).toBe(true);
  return (await res.json()) as { id: string }[];
}

/** Every session of the user, which Keycloak follows with back-channel logout tokens. */
export async function logoutUserEverywhere(): Promise<void> {
  const res = await admin(`/users/${await userId()}/logout`, { method: 'POST' });
  expect(res.status, 'keycloak user logout').toBe(204);
}

/** One Keycloak session, which names only its own `sid` in the logout token. */
export async function endSession(sessionId: string): Promise<void> {
  const res = await admin(`/sessions/${sessionId}`, { method: 'DELETE' });
  expect(res.status, 'keycloak session delete').toBe(204);
}

/** From CPM's login page through Keycloak's form and back, signed in. */
export async function signInThroughKeycloak(
  page: Page,
  baseUrl: string,
  providerName: string,
): Promise<void> {
  await page.goto(`${baseUrl}/login`);
  await waitForHydration(page);
  const button = page.getByRole('button', {
    name: new RegExp(`continue with ${providerName}`, 'i'),
  });
  await expect(button).toBeVisible({ timeout: 15_000 });
  await button.click();
  await page.waitForURL((url) => url.host === 'keycloak:8180', { timeout: 30_000 });
  await page.locator('#username').fill(KC_USER.username);
  await page.locator('#password').fill(KC_USER.password);
  await page.locator('#kc-login').click();
  await page.waitForURL(
    (url) =>
      url.origin === baseUrl &&
      !url.pathname.startsWith('/api/auth') &&
      !url.pathname.startsWith('/login'),
    { timeout: 30_000 },
  );
}
