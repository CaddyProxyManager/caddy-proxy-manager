/** E2E: Groups page - creation, member management, deletion. Runs as admin. */
import { test, expect } from '@playwright/test';
import { waitForHydration } from '../helpers/hydration';

test.describe('Groups page', () => {
  // One group walked through create, members and delete, so the tests share it in order.
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await page.goto('/groups');
    await waitForHydration(page);
  });

  const rail = (page: import('@playwright/test').Page) =>
    page.getByRole('navigation', { name: 'Groups' });

  test('page loads with Groups heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Groups', level: 1 })).toBeVisible();
    await expect(page.getByPlaceholder('Search groups…')).toBeVisible();
  });

  test('New Group button is visible', async ({ page }) => {
    await expect(page.getByRole('button', { name: /new group/i }).first()).toBeVisible();
  });

  test('clicking New Group opens the create dialog', async ({ page }) => {
    await page
      .getByRole('button', { name: /new group/i })
      .first()
      .click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Name')).toBeVisible();
    await expect(dialog.getByLabel('Description')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  test('clicking Cancel closes the create dialog', async ({ page }) => {
    await page
      .getByRole('button', { name: /new group/i })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Name')).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('create a new group', async ({ page }) => {
    await page
      .getByRole('button', { name: /new group/i })
      .first()
      .click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('E2E Test Group');
    await dialog.getByLabel('Description').fill('Created by E2E test');
    await dialog.getByRole('button', { name: 'Create' }).click();

    await expect(rail(page).getByText('E2E Test Group')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'E2E Test Group', level: 2 })).toBeVisible();
    await expect(page.getByText('Created by E2E test')).toBeVisible();
    await expect(page.getByText('0 members').first()).toBeVisible();
  });

  test('add members to group, several in one go', async ({ page }) => {
    // This run's own accounts, so there is always a pair to pick whatever else exists.
    const tag = `picker-${Date.now()}`;
    const origin = new URL(page.url()).origin;
    for (const n of [1, 2]) {
      const response = await page.request.post('http://localhost:3000/api/v1/users', {
        headers: { Origin: origin },
        data: {
          email: `${tag}-${n}@test.local`,
          name: `${tag} ${n}`,
          password: 'PickerPass2026!',
          role: 'user',
        },
      });
      expect(response.status()).toBe(201);
    }
    await page.reload();
    await waitForHydration(page);

    await rail(page).getByText('E2E Test Group', { exact: true }).click();
    await page.getByRole('button', { name: 'Add member' }).first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Choose the users to add to this group')).toBeVisible();
    await dialog.getByPlaceholder('Search users…').fill(tag);
    const boxes = dialog.getByRole('checkbox');
    await expect(boxes).toHaveCount(2, { timeout: 5_000 });

    // Ticking does not add or close: the dialog stays until Add commits the whole selection.
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('2 selected')).toBeVisible();

    await dialog.getByRole('button', { name: 'Add 2 members' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('2 members').first()).toBeVisible({ timeout: 10_000 });
  });

  test('the access tab says what the group manages', async ({ page }) => {
    await rail(page).getByText('E2E Test Group', { exact: true }).click();
    // Astryx tabs are buttons named with their count badge, which also keeps this apart from the
    // header's "Access - <group>" icon button.
    await page.getByRole('button', { name: /^Access\s*\d+$/ }).click();
    await expect(page.getByRole('heading', { name: 'Managed resources' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit access' })).toBeVisible();
  });

  test('remove member from group', async ({ page }) => {
    await rail(page).getByText('E2E Test Group', { exact: true }).click();
    // The test above left two members, so removing one is visible as a count of one.
    await page
      .getByRole('button', { name: /^Remove .+ from / })
      .first()
      .click();
    await expect(page.getByText('1 member', { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('delete group via confirm dialog', async ({ page }) => {
    await rail(page).getByText('E2E Test Group', { exact: true }).click();

    // The header button is labelled per group; the dialog's action is the bare verb.
    await page.getByRole('button', { name: 'Delete group E2E Test Group' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Delete group', exact: true }).click();

    await expect(rail(page).getByText('E2E Test Group', { exact: true })).not.toBeVisible({
      timeout: 10_000,
    });
  });
});

test.describe('Groups page - unauthenticated access', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('unauthenticated access to /groups redirects to /login', async ({ page }) => {
    await page.goto('/groups');
    await expect(page).toHaveURL(/\/login/);
  });
});
