/**
 * Guess limits are shared by every replica, in `rate_limit_counters`: a second controller holding
 * its own count would double what a guesser gets. Flood budgets (`takeFromWindow`) and in-flight
 * reservations stay per process, where N replicas only means N times the budget.
 */
import { and, eq, gt, inArray, isNull, like, lte, or, sql } from "drizzle-orm";
import db from "../db";
import { rateLimitCounters } from "../db/schema";

type RateLimitOutcome = {
  blocked: boolean;
  retryAfterMs?: number;
};

const counters = rateLimitCounters;
const ATTEMPT_PREFIX = "attempt:";
const ACCOUNT_PREFIX = "account:";
const SHARED_WINDOW_PREFIX = "window:";

/**
 * Per call, so a settings change needs no restart (cached, so cheap). Imported lazily: a static
 * import would read process.env before a test's hoisted block could set it.
 */
async function limits(): Promise<{ maxAttempts: number; windowMs: number; blockMs: number }> {
  const [registry, { getSetting }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);
  const [maxAttempts, windowMs, blockMs] = await Promise.all([
    getSetting(registry.loginMaxAttempts),
    getSetting(registry.loginWindowMs),
    getSetting(registry.loginBlockMs),
  ]);
  return { maxAttempts, windowMs, blockMs };
}

type Counter = { count: number; resetAt: number; blockedUntil: number | null };

/** A block that has run out, or an unblocked count past its window. */
function lapsed(row: Counter, now: number): boolean {
  return row.blockedUntil !== null ? row.blockedUntil <= now : row.resetAt <= now;
}

/** `lapsed` as SQL, for an upsert to start a lapsed row over in the same statement. */
function lapsedSql(now: number) {
  return sql`(case when ${counters.blockedUntil} is not null then ${counters.blockedUntil} <= ${now} else ${counters.resetAt} <= ${now} end)`;
}

async function readCounter(key: string): Promise<Counter | undefined> {
  const [row] = await db
    .select({
      count: counters.count,
      resetAt: counters.resetAt,
      blockedUntil: counters.blockedUntil,
    })
    .from(counters)
    .where(eq(counters.key, key))
    .limit(1);
  return row;
}

async function readAttempt(key: string, now: number): Promise<Counter | undefined> {
  const row = await readCounter(`${ATTEMPT_PREFIX}${key}`);
  return row && !lapsed(row, now) ? row : undefined;
}

export async function isRateLimited(key: string): Promise<RateLimitOutcome> {
  const now = Date.now();
  const entry = await readAttempt(key, now);
  if (entry?.blockedUntil && entry.blockedUntil > now) {
    return { blocked: true, retryAfterMs: entry.blockedUntil - now };
  }
  return { blocked: false };
}

export async function registerFailedAttempt(key: string): Promise<RateLimitOutcome> {
  const now = Date.now();
  const { maxAttempts, windowMs, blockMs } = await limits();
  const rowKey = `${ATTEMPT_PREFIX}${key}`;
  const fresh = lapsedSql(now);
  const [row] = await db
    .insert(counters)
    .values({ key: rowKey, count: 1, resetAt: now + windowMs, blockedUntil: null })
    .onConflictDoUpdate({
      target: counters.key,
      set: {
        count: sql`case when ${fresh} then 1 when ${counters.blockedUntil} is not null then ${counters.count} else ${counters.count} + 1 end`,
        resetAt: sql`case when ${fresh} then ${now + windowMs} else ${counters.resetAt} end`,
        blockedUntil: sql`case when ${fresh} then null else ${counters.blockedUntil} end`,
      },
    })
    .returning({ count: counters.count, blockedUntil: counters.blockedUntil });

  if (row?.blockedUntil && row.blockedUntil > now) {
    return { blocked: true, retryAfterMs: row.blockedUntil - now };
  }
  if (!row || row.count < maxAttempts) return { blocked: false };

  // The window starts over behind the block, as it always has.
  await db
    .update(counters)
    .set({ count: 0, resetAt: now + windowMs, blockedUntil: now + blockMs })
    .where(and(eq(counters.key, rowKey), isNull(counters.blockedUntil)));
  return { blocked: true, retryAfterMs: blockMs };
}

export async function resetAttempts(key: string): Promise<void> {
  await db.delete(counters).where(eq(counters.key, `${ATTEMPT_PREFIX}${key}`));
}

/** Attempts still being checked, per key; an entry lives only while its requests are in flight. */
const RESERVED = new Map<string, number>();

