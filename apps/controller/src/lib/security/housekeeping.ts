/** Expired blocks every 30 seconds, so one lapses within a minute; old reviews once an hour. */

import { getRetentionDays } from "../clickhouse/client";
import { pruneExpiredBlockedSources } from "../models/blocked-sources";
import { pruneWafEventReviews } from "./waf-event";

const WAKE_MS = 30_000;
const REVIEW_PRUNE_EVERY = 120;

let timer: NodeJS.Timeout | null = null;
let running = false;
let ticks = 0;

export async function runSecurityHousekeeping(tick: number): Promise<void> {
  await pruneExpiredBlockedSources();
  if (tick % REVIEW_PRUNE_EVERY === 0) {
    // A review outlives its event by a day at most.
    await pruneWafEventReviews((await getRetentionDays()) + 1);
  }
}

/** Idempotent. A pass still running when the next wake comes is not overlapped. */
export function startSecurityHousekeeping(): void {
  if (timer) return;
  const wake = () => {
    if (running) return;
    running = true;
    void runSecurityHousekeeping(ticks++)
      .catch((error: unknown) => {
        console.error("[security] housekeeping pass failed:", error);
      })
      .finally(() => {
        running = false;
      });
  };
  wake();
  timer = setInterval(wake, WAKE_MS);
  timer.unref();
}
