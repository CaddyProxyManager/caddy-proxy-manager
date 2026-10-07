/** The timing every channel's queue follows, and the shape a batch is rendered from. */

import type { NotificationEvent } from "./events";

export type PendingNotice = {
  id: string;
  /** What deduplicates it: one open problem, or one quiet period, per key. */
  key: string;
  /** ISO, when it happened. */
  at: string;
  event: NotificationEvent;
  /** Recipients it already reached, so a retried batch goes only to the rest. */
  delivered?: string[];
};

/** Everything raised within it goes out as one email. */
export const BATCH_MS = 60_000;
/** The built-in email's wait after a failed send, as it has always been. */
export const RETRY_MS = 5 * 60_000;
/** A notice this old is stale news: dropped rather than sent after a long outage. */
export const MAX_PENDING_AGE_MS = 24 * 60 * 60_000;
/** Bounds each channel's queue whatever an agent reports; the oldest go first. */
export const MAX_PENDING = 100;
export const MAX_BATCH = 50;
