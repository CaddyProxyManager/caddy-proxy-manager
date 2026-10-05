/**
 * E2E: disabling a user blocks them - existing session redirects to /login, credential login
 * fails, the API token returns 401 - and re-enabling restores access.
 */
import { test, expect, type BrowserContext } from '@playwright/test';
import * as seed from '../../helpers/seed';
import { waitForHydration } from '../../helpers/hydration';
import { signInWithCredentials } from '../../helpers/sign-in';

const BASE = 'http://localhost:3000';
const API_BASE = `${BASE}/api/v1`;

const TEST_USERNAME = 'disabletest';
const TEST_EMAIL = `${TEST_USERNAME}@localhost`;
const TEST_PASSWORD = 'DisableTest2026!';

// ── Helpers ─────────────────────────────────────────────────────────────

function ensureTestUser() {
  seed.ensureTestUser(TEST_USERNAME, TEST_PASSWORD, 'user');
}

function setUserStatus(status: 'active' | 'disabled') {
  seed.setUserStatus(TEST_EMAIL, status);
}

function createApiToken(): string {
  return seed.createApiToken(TEST_EMAIL, 'e2e-disabled-test', `test-disabled-token-${Date.now()}`);
}

async function loginAs(
  browser: import('@playwright/test').Browser,
  username: string,
  password: string,
): Promise<BrowserContext> {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${BASE}/login`);
  // Before hydration the form submits natively, as a GET to /login with credentials in the query.
  await waitForHydration(page);
  await signInWithCredentials(page, username, password);

  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 60_000 });
  await page.close();
  return context;
}

// ── Tests ───────────────────────────────────────────────────────────────

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Disabled user enforcement', () => {
  test.beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      try {
        ensureTestUser();
        break;
      } catch (e) {
        if (i === 2) throw e;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  });

  test.afterAll(async () => {
    try {
      setUserStatus('active');
    } catch {
      /* best effort */
    }
  });

  test('disabled user UI session is rejected', async ({ browser }) => {
    const context = await loginAs(browser, TEST_USERNAME, TEST_PASSWORD);

    const page = await context.newPage();
    await page.goto(BASE);
    await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });
    await page.close();

    setUserStatus('disabled');

    const page2 = await context.newPage();
    await page2.goto(BASE);
    await expect(page2).toHaveURL(/\/login/, { timeout: 15_000 });
    await page2.close();

    await context.close();

    setUserStatus('active');
  });

  test('disabled user cannot log in', async ({ page }) => {
    setUserStatus('disabled');

    await page.goto(`${BASE}/login`);
    // Not flake insurance: a pre-hydration native submit stays on /login and would pass untested.
    await waitForHydration(page);
    await signInWithCredentials(page, TEST_USERNAME, TEST_PASSWORD);

    await expect(async () => {
      const url = page.url();
      const hasError = await page
        .getByText(/invalid|disabled|error|failed|incorrect/i)
        .isVisible({ timeout: 1_000 })
        .catch(() => false);
      expect(url.includes('/login') || hasError).toBe(true);
    }).toPass({ timeout: 15_000 });

    setUserStatus('active');
  });

  test('disabled user API token returns 401', async ({ request }) => {
    const token = createApiToken();

    const res1 = await request.get(`${API_BASE}/tokens`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    expect(res1.status()).toBe(200);

    setUserStatus('disabled');

    const res2 = await request.get(`${API_BASE}/tokens`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    expect(res2.status()).toBe(401);

    setUserStatus('active');
  });

  test('re-enabling user restores API access', async ({ request }) => {
    const token = createApiToken();

    setUserStatus('disabled');
    const res1 = await request.get(`${API_BASE}/tokens`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    expect(res1.status()).toBe(401);

    setUserStatus('active');
    const res2 = await request.get(`${API_BASE}/tokens`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    expect(res2.status()).toBe(200);
  });

  test('re-enabling user restores UI login', async ({ browser }) => {
    setUserStatus('disabled');
    setUserStatus('active');

    const context = await loginAs(browser, TEST_USERNAME, TEST_PASSWORD);
    const page = await context.newPage();
    await page.goto(BASE);
    await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });
    await page.close();
    await context.close();
  });
});
