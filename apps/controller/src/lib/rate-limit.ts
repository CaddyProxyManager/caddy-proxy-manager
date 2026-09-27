type RateLimitEntry = {
  attempts: number;
  firstAttemptTimestamp: number;
  blockedUntil?: number;
};

type RateLimitOutcome = {
  blocked: boolean;
  retryAfterMs?: number;
};

const ATTEMPTS = new Map<string, RateLimitEntry>();

/**
 * Per call, so a settings change needs no restart (cached, so cheap). Imported lazily: a static
 * import would read process.env before a test's hoisted block could set it.
 */
async function limits(): Promise<{ maxAttempts: number; windowMs: number; blockMs: number }> {
  const [registry, { getSetting }] = await Promise.all([
    import("./settings/registry"),
    import("./settings/resolve"),
  ]);
  const [maxAttempts, windowMs, blockMs] = await Promise.all([
    getSetting(registry.loginMaxAttempts),
    getSetting(registry.loginWindowMs),
    getSetting(registry.loginBlockMs),
  ]);
  return { maxAttempts, windowMs, blockMs };
}

function getEntry(key: string, now: number, windowMs: number): RateLimitEntry | undefined {
  const entry = ATTEMPTS.get(key);
  if (!entry) {
    return undefined;
  }

  if (entry.blockedUntil && entry.blockedUntil <= now) {
    ATTEMPTS.delete(key);
    return undefined;
  }

  if (!entry.blockedUntil && entry.firstAttemptTimestamp + windowMs <= now) {
    ATTEMPTS.delete(key);
    return undefined;
  }

  return entry;
}

export async function isRateLimited(key: string): Promise<RateLimitOutcome> {
  const now = Date.now();
  const { windowMs } = await limits();
  const entry = getEntry(key, now, windowMs);
  if (!entry) {
    return { blocked: false };
  }

  if (entry.blockedUntil && entry.blockedUntil > now) {
    return { blocked: true, retryAfterMs: entry.blockedUntil - now };
  }

  return { blocked: false };
}

export async function registerFailedAttempt(key: string): Promise<RateLimitOutcome> {
  const now = Date.now();
  const { maxAttempts, windowMs, blockMs } = await limits();
  const existing = getEntry(key, now, windowMs);

  if (!existing) {
    ATTEMPTS.set(key, {
      attempts: 1,
      firstAttemptTimestamp: now,
    });
    return { blocked: false };
  }

  if (existing.blockedUntil && existing.blockedUntil > now) {
    return { blocked: true, retryAfterMs: existing.blockedUntil - now };
  }

  existing.attempts += 1;

  if (existing.attempts >= maxAttempts) {
    existing.attempts = 0;
    existing.firstAttemptTimestamp = now;
    existing.blockedUntil = now + blockMs;
    return { blocked: true, retryAfterMs: blockMs };
  }

  return { blocked: false };
}

export function resetAttempts(key: string): void {
  ATTEMPTS.delete(key);
}

// ─── Per account ─────────────────────────────────────────────────────────────

type AccountEntry = { failures: number; lockedUntil: number; lastFailureAt: number };

const ACCOUNTS = new Map<string, AccountEntry>();

/** So a few typos never slow a real person down. */
const ACCOUNT_FREE_FAILURES = 5;
const ACCOUNT_BASE_DELAY_MS = 1_000;
/** Capped rather than a hard lock: an attacker can slow the owner's sign-in, never shut it off. */
export const ACCOUNT_MAX_DELAY_MS = 15 * 60_000;
const ACCOUNT_FORGET_MS = 24 * 60 * 60_000;
/** Keys are attacker-chosen names, so the map is bounded; the least recently failed goes first. */
const MAX_TRACKED_ACCOUNTS = 10_000;

/** One key per account however it signed in: the portal's username and the dashboard's email. */
export function accountKey(emailOrUsername: string): string {
  const normalized = emailOrUsername.trim().toLowerCase();
  return normalized.includes("@") ? normalized : `${normalized}@localhost`;
}

/** 0 when it may try now. */
export function accountRetryAfterMs(account: string, now = Date.now()): number {
  const entry = ACCOUNTS.get(account);
  if (!entry) return 0;
  if (now - entry.lastFailureAt > ACCOUNT_FORGET_MS) {
    ACCOUNTS.delete(account);
    return 0;
  }
  return Math.max(0, entry.lockedUntil - now);
}

/** Returns the delay now imposed. */
export function registerAccountFailure(account: string, now = Date.now()): number {
  let entry = ACCOUNTS.get(account);
  if (!entry || now - entry.lastFailureAt > ACCOUNT_FORGET_MS) {
    entry = { failures: 0, lockedUntil: 0, lastFailureAt: now };
  }
  ACCOUNTS.delete(account);
  entry.failures += 1;
  entry.lastFailureAt = now;
  const over = entry.failures - ACCOUNT_FREE_FAILURES;
  if (over > 0) {
    entry.lockedUntil =
      now + Math.min(ACCOUNT_MAX_DELAY_MS, ACCOUNT_BASE_DELAY_MS * 2 ** (over - 1));
  }
  ACCOUNTS.set(account, entry);
  if (ACCOUNTS.size > MAX_TRACKED_ACCOUNTS) {
    const oldest = ACCOUNTS.keys().next().value;
    if (oldest !== undefined) ACCOUNTS.delete(oldest);
  }
  return Math.max(0, entry.lockedUntil - now);
}

export function resetAccountFailures(account: string): void {
  ACCOUNTS.delete(account);
}

// ─── Fixed windows ───────────────────────────────────────────────────────────

const WINDOWS = new Map<string, { count: number; resetAt: number }>();
const MAX_TRACKED_WINDOWS = 10_000;

/** False once that window is spent. */
export function takeFromWindow(key: string, limit: number, windowMs: number, now = Date.now()) {
  let entry = WINDOWS.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    WINDOWS.delete(key);
    WINDOWS.set(key, entry);
    if (WINDOWS.size > MAX_TRACKED_WINDOWS) {
      for (const [k, v] of WINDOWS) if (v.resetAt <= now) WINDOWS.delete(k);
      const oldest = WINDOWS.keys().next().value;
      if (WINDOWS.size > MAX_TRACKED_WINDOWS && oldest !== undefined) WINDOWS.delete(oldest);
    }
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

/** Without counting anything. */
export function windowSpent(key: string, limit: number, now = Date.now()): boolean {
  const entry = WINDOWS.get(key);
  return entry !== undefined && entry.resetAt > now && entry.count >= limit;
}

export function resetWindow(key: string): void {
  WINDOWS.delete(key);
}

/** Test seam: forget every window whose key starts with `prefix`. */
export function resetWindows(prefix: string): void {
  for (const key of WINDOWS.keys()) if (key.startsWith(prefix)) WINDOWS.delete(key);
}
