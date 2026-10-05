/**
 * E2E: role-based access control. Non-admins reach / and /profile but not admin pages,
 * unauthenticated users go to /login, admins reach everything. Seeds "testuser" and "testviewer".
 */
import { test, expect, type BrowserContext } from '@playwright/test';
import { ensureTestUser } from '../../helpers/seed';
import { waitForHydration } from '../../helpers/hydration';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signInWithCredentials } from '../../helpers/sign-in';

const moduleDir = dirname(fileURLToPath(import.meta.url));

// Via requireAdmin in their own page.tsx.
const ADMIN_ONLY_PAGES = [
  '/proxy-hosts',
  '/l4-proxy-hosts',
  '/certificates',
  '/access-lists',
  '/analytics',
  '/waf',
  '/audit-log',
  '/settings',
  '/users',
  '/groups',
  '/api-docs',
];

const USER_ACCESSIBLE_PAGES = ['/', '/profile'];

const ALL_DASHBOARD_PAGES = [...USER_ACCESSIBLE_PAGES, ...ADMIN_ONLY_PAGES];

async function loginAs(
  browser: import('@playwright/test').Browser,
  username: string,
  password: string,
): Promise<BrowserContext> {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('http://localhost:3000/login');
  // Before hydration the form submits natively - a GET with the credentials in the query.
  await waitForHydration(page);
  await signInWithCredentials(page, username, password);

  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 60_000 });
  await page.close();
  return context;
}

// ── Unauthenticated access ────────────────────────────────────────────────

test.describe('Unauthenticated access', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const path of ALL_DASHBOARD_PAGES) {
    test(`${path} redirects to /login`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
    });
  }
});

// ── Role-based access ─────────────────────────────────────────────────────

