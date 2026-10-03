/**
 * DEMO_MODE on web-demo (port 3008): configuration saves and reads back against an in-memory Caddy
 * with a simulated agent, while what would let one visitor lock out the next - the shared admin's
 * password, second factor and status - and pairing a real agent are refused.
 */
import { test, expect, type APIRequestContext, type Browser } from '@playwright/test';
import { httpGet } from '../helpers/http';
import { waitForHydration } from '../helpers/hydration';
import { signInWithCredentials } from '../helpers/sign-in';

const BASE = 'http://localhost:3008';
const API = `${BASE}/api/v1`;
const ADMIN = { username: 'testadmin', password: 'TestPassword2026!' };
const DOMAIN = 'demo-mode-e2e.test';

test.use({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

async function apiSignIn(browser: Browser, username: string, password: string) {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const res = await ctx.request.post(`${BASE}/api/auth/sign-in/username`, {
    headers: { Origin: BASE },
    data: { username, password },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ctx;
}

test.describe('Demo mode', () => {
  let admin: APIRequestContext;
  let closeAdmin: () => Promise<void>;

  test.beforeAll(async ({ browser }) => {
    const ctx = await apiSignIn(browser, ADMIN.username, ADMIN.password);
    admin = ctx.request;
    closeAdmin = () => ctx.close();
  });

  test.afterAll(async () => {
    const hosts = await admin.get(`${API}/proxy-hosts`);
    for (const host of (await hosts.json()) as { id: number; domains: string[] }[]) {
      if (host.domains.includes(DOMAIN)) {
        await admin.delete(`${API}/proxy-hosts/${host.id}`, { headers: { Origin: BASE } });
      }
    }
    await closeAdmin?.();
  });

  test('the dashboard says it is a demo', async ({ page }) => {
    await page.goto('/login');
    await waitForHydration(page);
    await signInWithCredentials(page, ADMIN.username, ADMIN.password);
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 20_000 });
    await expect(page.getByText('Demo mode', { exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test('a proxy host saves and reads back, without reaching a real Caddy', async ({ page }) => {
    const created = await admin.post(`${API}/proxy-hosts`, {
      headers: { Origin: BASE },
      data: { name: 'Demo host', domains: [DOMAIN], upstreams: ['echo-server:8080'] },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = await created.json();

    const read = await admin.get(`${API}/proxy-hosts/${id}`);
    expect(read.ok()).toBe(true);
    expect((await read.json()).domains).toEqual([DOMAIN]);

    // The stack's real Caddy never heard of it; its default response may drop the connection.
    const real = await httpGet(DOMAIN).catch(() => ({ body: '' }));
    expect(real.body).not.toContain('echo-ok');

    await page
      .context()
      .addCookies((await admin.storageState()).cookies.map((cookie) => ({ ...cookie })));
    await page.goto('/proxy-hosts');
    await expect(page.getByText(DOMAIN).first()).toBeVisible({ timeout: 15_000 });
  });

  test('the simulated agent is listed as connected', async () => {
    const res = await admin.post(`${BASE}/api/graphql`, {
      headers: { Origin: BASE },
      data: { query: '{ agents { name connected } }' },
    });
    expect(res.ok(), await res.text()).toBe(true);
    const { data } = (await res.json()) as {
      data: { agents: { name: string; connected: boolean }[] };
    };
    expect(data.agents).toContainEqual({ name: 'Demo agent', connected: true });
  });

  test("the shared admin's password and second factor cannot be changed", async () => {
    const password = await admin.post(`${BASE}/api/user/change-password`, {
      headers: { Origin: BASE },
      data: { currentPassword: ADMIN.password, newPassword: 'AnotherPassword2026!' },
    });
    expect(password.status()).toBe(403);
    expect((await password.json()).error).toMatch(/demo administrator/i);

    const twoFactor = await admin.post(`${BASE}/api/auth/two-factor/enable`, {
      headers: { Origin: BASE },
      data: { password: ADMIN.password },
    });
    expect(twoFactor.status()).toBe(403);
    expect((await twoFactor.json()).code).toBe('DEMO_LOCKED');
  });

  test('another administrator cannot disable or demote the shared admin', async ({ browser }) => {
    const second = { username: `demo-second-${Date.now()}`, password: 'DemoSecond2026!pw' };
    const created = await admin.post(`${API}/users`, {
      headers: { Origin: BASE },
      data: {
        email: `${second.username}@localhost`,
        username: second.username,
        password: second.password,
        role: 'admin',
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const secondId = (await created.json()).id as number;

    const ctx = await apiSignIn(browser, second.username, second.password);
    try {
      for (const change of [{ status: 'disabled' }, { role: 'viewer' }]) {
        const res = await ctx.request.put(`${API}/users/1`, {
          headers: { Origin: BASE },
          data: change,
        });
        expect(res.status(), JSON.stringify(change)).toBe(403);
      }
    } finally {
      await ctx.close();
      await admin.delete(`${API}/users/${secondId}`, { headers: { Origin: BASE } });
    }
  });

  test('a real agent is refused pairing', async ({ request }) => {
    for (const path of ['pair', 'pair/preview']) {
      const res = await request.post(`${BASE}/api/agent/v1/${path}`, {
        data: { agentId: 'a'.repeat(32), code: 'ABCDEF' },
      });
      expect(res.status(), path).toBe(403);
      expect((await res.json()).error).toMatch(/demo mode/i);
    }
  });
});
