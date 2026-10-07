/**
 * E2E: an administrator makes a SCIM connection on Users -> Provisioning, copies its token once,
 * an identity provider provisions an account and a mapped group with it, and deactivating the
 * account through SCIM disables it. The e2e stack runs on PostgreSQL, which SCIM needs.
 */
import { test, expect, type PlaywrightWorkerArgs } from '@playwright/test';
import { runSeedScript } from '../../helpers/seed';
import { waitForHydration } from '../../helpers/hydration';

const CONNECTION = 'E2E identity provider';
const EMAIL = 'scim.e2e@example.com';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

/** Without the admin's cookie: Better Auth refuses a cookie-bearing POST that has no Origin. */
function idpRequest(playwright: PlaywrightWorkerArgs['playwright']) {
  return playwright.request.newContext({
    baseURL: 'http://localhost:3000',
    storageState: { cookies: [], origins: [] },
  });
}

function cleanUp(): void {
  runSeedScript(`
    await sql\`DELETE FROM scim_connections WHERE name = \${${JSON.stringify(CONNECTION)}}\`;
    await sql\`DELETE FROM groups WHERE name = 'E2E Operators'\`;
    await sql\`DELETE FROM users WHERE email = \${${JSON.stringify(EMAIL)}}\`;
    await sql.close();
  `);
}

test.describe('SCIM provisioning', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(cleanUp);
  test.afterAll(cleanUp);

  let token = '';

  test('an administrator makes a connection and sees its token once', async ({ page }) => {
    await page.goto('/users/provisioning');
    await waitForHydration(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Provisioning' })).toBeVisible();

    await page.getByRole('button', { name: 'New' }).click();
    const dialog = page.getByRole('dialog', { name: 'New SCIM connection' });
    await dialog.getByLabel('Name').fill(CONNECTION);
    await dialog.getByLabel('Operator').fill('E2E Operators');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();

    await expect(page.getByText('Copy this token now.', { exact: false })).toBeVisible();
    token = (await page.locator('code', { hasText: 'cpm_scim_' }).first().innerText()).trim();
    expect(token.startsWith('cpm_scim_')).toBe(true);
    await expect(page.getByRole('cell', { name: new RegExp(`^${CONNECTION}`) })).toBeVisible();

    await page.getByRole('button', { name: 'Done' }).click();
    await page.reload();
    await waitForHydration(page);
    await expect(page.getByText('cpm_scim_')).toHaveCount(0);
  });

  test('the identity provider provisions, groups and deactivates an account', async ({
    playwright,
  }) => {
    const request = await idpRequest(playwright);
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/scim+json',
    };
    const created = await request.post('/api/auth/scim/v2/Users', {
      headers,
      data: {
        schemas: [USER_SCHEMA],
        userName: EMAIL,
        emails: [{ value: EMAIL, primary: true }],
        active: true,
      },
    });
    expect(created.status()).toBe(201);
    const user = await created.json();

    const group = await request.post('/api/auth/scim/v2/Groups', {
      headers,
      data: {
        schemas: [GROUP_SCHEMA],
        displayName: 'E2E Operators',
        members: [{ value: user.id }],
      },
    });
    expect(group.status()).toBe(201);

    const deactivated = await request.patch(`/api/auth/scim/v2/Users/${user.id}`, {
      headers,
      data: {
        schemas: [PATCH_SCHEMA],
        Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
      },
    });
    expect(deactivated.status()).toBe(200);
    expect((await deactivated.json()).active).toBe(false);
  });

  test('the account and its group show up in CPM', async ({ page }) => {
    await page.goto('/groups');
    await waitForHydration(page);
    await expect(page.getByText('E2E Operators').first()).toBeVisible();
    await page.goto('/users');
    await waitForHydration(page);
    await expect(page.getByText(EMAIL).first()).toBeVisible();
  });

  test('rotating the token turns the old one away', async ({ page, playwright }) => {
    const request = await idpRequest(playwright);
    await page.goto('/users/provisioning');
    await waitForHydration(page);
    await page.getByRole('button', { name: `Actions for ${CONNECTION}` }).click();
    await page.getByRole('menuitem', { name: 'Rotate' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Rotate' }).click();
    await expect(page.getByText('Copy this token now.', { exact: false })).toBeVisible();

    const refused = await request.get('/api/auth/scim/v2/Users', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(refused.status()).toBe(401);
  });
});