test.describe('Role-based access control', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  let userContext: BrowserContext;
  let viewerContext: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    ensureTestUser('testuser', 'TestUserPass2026!', 'user');
    ensureTestUser('testviewer', 'TestViewerPass2026!', 'viewer');

    userContext = await loginAs(browser, 'testuser', 'TestUserPass2026!');
    viewerContext = await loginAs(browser, 'testviewer', 'TestViewerPass2026!');
  });

  test.afterAll(async () => {
    await userContext?.close();
    await viewerContext?.close();
  });

  // ── "user" role - can access / and /profile ─────────────────────────

  test('user role: / loads with welcome message', async () => {
    const page = await userContext.newPage();
    try {
      await page.goto('/');
      await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });
      await expect(page.getByText(/welcome back/i)).toBeVisible({ timeout: 5_000 });
    } finally {
      await page.close();
    }
  });

  test('user role: / does not show admin stat cards', async () => {
    const page = await userContext.newPage();
    try {
      await page.goto('/');
      await expect(page.getByText(/welcome back/i)).toBeVisible({ timeout: 5_000 });
      await expect(page.getByRole('link', { name: /proxy hosts/i })).not.toBeVisible({
        timeout: 3_000,
      });
    } finally {
      await page.close();
    }
  });

  test('user role: sidebar only shows Overview', async () => {
    const page = await userContext.newPage();
    try {
      await page.goto('/');
      await expect(page.getByText(/welcome back/i)).toBeVisible({ timeout: 5_000 });
      await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Proxy Hosts' })).not.toBeVisible();
      await expect(page.getByRole('link', { name: 'Settings' })).not.toBeVisible();
      await expect(page.getByRole('link', { name: 'Users' })).not.toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('user role: /profile loads successfully', async () => {
    const page = await userContext.newPage();
    try {
      await page.goto('/profile');
      await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });
      await expect(page.getByText(/profile|password/i).first()).toBeVisible({ timeout: 5_000 });
    } finally {
      await page.close();
    }
  });

  // ── "viewer" role - can access / and /profile ───────────────────────

  test('viewer role: / loads with welcome message', async () => {
    const page = await viewerContext.newPage();
    try {
      await page.goto('/');
      await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });
      await expect(page.getByText(/welcome back/i)).toBeVisible({ timeout: 5_000 });
    } finally {
      await page.close();
    }
  });

  test('viewer role: / does not show admin stat cards', async () => {
    const page = await viewerContext.newPage();
    try {
      await page.goto('/');
      await expect(page.getByText(/welcome back/i)).toBeVisible({ timeout: 5_000 });
      await expect(page.getByRole('link', { name: /proxy hosts/i })).not.toBeVisible({
        timeout: 3_000,
      });
    } finally {
      await page.close();
    }
  });

  test('viewer role: sidebar only shows Overview', async () => {
    const page = await viewerContext.newPage();
    try {
      await page.goto('/');
      await expect(page.getByText(/welcome back/i)).toBeVisible({ timeout: 5_000 });
      await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Proxy Hosts' })).not.toBeVisible();
      await expect(page.getByRole('link', { name: 'Settings' })).not.toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('viewer role: /profile loads successfully', async () => {
    const page = await viewerContext.newPage();
    try {
      await page.goto('/profile');
      await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });
      await expect(page.getByText(/profile|password/i).first()).toBeVisible({ timeout: 5_000 });
    } finally {
      await page.close();
    }
  });

  // ── "user" role - blocked from admin-only pages ─────────────────────

  for (const path of ADMIN_ONLY_PAGES) {
    test(`user role: ${path} is blocked`, async () => {
      const page = await userContext.newPage();
      try {
        const response = await page.goto(path);
        // requireAdmin() throws, so the error boundary renders or it 500s.
        const status = response?.status() ?? 0;
        const url = page.url();

        const isBlocked =
          status >= 400 ||
          url.includes('/login') ||
          (await page
            .getByText(/administrator privileges|error|forbidden|not authorized/i)
            .isVisible({ timeout: 3_000 })
            .catch(() => false));

        expect(isBlocked).toBe(true);
      } finally {
        await page.close();
      }
    });
  }

  // ── "viewer" role - blocked from admin-only pages ───────────────────

  for (const path of ADMIN_ONLY_PAGES) {
    test(`viewer role: ${path} is blocked`, async () => {
      const page = await viewerContext.newPage();
      try {
        const response = await page.goto(path);
        const status = response?.status() ?? 0;
        const url = page.url();

        const isBlocked =
          status >= 400 ||
          url.includes('/login') ||
          (await page
            .getByText(/administrator privileges|error|forbidden|not authorized/i)
            .isVisible({ timeout: 3_000 })
            .catch(() => false));

        expect(isBlocked).toBe(true);
      } finally {
        await page.close();
      }
    });
  }

  // ── Admin user - can access all pages ───────────────────────────────

  test('admin role: all dashboard pages are accessible', async ({ browser }, testInfo) => {
    testInfo.setTimeout(90_000);
    const adminContext = await browser.newContext({
      storageState: resolve(moduleDir, '../../.auth/admin.json'),
    });
    try {
      for (const path of ALL_DASHBOARD_PAGES) {
        const page = await adminContext.newPage();
        const response = await page.goto(path);
        const status = response?.status() ?? 0;
        expect(status).toBeLessThan(400);
        expect(page.url()).not.toContain('/login');
        await page.close();
      }
    } finally {
      await adminContext.close();
    }
  });

  test('admin role: sidebar shows all nav items', async ({ browser }) => {
    const adminContext = await browser.newContext({
      storageState: resolve(moduleDir, '../../.auth/admin.json'),
    });
    try {
      const page = await adminContext.newPage();
      await page.goto('/');
      await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Proxy Hosts', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Users' })).toBeVisible();
      await page.close();
    } finally {
      await adminContext.close();
    }
  });

  // ── API endpoints - non-admin should be blocked ───────────────────────

  test('user role: API v1 endpoints return 401/403', async () => {
    const page = await userContext.newPage();
    try {
      const response = await page.request.get('/api/v1/proxy-hosts');
      expect(response.status()).toBeGreaterThanOrEqual(400);
    } finally {
      await page.close();
    }
  });

  test('viewer role: API v1 endpoints return 401/403', async () => {
    const page = await viewerContext.newPage();
    try {
      const response = await page.request.get('/api/v1/proxy-hosts');
      expect(response.status()).toBeGreaterThanOrEqual(400);
    } finally {
      await page.close();
    }
  });
});
