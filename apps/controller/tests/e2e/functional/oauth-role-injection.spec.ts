import { test, expect } from '@playwright/test';

/**
 * SECURITY-AUDIT H3: an OAuth IdP must not set privileged user fields. better-auth's generic-OAuth
 * signup spreads raw claims into the new user and ignores `input:false` on `role`/`status`. The
 * hostile IdP injects `role: "admin"` into every token; the created user must be role "user".
 */

const BASE_URL = 'http://localhost:3000';
const API = `${BASE_URL}/api/v1`;
const ORIGIN = BASE_URL;
const EVIL_EMAIL = 'evil@idp.example';

interface ApiUser {
  id: number;
  email: string;
  role: string;
}

async function findEvilUser(
  request: import('@playwright/test').APIRequestContext,
): Promise<ApiUser | undefined> {
  const resp = await request.get(`${API}/users`);
  expect(resp.ok(), 'list users').toBeTruthy();
  const users = (await resp.json()) as ApiUser[];
  return users.find((u) => u.email === EVIL_EMAIL);
}

test.describe('OAuth - a hostile IdP cannot inject a privileged role', () => {
  test.setTimeout(90_000);

  test('role:"admin" claim from the IdP does not create an admin account', async ({
    page,
    browser,
  }) => {
    const admin = page.request;

    // A leftover user from a previous run would make the result meaningless.
    const stale = await findEvilUser(admin);
    if (stale)
      await admin
        .delete(`${API}/users/${stale.id}`, { headers: { Origin: ORIGIN } })
        .catch(() => {});

    // Server-side URLs use the in-network alias (also the token `iss`); authorize the host port.
    const provName = `Mock Evil IdP ${Date.now()}`;
    const createResp = await admin.post(`${API}/oauth-providers`, {
      headers: { Origin: ORIGIN },
      data: {
        name: provName,
        type: 'oidc',
        clientId: 'cpm',
        clientSecret: 'secret',
        issuer: 'http://mock-oidc:8080/default',
        authorizationUrl: 'http://localhost:5557/default/authorize',
        tokenUrl: 'http://mock-oidc:8080/default/token',
        userinfoUrl: 'http://mock-oidc:8080/default/userinfo',
        scopes: 'openid email profile',
      },
    });
    expect(createResp.ok(), 'create oauth provider').toBeTruthy();
    const providerId = (await createResp.json()).id as number;

    let createdUserId: number | undefined;
    try {
      // An explicitly empty storageState: newContext() otherwise inherits the admin session.
      const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      const oauthPage = await ctx.newPage();
      try {
        await oauthPage.goto(`${BASE_URL}/login`);
        const button = oauthPage.getByRole('button', {
          name: new RegExp(`continue with ${provName}`, 'i'),
        });
        await expect(button).toBeVisible({ timeout: 15_000 });
        await button.click();

        // interactiveLogin:false auto-issues a code, landing back on "/".
        await oauthPage.waitForURL(
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
        expect(oauthPage.url(), 'OAuth sign-in should not error').not.toContain('error');
      } finally {
        await ctx.close();
      }

      const evil = await findEvilUser(admin);
      expect(evil, 'federated user should have been created').toBeDefined();
      createdUserId = evil!.id;
      expect(evil!.role, 'IdP-supplied role:"admin" must be ignored').toBe('user');
    } finally {
      if (createdUserId) {
        await admin
          .delete(`${API}/users/${createdUserId}`, { headers: { Origin: ORIGIN } })
          .catch(() => {});
      }
      await admin
        .delete(`${API}/oauth-providers/${providerId}`, { headers: { Origin: ORIGIN } })
        .catch(() => {});
    }
  });
});
