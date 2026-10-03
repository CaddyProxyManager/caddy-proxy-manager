/**
 * Sign-in throttling on web-ratelimit (port 3006), the one instance with AUTH_RATE_LIMIT_ENABLED:
 * Better Auth's per-address limit (three sign-ins per ten seconds) and CPM's per-account slowdown
 * (free for five failures, then doubling from a second). Its own database, so nothing here
 * reaches another spec's accounts.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { COMPOSE_ARGS, COMPOSE_CWD } from '../helpers/compose';
import { waitForHydration } from '../helpers/hydration';

const BASE = 'http://localhost:3006';
const USERNAME = 'testadmin';
const PASSWORD = 'TestPassword2026!';

test.use({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

type Attempt = { status: number; retryAfter: number; accountRetryAfter: number; body: string };

async function signIn(request: APIRequestContext, password: string): Promise<Attempt> {
  const res = await request.post(`${BASE}/api/auth/sign-in/username`, {
    headers: { Origin: BASE },
    data: { username: USERNAME, password },
  });
  const headers = res.headers();
  return {
    status: res.status(),
    // Better Auth's limiter, and CPM's account throttle: two headers tell them apart.
    retryAfter: Number(headers['x-retry-after'] ?? 0),
    accountRetryAfter: Number(headers['retry-after'] ?? 0),
    body: await res.text(),
  };
}

/** Waits out whichever limit answered, so the attempt is judged on its password. */
async function signInPastLimits(request: APIRequestContext, password: string) {
  for (let tries = 0; tries < 6; tries++) {
    const attempt = await signIn(request, password);
    if (attempt.status !== 429) return attempt;
    const wait = Math.max(attempt.retryAfter, attempt.accountRetryAfter);
    await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
  }
  throw new Error('the sign-in limits never reopened');
}

test.describe('Sign-in rate limiting', () => {
  test.setTimeout(120_000);

  // Both counters live in the process: a restart is the only clean slate a rerun can have.
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    execFileSync('docker', [...COMPOSE_ARGS, 'restart', 'web-ratelimit'], {
      cwd: COMPOSE_CWD,
      stdio: 'pipe',
    });
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(`${BASE}/api/health`)).status;
          } catch {
            return 0;
          }
        },
        { timeout: 90_000, intervals: [1_000] },
      )
      .toBe(200);
  });

  test('the fourth sign-in inside ten seconds is refused, and the next window opens', async ({
    request,
  }) => {
    for (let i = 0; i < 3; i++) {
      expect((await signIn(request, 'WrongPassword!1')).status).toBe(401);
    }
    const limited = await signIn(request, PASSWORD);
    expect(limited.status).toBe(429);
    expect(limited.retryAfter).toBeGreaterThan(0);
    // Better Auth's limiter, which a lock is told apart from by its code.
    expect(JSON.parse(limited.body).code).toBeUndefined();
    expect(limited.retryAfter).toBeLessThanOrEqual(10);

    // The limiter's own wait, from its header: nothing to poll without spending the next window.
    await new Promise((r) => setTimeout(r, (limited.retryAfter + 1) * 1000));
    expect((await signIn(request, PASSWORD)).status).toBe(200);
  });

  test('an account is slowed after five failures, says so on the form, and recovers', async ({
    request,
    page,
  }) => {
    // Seven failures: the sixth locks for 1s, the seventh for 2s - past the free ones either way.
    for (let i = 0; i < 6; i++) {
      expect((await signInPastLimits(request, `WrongPassword!${i}`)).status).toBe(401);
    }

    await page.goto('/login');
    await waitForHydration(page);
    // The form is ready before the lock starts, so the click lands inside it.
    await page.getByRole('textbox', { name: /username/i }).fill(USERNAME);
    await page.getByRole('button', { name: /^continue$/i }).click();
    await page.getByRole('textbox', { name: /password/i }).fill(PASSWORD);

    const seventh = await signInPastLimits(request, 'WrongPassword!7');
    expect(seventh.status).toBe(401);
    const locked = await signIn(request, PASSWORD);
    expect(locked.status, 'the right password is refused while the account is locked').toBe(429);
    expect(locked.accountRetryAfter).toBeGreaterThan(0);
    expect(JSON.parse(locked.body)).toMatchObject({
      code: 'ACCOUNT_LOCKED',
      retryAfter: locked.accountRetryAfter,
    });

    // The lock's own wording and wait, not the per-address limiter's generic one.
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await expect(
      page.getByRole('alert').filter({
        hasText: /too many login attempts for this account\. try again in \d+ seconds?\./i,
      }),
    ).toBeVisible({ timeout: 10_000 });

    await new Promise((r) => setTimeout(r, (locked.accountRetryAfter + 1) * 1000));
    expect((await signInPastLimits(request, PASSWORD)).status).toBe(200);
    // A success clears the account's count: one more typo is free again.
    expect((await signInPastLimits(request, 'WrongPassword!8')).status).toBe(401);
    expect((await signInPastLimits(request, PASSWORD)).status).toBe(200);
  });
});
