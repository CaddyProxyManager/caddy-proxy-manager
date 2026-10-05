/** E2E: Users > Sign-in overview, every way in on one page. Runs as admin, changes nothing. */
import { test, expect } from '@playwright/test';
import { waitForHydration } from '../../helpers/hydration';

test('the sign-in overview lists the methods and previews the login page', async ({ page }) => {
  await page.goto('/users');
  await waitForHydration(page);
  await page.getByRole('link', { name: 'Sign-in overview' }).click();
  await expect(page).toHaveURL(/\/users\/sign-in$/);

  await expect(page.getByRole('heading', { name: 'Sign-in overview', level: 1 })).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: /username and password/i }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The login page' })).toBeVisible();
  // The preview is inert: its fields are there to be looked at.
  await expect(page.getByRole('textbox', { name: 'Username' })).toBeDisabled();
});

test('the users list names where an account came from and how it last signed in', async ({
  page,
}) => {
  await page.goto('/users');
  await waitForHydration(page);
  await expect(page.getByText('Account source')).toBeVisible();
  await expect(page.getByText('Second factor', { exact: true })).toBeVisible();
  await expect(page.getByText('Last sign-in')).toBeVisible();
});
