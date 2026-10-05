/**
 * Reads shared by the layouts, the page and its metadata, done once per page render. React's
 * `cache()` does not memoise under vinext, and vinext's request scope also spans a server action,
 * where a read after a write must see the write - so only the render phase is memoised.
 */
import { cacheForRequest } from "vinext/cache";
import { getHeadersAccessPhase } from "vinext/shims/headers";

const store = cacheForRequest(() => new Map<string, Promise<unknown>>());

function rendering(): boolean {
  try {
    return getHeadersAccessPhase() === "render";
  } catch {
    return false;
  }
}

/** Outside a request (tests, startup, background jobs) `load` runs every time. */
export function requestMemo<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (!rendering()) return load();
  const memo = store();
  const hit = memo.get(key);
  if (hit) return hit as Promise<T>;
  const pending = load();
  memo.set(key, pending);
  // A failure is not remembered: the next caller tries again, as it would have without this.
  pending.catch(() => {
    if (memo.get(key) === pending) memo.delete(key);
  });
  return pending;
}

/** After a write in this request, so a later read in the same render does not see the old value. */
export function forgetRequestMemo(prefix: string): void {
  const memo = store();
  for (const key of memo.keys()) if (key.startsWith(prefix)) memo.delete(key);
}
