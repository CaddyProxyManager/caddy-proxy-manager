/**
 * Expired blocks and access-list rules every 30 seconds, so one lapses within a minute; spent
 * nonces, lapsed rate limits and pairing secrets with them; old reviews and expired sign-in
 * sessions once an hour.
 */

import { pruneExpiredPairingSecrets } from "../agent/pairing-codes";
import { pruneRateLimitCounters } from "../auth/rate-limit";
import { getRetentionDays } from "../clickhouse/client";
import { pruneSpentNonces } from "../cluster/nonces";
import { pruneExpiredAccessListRules } from "../models/access-lists";
import { pruneExpiredBlockedSources } from "../models/blocked-sources";
import { pruneExpiredForwardAuthRows } from "../models/forward-auth";
import { pruneExpiredSessions } from "../models/sessions";
import { pruneWafEventReviews } from "./waf-event";

const WAKE_MS = 30_000;
const REVIEW_PRUNE_EVERY = 120;

let timer: NodeJS.Timeout | null = null;
let running = false;
let ticks = 0;

export async function runSecurityHousekeeping(tick: number): Promise<void> {
  await pruneExpiredBlockedSources();
  await pruneExpiredAccessListRules();
  await Promise.all([pruneSpentNonces(), pruneRateLimitCounters(), pruneExpiredPairingSecrets()]);
  if (tick % REVIEW_PRUNE_EVERY === 0) {
    // A review outlives its event by a day at most.
    await pruneWafEventReviews((await getRetentionDays()) + 1);
    await Promise.all([pruneExpiredSessions(), pruneExpiredForwardAuthRows()]);
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

/** On losing the lead (lib/cluster); a pass already running finishes. */
export function stopSecurityHousekeeping(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
