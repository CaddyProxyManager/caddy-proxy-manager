/** E2E: Users page - listing, search, edit, disable/enable, delete, create. Runs as admin. */
import { test, expect } from '@playwright/test';
import { waitForHydration } from '../../helpers/hydration';
import { getUserRecord } from '../../helpers/seed';
import { signInWithCredentials } from '../../helpers/sign-in';

const BASE = 'http://localhost:3000';

async function loginWithCredentials(
  browser: import('@playwright/test').Browser,
  username: string,
  password: string,
) {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();

  await page.goto(`${BASE}/login`);
  await waitForHydration(page);
  await signInWithCredentials(page, username, password);
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 });

  return { context, page };
}

test.describe('Users page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/users');
    // The search box is controlled: filled before hydration, React resets it to empty.
    await waitForHydration(page);
  });

  const railRow = (page: import('@playwright/test').Page, email: string) =>
    page
      .getByRole('navigation', { name: 'Users' })
      .getByRole('listitem')
      .filter({ hasText: email });

  test('page loads with the user list beside the selected user', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Users', level: 1 })).toBeVisible();
    // The first account is selected, so the detail is never an empty pane on arrival.
    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();
  });

  test('displays at least one user (the admin)', async ({ page }) => {
    await expect(page.getByText(/\d+ users? shown/)).toBeVisible({ timeout: 5000 });
  });

  test('search input filters users', async ({ page }) => {
    await page.getByPlaceholder('Search users…').fill('testadmin');
    await expect(page.getByText(/^1 user shown/)).toBeVisible({ timeout: 5000 });

    await page.getByPlaceholder('Search users…').fill('nonexistent-zzz');
    await expect(page.getByText('No users found.')).toBeVisible({ timeout: 5000 });
  });

  test('the status filter narrows the list', async ({ page }) => {
    await page.getByRole('radio', { name: 'Disabled' }).click();
    await expect(railRow(page, 'testadmin@localhost')).toHaveCount(0);

    await page.getByRole('radio', { name: 'Active' }).click();
    await expect(railRow(page, 'testadmin@localhost')).toBeVisible();
  });

  test('selecting a user shows their details and groups', async ({ page }) => {
    await railRow(page, 'testadmin@localhost').click();
    const detail = page.getByRole('main');
    await expect(detail.getByRole('heading', { name: 'Details' })).toBeVisible();
    await expect(detail.getByText('Sign-in method')).toBeVisible();
    await expect(detail.getByRole('heading', { name: 'Groups' })).toBeVisible();
  });

  test('admin user shows admin role badge', async ({ page }) => {
    await expect(page.getByText('Admin', { exact: true }).first()).toBeVisible();
  });

  test('clicking edit opens the edit dialog', async ({ page }) => {
    await page.getByRole('button', { name: /^Edit user / }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/editing/i)).toBeVisible();
    await expect(dialog.getByPlaceholder('Display name')).toBeVisible();
    await expect(dialog.getByPlaceholder('Email address')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  test('clicking cancel closes the edit dialog', async ({ page }) => {
    await page.getByRole('button', { name: /^Edit user / }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/editing/i)).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('edit dialog has role select with Admin, User, Viewer options', async ({ page }) => {
    await page.getByRole('button', { name: /^Edit user / }).click();

    const roleTrigger = page.getByRole('dialog').getByRole('combobox').first();
    await expect(roleTrigger).toBeVisible();
    await roleTrigger.click();

    await expect(page.getByRole('option', { name: 'Admin' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'User' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Viewer' })).toBeVisible();
  });

  test('the selected user has edit, disable and delete actions', async ({ page }) => {
    await expect(page.getByRole('button', { name: /^Edit user / })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Disable user / })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Delete user / })).toBeVisible();
  });

  // ── Create user (UI) ──────────────────────────────────────────────────

  test('Create User button is visible', async ({ page }) => {
    await expect(page.getByRole('button', { name: /^new$/i })).toBeVisible();
  });

  test('clicking Create User opens the create dialog', async ({ page }) => {
    await page.getByRole('button', { name: /^new$/i }).click();

    await expect(page.getByTestId('create-email')).toBeVisible();
    await expect(page.getByTestId('create-name')).toBeVisible();
    await expect(page.getByTestId('create-role')).toBeVisible();
    await expect(page.getByTestId('create-password')).toBeVisible();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  test('the generate button fills the password with a usable value', async ({ page }) => {
    // Generating also reveals: an admin has to pass the credential on.
    await page.getByRole('button', { name: /^new$/i }).click();
    const password = page.getByTestId('create-password');
    await expect(password).toHaveValue('');

    await page.getByRole('button', { name: /generate a strong password/i }).click();

    await expect(password).toHaveAttribute('type', 'text');
    const generated = await password.inputValue();
    // The policy the server enforces: 12+, both cases, a digit and a symbol.
    expect(generated.length).toBeGreaterThanOrEqual(12);
    expect(generated).toMatch(/[a-z]/);
    expect(generated).toMatch(/[A-Z]/);
    expect(generated).toMatch(/[0-9]/);
    expect(generated).toMatch(/[^A-Za-z0-9]/);

    await page.getByRole('button', { name: /generate a strong password/i }).click();
    expect(await password.inputValue()).not.toBe(generated);
  });

  test('a generated password is accepted when the user is created', async ({ page }) => {
    const email = `generated-${Date.now()}@localhost`;
    await page.getByRole('button', { name: /^new$/i }).click();
    await page.getByTestId('create-email').fill(email);
    await page.getByTestId('create-name').fill('Generated Password User');
    await page.getByRole('button', { name: /generate a strong password/i }).click();

    await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();

    // The real assertion: the server's policy accepts what the generator produced.
    await expect(page.getByTestId('create-email')).not.toBeVisible();
    await expect(railRow(page, email)).toBeVisible({ timeout: 5000 });
  });

  test('clicking Cancel closes the create dialog', async ({ page }) => {
    await page.getByRole('button', { name: /^new$/i }).click();
    await expect(page.getByTestId('create-email')).toBeVisible();

    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('create-email')).not.toBeVisible();
  });

  test('creating a user via the form provisions a working credential account', async ({
    page,
    browser,
  }) => {
    const email = `newuser-ui-${Date.now()}@test.local`;
    const password = 'SecurePass2026!';
    const expectedUsername = email;

    await page.getByRole('button', { name: /^new$/i }).click();

    await page.getByTestId('create-email').fill(email);
    await page.getByTestId('create-name').fill('New Test User');
    await page.getByTestId('create-password').fill(password);

    await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();

    await expect(page.getByTestId('create-email')).not.toBeVisible();
    await expect(railRow(page, email)).toBeVisible({ timeout: 5000 });
    // The new account is selected once it arrives, so its name heads the detail.
    await expect(page.getByRole('heading', { name: 'New Test User', level: 2 })).toBeVisible({
      timeout: 5000,
    });

    const created = getUserRecord(email);
    expect(created.provider).toBe('credentials');
    expect(created.subject).toBe(expectedUsername);
    expect(created.username).toBe(expectedUsername);
    expect(created.displayUsername).toBe('New Test User');
    expect(created.accountProviderId).toBe('credential');
    expect(created.accountId).not.toBeNull();
    expect(created.accountHasPassword).toBe(true);

    const { context, page: loginPage } = await loginWithCredentials(
      browser,
      expectedUsername,
      password,
    );
    await expect(loginPage).not.toHaveURL(/\/login/, { timeout: 10000 });
    await context.close();
  });

  test('creating a user with a specific role shows correct badge and email login works', async ({
    page,
    browser,
  }) => {
    const email = `viewer-ui-${Date.now()}@test.local`;
    const password = 'ViewerPass2026!';
    const expectedUsername = email;

    await page.getByRole('button', { name: /^new$/i }).click();

    await page.getByTestId('create-email').fill(email);
    await page.getByTestId('create-name').fill('Viewer User');
    await page.getByTestId('create-password').fill(password);

    await page.getByTestId('create-role').click();
    await page.getByRole('option', { name: 'Viewer' }).click();

    await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();

    await expect(railRow(page, email)).toBeVisible({ timeout: 5000 });
    await expect(railRow(page, email).getByText('Viewer', { exact: true })).toBeVisible();

    const created = getUserRecord(email);
    expect(created.role).toBe('viewer');
    expect(created.provider).toBe('credentials');
    expect(created.subject).toBe(expectedUsername);
    expect(created.username).toBe(expectedUsername);

    const { context } = await loginWithCredentials(browser, expectedUsername, password);
    await context.close();
  });
});

test.describe('Users page - unauthenticated access', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('unauthenticated access to /users redirects to /login', async ({ page }) => {
    await page.goto('/users');
    await expect(page).toHaveURL(/\/login/);
  });
});

