/**
 * Waiting out a restart. A sampled outage alone misses a warm supervisor that exits and is healthy
 * again between two polls, so a changed boot id (see runtime/boot-id.ts) counts as a restart too.
 */

export type Health = { up: boolean; boot: string | null };

export type RestartOutcome = "restarted" | "stillRunning" | "notBack";

export type RestartWaitDeps = {
  health: () => Promise<Health>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollMs: number;
  shutdownBudgetMs: number;
  startupBudgetMs: number;
  cancelled?: () => boolean;
  /** The old process is gone; only startup is left to wait for. */
  onDown?: () => void;
};

/** `before` is the boot id read before the restart was asked for; null when it wasn't known. */
export async function waitForRestart(
  before: string | null,
  deps: RestartWaitDeps,
): Promise<RestartOutcome | null> {
  const { health, sleep, now, pollMs } = deps;
  const cancelled = deps.cancelled ?? (() => false);
  const replaced = (h: Health) => h.up && !!before && !!h.boot && h.boot !== before;

  let wentDown = false;
  const shutdownBy = now() + deps.shutdownBudgetMs;
  while (!cancelled() && now() < shutdownBy) {
    const h = await health();
    if (replaced(h)) return "restarted";
    if (!h.up) {
      wentDown = true;
      deps.onDown?.();
      break;
    }
    await sleep(pollMs);
  }
  if (cancelled()) return null;
  if (!wentDown) {
    const h = await health();
    if (replaced(h)) return "restarted";
    if (h.up) return "stillRunning";
  }

  const startupBy = now() + deps.startupBudgetMs;
  while (!cancelled() && now() < startupBy) {
    if ((await health()).up) return "restarted";
    await sleep(pollMs);
  }
  return cancelled() ? null : "notBack";
}
