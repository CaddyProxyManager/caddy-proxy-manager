import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { createTestDb } from '@/tests/helpers/db';
import { dbModuleMock } from '@/tests/helpers/db-module';

// Settings resolve through the database: its own, not the app's connection every file shares.
const testDb = await createTestDb();
vi.mock('@/src/lib/db', () => dbModuleMock(() => testDb));
import * as mod from '@/src/lib/auth/rate-limit';

const { registerFailedAttempt, isRateLimited, resetAttempts } = mod;

beforeEach(async () => {
  await mod.resetRateLimitsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rate-limit', () => {
  const KEY = 'test-ip-1';

  it('first attempt is not blocked', async () => {
    const result = await registerFailedAttempt(KEY);
    expect(result.blocked).toBe(false);
  });

  it('4 failed attempts are not blocked (below threshold of 5)', async () => {
    for (let i = 0; i < 4; i++) {
      const result = await registerFailedAttempt(KEY);
      expect(result.blocked).toBe(false);
    }
  });

  it('5th failed attempt triggers block', async () => {
    for (let i = 0; i < 4; i++) {
      await registerFailedAttempt(KEY);
    }
    const result = await registerFailedAttempt(KEY);
    expect(result.blocked).toBe(true);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('isRateLimited returns blocked after 5 failures', async () => {
    for (let i = 0; i < 5; i++) {
      await registerFailedAttempt(KEY);
    }
    const result = await isRateLimited(KEY);
    expect(result.blocked).toBe(true);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('isRateLimited returns not blocked for unknown key', async () => {
    const result = await isRateLimited('unknown-key-xyz');
    expect(result.blocked).toBe(false);
  });

  it('blocked entry unblocks after blockedUntil passes', async () => {
    for (let i = 0; i < 5; i++) {
      await registerFailedAttempt(KEY);
    }

    const future = Date.now() + 16 * 60 * 1000; // 16 minutes
    vi.spyOn(Date, 'now').mockReturnValue(future);

    const result = await isRateLimited(KEY);
    expect(result.blocked).toBe(false);
  });

  it('window expires without max attempts resets attempts', async () => {
    for (let i = 0; i < 3; i++) {
      await registerFailedAttempt(KEY);
    }

    const future = Date.now() + 6 * 60 * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(future);

    const result = await registerFailedAttempt(KEY);
    expect(result.blocked).toBe(false);
  });

  it('resetAttempts immediately unblocks a key', async () => {
    for (let i = 0; i < 5; i++) {
      await registerFailedAttempt(KEY);
    }
    expect((await isRateLimited(KEY)).blocked).toBe(true);

    await resetAttempts(KEY);
    expect((await isRateLimited(KEY)).blocked).toBe(false);
  });

  it('different keys do not interfere', async () => {
    const KEY_A = 'ip-a';
    const KEY_B = 'ip-b';

    for (let i = 0; i < 5; i++) {
      await registerFailedAttempt(KEY_A);
    }

    expect((await isRateLimited(KEY_A)).blocked).toBe(true);
    expect((await isRateLimited(KEY_B)).blocked).toBe(false);
  });
});

// Regression (H5): a limit keyed only on a client-chosen header allowed unlimited guesses.
describe('per-account backoff', () => {
  it('keys the portal username and the dashboard email to the same account', () => {
    expect(mod.accountKey(' Alice ')).toBe('alice@localhost');
    expect(mod.accountKey('ALICE@localhost')).toBe('alice@localhost');
  });

  it('lets a few typos through, then backs off exponentially up to a cap', async () => {
    const account = mod.accountKey('alice');
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect(await mod.registerAccountFailure(account, t0)).toBe(0);
    expect(await mod.accountRetryAfterMs(account, t0)).toBe(0);

    expect(await mod.registerAccountFailure(account, t0)).toBe(1_000);
    expect(await mod.registerAccountFailure(account, t0)).toBe(2_000);
    expect(await mod.registerAccountFailure(account, t0)).toBe(4_000);
    expect(await mod.accountRetryAfterMs(account, t0 + 1_000)).toBe(3_000);

    const cap = mod.DEFAULT_ACCOUNT_LOCK.maxDelayMs;
    for (let i = 0; i < 40; i++) await mod.registerAccountFailure(account, t0);
    expect(await mod.accountRetryAfterMs(account, t0)).toBe(cap);
    // Capped, not permanent, so the owner is never locked out for good.
    expect(await mod.accountRetryAfterMs(account, t0 + cap)).toBe(0);
  });

  it('is independent of the address the guesses come from, and resets on success', async () => {
    const account = mod.accountKey('bob');
    for (let i = 0; i < 6; i++) await mod.registerAccountFailure(account);
    expect(await mod.accountRetryAfterMs(account)).toBeGreaterThan(0);
    expect(await mod.accountRetryAfterMs(mod.accountKey('carol'))).toBe(0);

    await mod.resetAccountFailures(account);
    expect(await mod.accountRetryAfterMs(account)).toBe(0);
  });

  it('follows a policy with other free failures, first lock and cap', async () => {
    const policy = {
      enabled: true,
      freeFailures: 2,
      baseDelayMs: 500,
      maxDelayMs: 1_500,
      disableAfter: null,
    };
    const account = mod.accountKey('dave');
    const t0 = 2_000_000;
    expect(await mod.registerAccountFailure(account, t0, policy)).toBe(0);
    expect(await mod.registerAccountFailure(account, t0, policy)).toBe(0);
    expect(await mod.registerAccountFailure(account, t0, policy)).toBe(500);
    expect(await mod.registerAccountFailure(account, t0, policy)).toBe(1_000);
    expect(await mod.registerAccountFailure(account, t0, policy)).toBe(1_500);
    expect(await mod.registerAccountFailure(account, t0, policy)).toBe(1_500);
    expect(await mod.reserveAccountAttempt(account, t0, policy)).toBeNull();
    expect(await mod.reserveAccountAttempt(account, t0 + 1_500, policy)).not.toBeNull();
  });

  it('locks nothing while turned off, and a lock already held stops counting', async () => {
    const on = mod.DEFAULT_ACCOUNT_LOCK;
    const off = { ...on, enabled: false };
    const account = mod.accountKey('erin');
    const t0 = 3_000_000;
    for (let i = 0; i < 10; i++) await mod.registerAccountFailure(account, t0, on);
    expect(await mod.accountRetryAfterMs(account, t0, on)).toBeGreaterThan(0);

    expect(await mod.accountRetryAfterMs(account, t0, off)).toBe(0);
    expect(await mod.registerAccountFailure(account, t0, off)).toBe(0);
    for (let i = 0; i < 20; i++)
      expect(await mod.reserveAccountAttempt(account, t0, off)).not.toBeNull();
  });

  it('reads the policy from settings', async () => {
    const { invalidateSettingsCache } = await import('@/src/lib/settings/resolve');
    const touched = {
      ACCOUNT_LOCK_FREE_FAILURES: '1',
      ACCOUNT_LOCK_BASE_DELAY_MS: '2500',
      ACCOUNT_LOCK_MAX_DELAY_MS: '5000',
    };
    Object.assign(process.env, touched);
    invalidateSettingsCache();
    try {
      expect(await mod.accountLockPolicy()).toEqual({
        enabled: true,
        freeFailures: 1,
        baseDelayMs: 2_500,
        maxDelayMs: 5_000,
        disableAfter: null,
      });
      const account = mod.accountKey('frank');
      expect(await mod.registerAccountFailure(account, 4_000_000)).toBe(0);
      expect(await mod.registerAccountFailure(account, 4_000_000)).toBe(2_500);

      process.env.ACCOUNT_LOCK_ENABLED = 'false';
      invalidateSettingsCache();
      expect(await mod.accountRetryAfterMs(account, 4_000_000)).toBe(0);
    } finally {
      for (const name of [...Object.keys(touched), 'ACCOUNT_LOCK_ENABLED'])
        delete process.env[name];
      invalidateSettingsCache();
    }
  });

  it('reads the auto-disable threshold only while auto-disable is on', async () => {
    const { invalidateSettingsCache } = await import('@/src/lib/settings/resolve');
    process.env.ACCOUNT_LOCK_DISABLE_AFTER = '7';
    invalidateSettingsCache();
    try {
      expect((await mod.accountLockPolicy()).disableAfter).toBeNull();
      process.env.ACCOUNT_LOCK_DISABLE_ENABLED = 'true';
      invalidateSettingsCache();
      expect((await mod.accountLockPolicy()).disableAfter).toBe(7);
    } finally {
      delete process.env.ACCOUNT_LOCK_DISABLE_AFTER;
      delete process.env.ACCOUNT_LOCK_DISABLE_ENABLED;
      invalidateSettingsCache();
    }
  });

  it('counts with the lock off while auto-disable reads the count, and locks nothing', async () => {
    const policy = { ...mod.DEFAULT_ACCOUNT_LOCK, enabled: false, disableAfter: 3 };
    const account = mod.accountKey('gina');
    const t0 = 6_000_000;
    for (let i = 0; i < 8; i++)
      expect(await mod.registerAccountFailure(account, t0, policy)).toBe(0);
    expect(await mod.accountFailureCount(account, t0)).toBe(8);
    expect(await mod.accountRetryAfterMs(account, t0, policy)).toBe(0);
    // Forgotten a day after the last failure, as the lock is.
    expect(await mod.accountFailureCount(account, t0 + 24 * 60 * 60_000 + 1)).toBe(0);

    const off = { ...policy, disableAfter: null };
    await mod.registerAccountFailure(mod.accountKey('hank'), t0, off);
    expect(await mod.accountFailureCount(mod.accountKey('hank'), t0)).toBe(0);
  });

  it('forgets every key an account is reached by', async () => {
    const t0 = 7_000_000;
    for (const name of ['ivy@example.com', 'ivy', 'IVY@localhost']) {
      await mod.registerAccountFailure(mod.accountKey(name), t0);
    }
    await mod.resetAccountFailuresFor(['ivy@example.com', 'ivy', null]);
    expect(await mod.accountFailureCount(mod.accountKey('ivy@example.com'), t0)).toBe(0);
    expect(await mod.accountFailureCount(mod.accountKey('ivy'), t0)).toBe(0);
  });
});

describe('fixed windows', () => {
  it('allows `limit` events per window, then refuses until the window rolls over', async () => {
    const t0 = 5_000_000;
    for (let i = 0; i < 3; i++) expect(mod.takeFromWindow('w', 3, 1_000, t0)).toBe(true);
    expect(mod.takeFromWindow('w', 3, 1_000, t0 + 999)).toBe(false);
    expect(mod.takeFromWindow('other', 3, 1_000, t0)).toBe(true);
    expect(mod.takeFromWindow('w', 3, 1_000, t0 + 1_000)).toBe(true);
  });
});
