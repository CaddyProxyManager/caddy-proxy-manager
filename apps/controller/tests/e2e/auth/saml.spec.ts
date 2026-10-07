/**
 * SAML against a real IdP: the stack's Keycloak (tests/keycloak/cpm-realm.json, client `cpm-saml`,
 * which signs its assertions). An administrator adds the provider from the IdP's descriptor - read
 * at run time, since Keycloak makes a new realm key on every import - and kc-alice signs in through
 * it, landing with the role her Keycloak group maps to.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { clearSamlProviders, deleteUserByEmail } from '../../helpers/seed';
import { goToSetting, savePage } from '../../helpers/settings-nav';
import { applyStagedChanges } from '../../helpers/staged-settings';
import { waitForHydration } from '../../helpers/hydration';
import {
  KC_USER,
  launchKeycloakBrowser,
  logoutUserEverywhere,
  newSignedOutContext,
  signInThroughKeycloak,
} from '../../helpers/keycloak';

const BASE_URL = 'http://localhost:3000';
const DESCRIPTOR = 'http://localhost:8180/realms/cpm/protocol/saml/descriptor';
// The Keycloak client's id, which is the audience its assertions name.
const SP_ENTITY_ID = 'cpm-saml';

async function signedInEmail(page: Page): Promise<string | null> {
  const res = await page.request.get(`${BASE_URL}/api/auth/get-session`);
  if (!res.ok()) return null;
  const body = (await res.json().catch(() => null)) as { user?: { email?: string } } | null;
  return body?.user?.email ?? null;
}

test.describe('SAML single sign-on (Keycloak)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  let kcBrowser: Browser;
  const providerName = `Keycloak SAML ${Date.now()}`;

  test.beforeAll(async () => {
    clearSamlProviders();
    deleteUserByEmail(KC_USER.email);
    kcBrowser = await launchKeycloakBrowser();
  });

  test.afterAll(async () => {
    await kcBrowser?.close();
    await logoutUserEverywhere().catch(() => {});
    clearSamlProviders();
    deleteUserByEmail(KC_USER.email);
  });

  test('an administrator adds the provider from its metadata', async ({ page }) => {
    const descriptor = await (await fetch(DESCRIPTOR)).text();
    expect(descriptor).toContain('IDPSSODescriptor');

    await goToSetting(page, 'Single sign-on providers');
    await page.getByRole('button', { name: /add provider/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^name/i).fill(providerName);
    await dialog.getByRole('combobox', { name: /^type/i }).click();
    await page.getByRole('option', { name: 'SAML 2.0', exact: true }).click();
    await dialog.getByLabel(/^metadata xml/i).fill(descriptor);
    await dialog.getByLabel(/^service provider entity id/i).fill(SP_ENTITY_ID);
    await dialog.getByRole('switch', { name: /assign roles from groups/i }).click();
    await dialog.getByLabel(/^operator groups/i).fill('cpm-saml-operators');
    await dialog.getByRole('button', { name: /^create$/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(providerName)).toBeVisible({ timeout: 10_000 });
  });

  test('the sign-in overview lists it as SAML', async ({ page }) => {
    await page.goto('/users/sign-in');
    await waitForHydration(page);
    await expect(page.getByRole('list').getByText(providerName)).toBeVisible();
    await expect(page.getByText('Single sign-on (SAML)').first()).toBeVisible();
  });

  test('kc-alice signs in through Keycloak, as the role her group maps to', async ({ page }) => {
    const ctx = await newSignedOutContext(kcBrowser);
    const user = await ctx.newPage();
    try {
      await signInThroughKeycloak(user, BASE_URL, providerName);
      await expect.poll(() => signedInEmail(user), { timeout: 15_000 }).toBe(KC_USER.email);

      const users = await page.request.get(`${BASE_URL}/api/v1/users`);
      expect(users.ok()).toBe(true);
      const list = (await users.json()) as Array<{ email: string; role: string }>;
      expect(list.find((row) => row.email === KC_USER.email)?.role).toBe('operator');
    } finally {
      await ctx.close();
    }
  });

  test('enforced single sign-on still lets SAML in, and the overview says so', async ({ page }) => {
    await goToSetting(page, 'Single sign-on enforcement');
    await page.getByRole('switch', { name: /^require single sign-on/i }).click();
    await savePage(page);
    // Staged, like the rest of the page, until applied.
    await applyStagedChanges(page);

    await page.goto('/users/sign-in');
    await waitForHydration(page);
    await expect(page.getByText('Enforced', { exact: true }).first()).toBeVisible();

    await logoutUserEverywhere().catch(() => {});
    const ctx = await newSignedOutContext(kcBrowser);
    const user = await ctx.newPage();
    try {
      await signInThroughKeycloak(user, BASE_URL, providerName);
      await expect.poll(() => signedInEmail(user), { timeout: 15_000 }).toBe(KC_USER.email);
    } finally {
      await ctx.close();
      clearSamlProviders();
    }
  });
});
