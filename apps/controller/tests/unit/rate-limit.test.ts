import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { fresh } from '@/tests/helpers/fresh';

// Reloaded per test so the in-memory Map is cleared.
let registerFailedAttempt: typeof import('@/src/lib/rate-limit').registerFailedAttempt;
let isRateLimited: typeof import('@/src/lib/rate-limit').isRateLimited;
let resetAttempts: typeof import('@/src/lib/rate-limit').resetAttempts;

beforeEach(async () => {
  const mod = await import(`@/src/lib/rate-limit${fresh()}`);
  registerFailedAttempt = mod.registerFailedAttempt;
  isRateLimited = mod.isRateLimited;
  resetAttempts = mod.resetAttempts;
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

    resetAttempts(KEY);
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
  let mod: typeof import('@/src/lib/rate-limit');

  beforeEach(async () => {
    mod = await import(`@/src/lib/rate-limit${fresh()}`);
  });

  it('keys the portal username and the dashboard email to the same account', () => {
    expect(mod.accountKey(' Alice ')).toBe('alice@localhost');
    expect(mod.accountKey('ALICE@localhost')).toBe('alice@localhost');
  });

  it('lets a few typos through, then backs off exponentially up to a cap', () => {
    const account = mod.accountKey('alice');
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect(mod.registerAccountFailure(account, t0)).toBe(0);
    expect(mod.accountRetryAfterMs(account, t0)).toBe(0);

    expect(mod.registerAccountFailure(account, t0)).toBe(1_000);
    expect(mod.registerAccountFailure(account, t0)).toBe(2_000);
    expect(mod.registerAccountFailure(account, t0)).toBe(4_000);
    expect(mod.accountRetryAfterMs(account, t0 + 1_000)).toBe(3_000);

    for (let i = 0; i < 40; i++) mod.registerAccountFailure(account, t0);
    expect(mod.accountRetryAfterMs(account, t0)).toBe(mod.ACCOUNT_MAX_DELAY_MS);
    // Capped, not permanent, so the owner is never locked out for good.
    expect(mod.accountRetryAfterMs(account, t0 + mod.ACCOUNT_MAX_DELAY_MS)).toBe(0);
  });

  it('is independent of the address the guesses come from, and resets on success', () => {
    const account = mod.accountKey('bob');
    for (let i = 0; i < 6; i++) mod.registerAccountFailure(account);
    expect(mod.accountRetryAfterMs(account)).toBeGreaterThan(0);
    expect(mod.accountRetryAfterMs(mod.accountKey('carol'))).toBe(0);

    mod.resetAccountFailures(account);
    expect(mod.accountRetryAfterMs(account)).toBe(0);
  });
});

describe('fixed windows', () => {
  it('allows `limit` events per window, then refuses until the window rolls over', async () => {
    const mod = await import(`@/src/lib/rate-limit${fresh()}`);
    const t0 = 5_000_000;
    for (let i = 0; i < 3; i++) expect(mod.takeFromWindow('w', 3, 1_000, t0)).toBe(true);
    expect(mod.takeFromWindow('w', 3, 1_000, t0 + 999)).toBe(false);
    expect(mod.takeFromWindow('other', 3, 1_000, t0)).toBe(true);
    expect(mod.takeFromWindow('w', 3, 1_000, t0 + 1_000)).toBe(true);
  });
});
