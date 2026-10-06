/**
 * E2E: Profile > Display, the time zone and number format stored on the account. Its own user, so
 * the suite's admin keeps the browser's zone.
 */
import { test, expect } from '@playwright/test';
import * as seed from '../../helpers/seed';
import { waitForHydration } from '../../helpers/hydration';
import { signInWithCredentials } from '../../helpers/sign-in';

const USER = { username: 'displayprefs', password: 'DisplayPrefs2026!' };

test.use({ storageState: { cookies: [], origins: [] } });

test('a time zone chosen on Profile follows the account to another browser', async ({
  page,
  browser,
}) => {
  seed.ensureTestUser(USER.username, USER.password, 'user');
  await page.goto('/login');
  await waitForHydration(page);
  await signInWithCredentials(page, USER.username, USER.password);
  await page.waitForURL((url) => !url.pathname.includes('/login'));

  await page.goto('/profile');
  await waitForHydration(page);
  // With a search field the trigger is a button, and opening it focuses the search.
  await page.getByRole('button', { name: 'Time zone' }).click();
  await page.keyboard.type('Tokyo');
  await page.getByRole('option', { name: 'Asia/Tokyo' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/now showing asia\/tokyo/i)).toBeVisible({ timeout: 15_000 });

  // A browser that never chose: the account's zone, not its own.
  const other = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    timezoneId: 'America/New_York',
  });
  const second = await other.newPage();
  await second.goto('/login');
  await waitForHydration(second);
  await signInWithCredentials(second, USER.username, USER.password);
  await second.waitForURL((url) => !url.pathname.includes('/login'));
  await second.goto('/profile');
  await waitForHydration(second);
  await expect(second.getByText(/now showing asia\/tokyo/i)).toBeVisible();
  await other.close();
});
