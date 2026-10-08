/**
 * Values held for the process. Every settings write, on any replica, ends in `invalidateProcessMemos`
 * here - setSetting, clearSetting, and invalidateSettingsCache for the paths that write the table
 * directly (staged apply, backup restore, config and migration import) - so a held setting is never
 * older than the last write. A `ttlMs` entry also expires on its own, for what no write announces,
 * such as traffic.
 */
type Entry = { pending: Promise<unknown>; expires: number };

const memos = new Map<string, Entry>();

/** A ceiling, for keys that roll over by the minute. */
const MAX_ENTRIES = 256;

export function processMemo<T>(
  key: string,
  load: () => Promise<T>,
  options: {
    /** Whether a loaded value is held; one it refuses is read again next time. */
    keep?: (value: T) => boolean;
    ttlMs?: number;
  } = {},
): Promise<T> {
  const now = Date.now();
  const hit = memos.get(key);
  if (hit && hit.expires > now) return hit.pending as Promise<T>;
  if (memos.size >= MAX_ENTRIES) {
    for (const [other, entry] of memos) if (entry.expires <= now) memos.delete(other);
    if (memos.size >= MAX_ENTRIES) memos.clear();
  }
  const pending = load();
  const entry = { pending, expires: options.ttlMs === undefined ? Infinity : now + options.ttlMs };
  memos.set(key, entry);
  pending.then(
    (value) => {
      if (options.keep && !options.keep(value) && memos.get(key) === entry) memos.delete(key);
    },
    () => {
      if (memos.get(key) === entry) memos.delete(key);
    },
  );
  return pending;
}

export function invalidateProcessMemos(): void {
  memos.clear();
}

/** For a value some other write than a setting makes stale: `key`, and every `key:...` under it. */
export function dropProcessMemo(key: string): void {
  for (const held of memos.keys())
    if (held === key || held.startsWith(`${key}:`)) memos.delete(held);
}

/** The held value, without loading it: for a writer folding its change into one already held. */
export function peekProcessMemo<T>(key: string): Promise<T> | null {
  const hit = memos.get(key);
  return hit && hit.expires > Date.now() ? (hit.pending as Promise<T>) : null;
}
