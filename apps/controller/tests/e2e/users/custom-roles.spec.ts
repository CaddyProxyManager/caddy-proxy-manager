/**
 * E2E: an administrator makes a role on Users -> Roles, gives it to an account, and that account
 * gets exactly it: the nav offers the audit log and nothing else, the page opens, a page it lacks
 * is refused, and the server refuses the same over GraphQL whatever the browser shows.
 */
import { test, expect, type BrowserContext } from '@playwright/test';
import { ensureTestUser, runSeedScript } from '../../helpers/seed';
import { waitForHydration } from '../../helpers/hydration';
import { signInWithCredentials } from '../../helpers/sign-in';

const ROLE_NAME = 'E2E auditors';
const USERNAME = 'testauditor';
const PASSWORD = 'TestAuditorPass2026!';

function giveRole(username: string, roleName: string | null): void {
  runSeedScript(`
    const [role] = ${roleName === null ? '[{ key: "user" }]' : `await sql\`SELECT key FROM roles WHERE name = \${${JSON.stringify(roleName)}}\``};
    await sql\`UPDATE users SET role = \${role.key} WHERE email = \${${JSON.stringify(`${username}@localhost`)}}\`;
    await sql.close();
  `);
}

function dropRole(roleName: string): void {
  runSeedScript(`
    await sql\`DELETE FROM roles WHERE name = \${${JSON.stringify(roleName)}}\`;
    await sql.close();
  `);
}

test.describe('Custom roles', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterAll(() => {
    giveRole(USERNAME, null);
    dropRole(ROLE_NAME);
  });

  test('an administrator makes a role that reads the audit log', async ({ page }) => {
    dropRole(ROLE_NAME);
    await page.goto('/users/roles');
    await waitForHydration(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Roles' })).toBeVisible();
    // The built-in roles are listed and cannot be changed.
    await expect(page.getByRole('cell', { name: /^Operator/ })).toBeVisible();

    await page.getByRole('button', { name: 'New' }).click();
    const dialog = page.getByRole('dialog', { name: 'New role' });
    await dialog.getByLabel('Name').fill(ROLE_NAME);
    await dialog
      .getByRole('radiogroup', { name: 'Audit log' })
      .getByRole('radio', { name: 'Read', exact: true })
      .click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('cell', { name: ROLE_NAME, exact: true })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: ROLE_NAME })).toContainText(
      '1 permission',
    );
  });

  test.describe('an account holding it', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    let context: BrowserContext;

    test.beforeAll(async ({ browser }) => {
      ensureTestUser(USERNAME, PASSWORD, 'user');
      giveRole(USERNAME, ROLE_NAME);
      context = await browser.newContext();
      const page = await context.newPage();
      await page.goto('http://localhost:3000/login');
      await waitForHydration(page);
      await signInWithCredentials(page, USERNAME, PASSWORD);
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 60_000 });
      await page.close();
    });

    test.afterAll(async () => {
      await context?.close();
    });

    test('sees the audit log in the nav, and not what it lacks', async () => {
      const page = await context.newPage();
      try {
        await page.goto('/');
        await expect(page.getByRole('link', { name: 'Audit log' }).first()).toBeVisible({
          timeout: 10_000,
        });
        await expect(page.getByRole('link', { name: 'Settings' })).not.toBeVisible();
        await expect(page.getByRole('link', { name: 'Proxy hosts' })).not.toBeVisible();
      } finally {
        await page.close();
      }
    });

    test('opens the audit log, and is refused Settings', async () => {
      const page = await context.newPage();
      try {
        await page.goto('/audit-log');
        await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible({
          timeout: 10_000,
        });
        const response = await page.goto('/settings');
        const refused =
          (response?.status() ?? 0) >= 400 ||
          (await page
            .getByText(/do not have access|error/i)
            .first()
            .isVisible({ timeout: 3_000 })
            .catch(() => false));
        expect(refused).toBe(true);
      } finally {
        await page.close();
      }
    });

    test('is refused by the server what the nav does not offer', async () => {
      const response = await context.request.post('http://localhost:3000/api/graphql', {
        headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
        data: { query: '{ settings(group: "general") }' },
      });
      const body = await response.json();
      expect(body.errors?.[0]?.message).toBe("This account's role does not allow this request");

      const allowed = await context.request.post('http://localhost:3000/api/graphql', {
        headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
        data: { query: '{ auditLog(limit: 1) { total } }' },
      });
      expect((await allowed.json()).errors).toBeUndefined();
    });
  });

  test('a role in use cannot be deleted', async ({ page }) => {
    giveRole(USERNAME, ROLE_NAME);
    await page.goto('/users/roles');
    await waitForHydration(page);
    await page.getByRole('button', { name: `Actions for ${ROLE_NAME}` }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText(/still given to people, groups or sign-in mappings/)).toBeVisible();
  });
});