function holdSlot(map: Map<string, number>, key: string): () => void {
  map.set(key, (map.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (map.get(key) ?? 1) - 1;
    if (remaining > 0) map.set(key, remaining);
    else map.delete(key);
  };
}

/**
 * Holds a place for an attempt whose outcome is not known yet, so a concurrent burst cannot all
 * pass the check before any of it is counted. Null when blocked or already full. Release it once
 * the attempt ends, and register a failure separately.
 */
export async function reserveAttempt(key: string): Promise<(() => void) | null> {
  const { maxAttempts } = await limits();
  const now = Date.now();
  const entry = await readAttempt(key, now);
  if (entry?.blockedUntil && entry.blockedUntil > now) return null;
  if ((entry?.count ?? 0) + (RESERVED.get(key) ?? 0) >= maxAttempts) return null;
  return holdSlot(RESERVED, key);
}

// ─── Per account ─────────────────────────────────────────────────────────────

export type AccountLockPolicy = {
  enabled: boolean;
  /** So a few typos never slow a real person down. */
  freeFailures: number;
  baseDelayMs: number;
  /** Capped rather than a hard lock: an attacker can slow the owner's sign-in, never shut it off. */
  maxDelayMs: number;
  /** Failures before the account is disabled outright (lib/auth/account-failures.ts); null when off. */
  disableAfter: number | null;
};

export const DEFAULT_ACCOUNT_LOCK: AccountLockPolicy = {
  enabled: true,
  freeFailures: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 15 * 60_000,
  disableAfter: null,
};
/** From the last failure: a row's `resetAt`, past which security housekeeping prunes it. */
const ACCOUNT_FORGET_MS = 24 * 60 * 60_000;

/** Per call, like `limits`, so a settings change needs no restart. */
export async function accountLockPolicy(): Promise<AccountLockPolicy> {
  const [registry, { getSetting }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);
  const [enabled, freeFailures, baseDelayMs, maxDelayMs, disableEnabled, disableAfter] =
    await Promise.all([
      getSetting(registry.accountLockEnabled),
      getSetting(registry.accountLockFreeFailures),
      getSetting(registry.accountLockBaseDelayMs),
      getSetting(registry.accountLockMaxDelayMs),
      getSetting(registry.accountLockDisableEnabled),
      getSetting(registry.accountLockDisableAfter),
    ]);
  return {
    enabled,
    freeFailures,
    baseDelayMs,
    maxDelayMs,
    disableAfter: disableEnabled ? disableAfter : null,
  };
}

/** One key per account however it signed in: the portal's username and the dashboard's email. */
export function accountKey(emailOrUsername: string): string {
  const normalized = emailOrUsername.trim().toLowerCase();
  return normalized.includes("@") ? normalized : `${normalized}@localhost`;
}

async function readAccount(account: string, now: number): Promise<Counter | undefined> {
  const row = await readCounter(`${ACCOUNT_PREFIX}${account}`);
  return row && row.resetAt > now ? row : undefined;
}

/** 0 when it may try now. */
export async function accountRetryAfterMs(
  account: string,
  now = Date.now(),
  policy?: AccountLockPolicy,
): Promise<number> {
  const { enabled } = policy ?? (await accountLockPolicy());
  if (!enabled) return 0;
  const entry = await readAccount(account, now);
  return Math.max(0, (entry?.blockedUntil ?? 0) - now);
}

/** Returns the delay now imposed. */
export async function registerAccountFailure(
  account: string,
  now = Date.now(),
  policy?: AccountLockPolicy,
): Promise<number> {
  const { enabled, freeFailures, baseDelayMs, maxDelayMs, disableAfter } =
    policy ?? (await accountLockPolicy());
  // Counted with the lock off too, while auto-disable reads the count.
  if (!enabled && disableAfter === null) return 0;
  const key = `${ACCOUNT_PREFIX}${account}`;
  const forgotten = sql`${counters.resetAt} <= ${now}`;
  const [row] = await db
    .insert(counters)
    .values({ key, count: 1, resetAt: now + ACCOUNT_FORGET_MS, blockedUntil: null })
    .onConflictDoUpdate({
      target: counters.key,
      set: {
        count: sql`case when ${forgotten} then 1 else ${counters.count} + 1 end`,
        blockedUntil: sql`case when ${forgotten} then null else ${counters.blockedUntil} end`,
        resetAt: now + ACCOUNT_FORGET_MS,
      },
    })
    .returning({ count: counters.count, blockedUntil: counters.blockedUntil });
  let lockedUntil = row?.blockedUntil ?? 0;
  const over = (row?.count ?? 1) - freeFailures;
  if (enabled && over > 0) {
    lockedUntil = now + Math.min(maxDelayMs, baseDelayMs * 2 ** (over - 1));
    await db.update(counters).set({ blockedUntil: lockedUntil }).where(eq(counters.key, key));
  }
  return Math.max(0, lockedUntil - now);
}

export async function resetAccountFailures(account: string): Promise<void> {
  await db.delete(counters).where(eq(counters.key, `${ACCOUNT_PREFIX}${account}`));
}

/** Accounts made to wait right now. Keys include names nobody owns; the caller matches users. */
export async function lockedAccounts(
  now = Date.now(),
): Promise<{ account: string; until: number }[]> {
  const rows = await db
    .select({ key: counters.key, blockedUntil: counters.blockedUntil })
    .from(counters)
    .where(
      and(
        like(counters.key, `${ACCOUNT_PREFIX}%`),
        gt(counters.blockedUntil, now),
        gt(counters.resetAt, now),
      ),
    );
  return rows.map((row) => ({
    account: row.key.slice(ACCOUNT_PREFIX.length),
    until: row.blockedUntil ?? now,
  }));
}

/** Failures counted against the account since it last signed in, or was forgotten. */
export async function accountFailureCount(account: string, now = Date.now()): Promise<number> {
  return (await readAccount(account, now))?.count ?? 0;
}

/** Every key an account's names reach, so re-enabling it cannot leave a count behind. */
export async function resetAccountFailuresFor(
  names: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  const keys = names
    .filter((name): name is string => !!name?.trim())
    .map((name) => `${ACCOUNT_PREFIX}${accountKey(name)}`);
  if (keys.length > 0) await db.delete(counters).where(inArray(counters.key, keys));
}

const ACCOUNTS_RESERVED = new Map<string, number>();

/**
 * The account's side of `reserveAttempt`: in flight at once, no more than its free failures left,
 * and one at a time once past them, so a burst from many addresses waits out each delay.
 */
export async function reserveAccountAttempt(
  account: string,
  now = Date.now(),
  policy?: AccountLockPolicy,
): Promise<(() => void) | null> {
  const resolved = policy ?? (await accountLockPolicy());
  if (!resolved.enabled) return () => {};
  const entry = await readAccount(account, now);
  if ((entry?.blockedUntil ?? 0) > now) return null;
  const inFlight = Math.max(1, resolved.freeFailures - (entry?.count ?? 0));
  if ((ACCOUNTS_RESERVED.get(account) ?? 0) >= inFlight) return null;
  return holdSlot(ACCOUNTS_RESERVED, account);
}

// ─── Fixed windows ───────────────────────────────────────────────────────────

const WINDOWS = new Map<string, { count: number; resetAt: number }>();
const MAX_TRACKED_WINDOWS = 10_000;

/**
 * False once that window is spent. Fails closed when the table is full of live windows: evicting
 * the oldest would let a flood of fresh keys (reset requests for made-up identifiers, say) wipe
 * the budgets of everyone else.
 */
export function takeFromWindow(key: string, limit: number, windowMs: number, now = Date.now()) {
  let entry = WINDOWS.get(key);
  if (!entry || entry.resetAt <= now) {
    if (entry) WINDOWS.delete(key);
    if (WINDOWS.size >= MAX_TRACKED_WINDOWS) {
      for (const [k, v] of WINDOWS) if (v.resetAt <= now) WINDOWS.delete(k);
      if (WINDOWS.size >= MAX_TRACKED_WINDOWS) return false;
    }
    entry = { count: 0, resetAt: now + windowMs };
    WINDOWS.set(key, entry);
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

// ─── Shared windows ──────────────────────────────────────────────────────────

/** `takeFromWindow` across replicas, for a window that bounds guesses rather than load. */
export async function takeFromSharedWindow(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Promise<boolean> {
  const over = sql`${counters.resetAt} <= ${now}`;
  const [row] = await db
    .insert(counters)
    .values({ key: `${SHARED_WINDOW_PREFIX}${key}`, count: 1, resetAt: now + windowMs })
    .onConflictDoUpdate({
      target: counters.key,
      set: {
        count: sql`case when ${over} then 1 else ${counters.count} + 1 end`,
        resetAt: sql`case when ${over} then ${now + windowMs} else ${counters.resetAt} end`,
      },
    })
    .returning({ count: counters.count });
  return (row?.count ?? 0) <= limit;
}

/** Without counting anything. */
export async function sharedWindowSpent(
  key: string,
  limit: number,
  now = Date.now(),
): Promise<boolean> {
  const row = await readCounter(`${SHARED_WINDOW_PREFIX}${key}`);
  return row !== undefined && row.resetAt > now && row.count >= limit;
}

/** Test seam: forget every shared window whose key starts with `prefix`. */
export async function resetSharedWindows(prefix: string): Promise<void> {
  await db.delete(counters).where(like(counters.key, `${SHARED_WINDOW_PREFIX}${prefix}%`));
}

/** Security housekeeping, on the leader: rows nothing reads again. */
export async function pruneRateLimitCounters(now = Date.now()): Promise<void> {
  await db
    .delete(counters)
    .where(
      and(
        lte(counters.resetAt, now),
        or(isNull(counters.blockedUntil), lte(counters.blockedUntil, now)),
      ),
    );
}

/** Test seam: forget every attempt, account, reservation and window. */
export async function resetRateLimitsForTests(): Promise<void> {
  for (const map of [RESERVED, ACCOUNTS_RESERVED, WINDOWS]) map.clear();
  await db.delete(counters);
}
