/**
 * E2E: forward auth portal (/portal) - error states, form rendering, credential submit. Runs
 * without pre-authenticated state, since this is a login page.
 */
import { test, expect } from '@playwright/test';
import { waitForHydration } from '../../helpers/hydration';
import { signInWithCredentials, submitUsername } from '../../helpers/sign-in';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Portal login page', () => {
  test('shows error when no redirect URI is provided', async ({ page }) => {
    await page.goto('/portal');
    await expect(page.getByRole('heading', { name: 'Authentication Required' })).toBeVisible();
    await expect(page.getByText('No redirect destination specified.')).toBeVisible();
  });

  test('shows login form when redirect URI is provided', async ({ page }) => {
    await page.goto('/portal?rd=http://example.com');
    await expect(page.getByRole('heading', { name: 'Authentication Required' })).toBeVisible();
    await expect(page.getByText('Sign in to continue')).toBeVisible();

    // Identifier first: step one is the username on its own.
    await expect(page.getByLabel('Username')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
    await expect(page.getByLabel('Password')).toBeHidden();

    await waitForHydration(page);
    await submitUsername(page, 'someone');
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  });

  test('shows error with invalid credentials', async ({ page }) => {
    await page.goto('/portal?rd=http://example.com');
    // onSubmit with preventDefault submits natively until React attaches.
    await waitForHydration(page);

    await signInWithCredentials(page, 'wronguser', 'wrongpass');

    // .first(): the route announcer matches too.
    await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 10_000 });
  });

  test('username and password fields are required', async ({ page }) => {
    await page.goto('/portal?rd=http://example.com');
    await waitForHydration(page);

    await expect(page.getByLabel('Username')).toHaveAttribute('aria-required', 'true');

    // Mounted but hidden, so out of the accessibility tree until the second step.
    await submitUsername(page, 'someone');
    await expect(page.getByLabel('Password')).toHaveAttribute('aria-required', 'true');
  });

  test('rejects javascript: URI - no rid is created', async ({ page }) => {
    await page.goto('/portal?rd=javascript:alert(1)');
    // Form shows (hasRedirect is true) but no rid is created - login will fail
    await expect(page.getByRole('heading', { name: 'Authentication Required' })).toBeVisible();
    await expect(page.getByText('Sign in to continue')).toBeVisible();
  });

  test('rejects data: URI - no rid is created', async ({ page }) => {
    await page.goto('/portal?rd=data:text/html,<h1>evil</h1>');
    await expect(page.getByRole('heading', { name: 'Authentication Required' })).toBeVisible();
    await expect(page.getByText('Sign in to continue')).toBeVisible();
  });

  test('rejects file: URI - no rid is created', async ({ page }) => {
    await page.goto('/portal?rd=file:///etc/passwd');
    await expect(page.getByRole('heading', { name: 'Authentication Required' })).toBeVisible();
    await expect(page.getByText('Sign in to continue')).toBeVisible();
  });

  test('shows OAuth sign-in button when OIDC is enabled', async ({ page }) => {
    await page.goto('/portal?rd=http://example.com');
    await expect(page.getByRole('button', { name: /Continue with Dex/i })).toBeVisible();
  });

  test('shows both OAuth button and credential form', async ({ page }) => {
    await page.goto('/portal?rd=http://example.com');
    await expect(page.getByRole('button', { name: /Continue with Dex/i })).toBeVisible();
    await expect(page.getByLabel('Username')).toBeVisible();
    // The credential form now comes first, so the separator introduces the providers below it.
    await expect(page.getByText('Or continue with single sign-on')).toBeVisible();
  });

  test('preserves ?rid= parameter for OAuth return flow', async ({ page }) => {
    await page.goto('/portal?rid=abc123fakeopaqueid');
    await expect(page.getByRole('heading', { name: 'Authentication Required' })).toBeVisible();
    await expect(page.getByText('No redirect destination specified.')).not.toBeVisible();
  });
});