// ── API v1 create user tests ─────────────────────────────────────────────

test.describe('Users API v1 - create user (POST)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page).not.toHaveURL(/\/login/);
  });

  test('admin can create a user via API', async ({ page, browser }) => {
    const origin = new URL(page.url()).origin;
    const email = `api-created-${Date.now()}@test.local`;
    const password = 'ApiPass2026!';
    const expectedUsername = email;

    const response = await page.request.post('http://localhost:3000/api/v1/users', {
      headers: { Origin: origin },
      data: {
        email,
        name: 'API Created',
        password,
        role: 'user',
      },
    });

    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.email).toBe(email);
    expect(body.name).toBe('API Created');
    expect(body.role).toBe('user');
    expect(body.passwordHash).toBeUndefined();

    const created = getUserRecord(email);
    expect(created.provider).toBe('credentials');
    expect(created.subject).toBe(expectedUsername);
    expect(created.username).toBe(expectedUsername);
    expect(created.accountProviderId).toBe('credential');
    expect(created.accountHasPassword).toBe(true);

    await page.goto('/users');
    await expect(page.getByText(email)).toBeVisible({ timeout: 5000 });

    const { context } = await loginWithCredentials(browser, expectedUsername, password);
    await context.close();
  });

  test('admin can create a viewer via API', async ({ page }) => {
    const origin = new URL(page.url()).origin;
    const email = `api-viewer-${Date.now()}@test.local`;

    const response = await page.request.post('http://localhost:3000/api/v1/users', {
      headers: { Origin: origin },
      data: {
        email,
        name: 'API Viewer',
        password: 'ViewerPass2026!',
        role: 'viewer',
      },
    });

    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.role).toBe('viewer');

    const created = getUserRecord(email);
    expect(created.role).toBe('viewer');
    expect(created.provider).toBe('credentials');
    expect(created.accountProviderId).toBe('credential');
  });

  // Refused, not downgraded: a silent downgrade hides a typo in an automation script.
  test('API POST with invalid role is refused', async ({ page }) => {
    const origin = new URL(page.url()).origin;
    const email = `api-invalid-role-${Date.now()}@test.local`;

    const response = await page.request.post('http://localhost:3000/api/v1/users', {
      headers: { Origin: origin },
      data: {
        email,
        name: 'Invalid Role',
        password: 'InvalidRole2026!',
        role: 'superadmin',
      },
    });

    expect(response.status()).toBe(400);
    expect((await response.json()).error).toMatch(/role/i);
  });

  test('API POST returns 400 when email is missing', async ({ page }) => {
    const origin = new URL(page.url()).origin;

    const response = await page.request.post('http://localhost:3000/api/v1/users', {
      headers: { Origin: origin },
      data: {
        name: 'No Email',
        password: 'SomePass2026!',
      },
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('required');
  });

  test('API POST returns 400 when password is missing', async ({ page }) => {
    const origin = new URL(page.url()).origin;

    const response = await page.request.post('http://localhost:3000/api/v1/users', {
      headers: { Origin: origin },
      data: {
        email: 'nopass@test.local',
        name: 'No Password',
      },
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('required');
  });
});

test.describe('Users API v1 - create user (POST) - non-admin blocked', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('unauthenticated POST is blocked', async ({ request }) => {
    const response = await request.post('http://localhost:3000/api/v1/users', {
      data: {
        email: 'unauthed@test.local',
        name: 'Unauthed',
        password: 'Pass2026!',
      },
    });

    expect(response.status()).toBeGreaterThanOrEqual(400);
  });
});
