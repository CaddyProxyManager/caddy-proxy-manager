import { test, expect } from '@playwright/test';
import { waitForHydration } from '../../helpers/hydration';

/**
 * #261: Better Auth's `accounts` rows must be projected onto `users.provider`/`subject`, which the
 * Profile page reads. Three mock issuers (linker-a/b/c) issue the admin's email with distinct
 * `sub`s, so each test links a fresh identity regardless of cleanup order.
 */

const BASE_URL = 'http://localhost:3000';
const API = `${BASE_URL}/api/v1`;
const ORIGIN = BASE_URL;
const ADMIN_EMAIL = 'testadmin@localhost';
// docker-compose.test.yml's ADMIN_PASSWORD; unlinking asks for it again.
const ADMIN_PASSWORD = 'TestPassword2026!';

interface ApiUser {
  id: number;
  email: string;
  role: string;
  provider: string | null;
  subject: string | null;
}

interface ApiProvider {
  id: string;
  name: string;
  autoLink: boolean;
}

async function getAdminUser(
  request: import('@playwright/test').APIRequestContext,
): Promise<ApiUser> {
  const resp = await request.get(`${API}/users`);
  expect(resp.ok(), 'list users').toBeTruthy();
  const users = (await resp.json()) as ApiUser[];
  const admin = users.find((u) => u.email === ADMIN_EMAIL);
  expect(admin, 'admin user exists').toBeDefined();
  return admin!;
}

async function createLinkerProvider(
  request: import('@playwright/test').APIRequestContext,
  issuerId: string,
): Promise<ApiProvider> {
  const name = `Link IdP ${issuerId} ${Date.now()}`;
  const createResp = await request.post(`${API}/oauth-providers`, {
    headers: { Origin: ORIGIN },
    data: {
      name,
      type: 'oidc',
      clientId: 'cpm',
      clientSecret: 'secret',
      issuer: `http://mock-oidc:8080/${issuerId}`,
      authorizationUrl: `http://localhost:5557/${issuerId}/authorize`,
      tokenUrl: `http://mock-oidc:8080/${issuerId}/token`,
      userinfoUrl: `http://mock-oidc:8080/${issuerId}/userinfo`,
      scopes: 'openid email profile',
      autoLink: true,
    },
  });
  expect(createResp.ok(), 'create oauth provider').toBeTruthy();
  const provider = (await createResp.json()) as ApiProvider;
  expect(provider.autoLink, 'provider created with auto-link').toBe(true);
  return provider;
}

async function deleteProvider(
  request: import('@playwright/test').APIRequestContext,
  providerId: string,
) {
  await request
    .delete(`${API}/oauth-providers/${providerId}`, { headers: { Origin: ORIGIN } })
    .catch(() => {});
}

async function unlinkAdmin(request: import('@playwright/test').APIRequestContext) {
  await request
    .post(`${BASE_URL}/api/user/unlink-oauth`, {
      headers: { Origin: ORIGIN },
      data: { currentPassword: ADMIN_PASSWORD },
    })
    .catch(() => {});
}

/** In a sessionless context; the mock IdP auto-issues the code, so no interaction is needed. */
async function oauthSignInAsAdmin(
  browser: import('@playwright/test').Browser,
  providerName: string,
) {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE_URL}/login`);
    const button = page.getByRole('button', {
      name: new RegExp(`continue with ${providerName}`, 'i'),
    });
    await expect(button).toBeVisible({ timeout: 15_000 });
    await button.click();

    await page.waitForURL(
      (url) => {
        try {
          const u = new URL(url);
          return (
            u.origin === BASE_URL &&
            !u.pathname.startsWith('/api/auth') &&
            !u.pathname.startsWith('/login')
          );
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    );
    expect(page.url(), 'OAuth sign-in should not error').not.toContain('error');
  } finally {
    await ctx.close();
  }
}

test.describe('OAuth link/unlink synchronizes the CPM user state (#261)', () => {
  const providerIds: string[] = [];

  test.afterEach(async ({ request }) => {
    // Even on failure, or the admin identity is poisoned for the rest of the suite.
    await unlinkAdmin(request);
    for (const id of providerIds.splice(0)) {
      await deleteProvider(request, id);
    }
  });

  test('auto-link via OAuth sign-in updates users.provider/subject and the Profile page', async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    const admin = page.request;
    const provider = await createLinkerProvider(admin, 'linker-a');
    providerIds.push(provider.id);

    await oauthSignInAsAdmin(browser, provider.name);

    const adminUser = await getAdminUser(admin);
    expect(adminUser.provider, 'users.provider must reflect the linked OAuth identity').toBe(
      provider.id,
    );
    expect(adminUser.subject, 'users.subject must carry the IdP sub claim').toBe('linker-sub-a');

    await page.goto('/profile');
    await expect(page.getByText(/your account is linked to/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(provider.name).first()).toBeVisible();
  });

  test('linking from the Profile page completes and is reflected', async ({ page }) => {
    test.setTimeout(90_000);
    const admin = page.request;
    const provider = await createLinkerProvider(admin, 'linker-b');
    providerIds.push(provider.id);

    await page.goto('/profile');
    const linkButton = page.getByRole('button', {
      name: new RegExp(`^link ${provider.name}$`, 'i'),
    });
    await expect(linkButton).toBeVisible({ timeout: 15_000 });
    await linkButton.click();

    await expect(page.getByText(/your account is linked to/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(provider.name).first()).toBeVisible();

    const adminUser = await getAdminUser(admin);
    expect(adminUser.provider).toBe(provider.id);
    expect(adminUser.subject).toBe('linker-sub-b');
  });

  test('unlinking resets users.provider/subject and the Profile page', async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    const admin = page.request;
    const provider = await createLinkerProvider(admin, 'linker-c');
    providerIds.push(provider.id);

    await oauthSignInAsAdmin(browser, provider.name);
    expect((await getAdminUser(admin)).provider).toBe(provider.id);

    await page.goto('/profile');
    const unlinkButton = page.getByRole('button', { name: /^unlink$/i });
    await expect(unlinkButton).toBeVisible({ timeout: 15_000 });
    // Visible from the server render; a click before hydration opens nothing.
    await waitForHydration(page);
    await unlinkButton.click();
    // Scoped: the password forms carry a current-password field too.
    const unlinkDialog = page.getByRole('dialog', { name: /unlink oauth account/i });
    await unlinkDialog.getByLabel(/current password/i).fill(ADMIN_PASSWORD);
    await unlinkDialog.getByRole('button', { name: /^unlink$/i }).click();

    await expect(page.getByText(/link an oauth provider to enable single sign-on/i)).toBeVisible({
      timeout: 30_000,
    });

    const adminUser = await getAdminUser(admin);
    expect(adminUser.provider, 'users.provider must fall back to credentials').toBe('credentials');
    expect(adminUser.subject, 'users.subject must be cleared').toBeNull();
    // A later sign-in may re-link while auto-link is on; that is by design.
  });
});
