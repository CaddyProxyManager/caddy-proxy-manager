/**
 * The notification state and every change to it, as pure functions of the state and `now`: what
 * is queued, which problems were told about and are not over yet, what is quiet for a while.
 * Each returns the same object when nothing changes, so the caller can skip the write.
 */

import type { NotificationEvent } from "./events";

export type PendingNotice = {
  id: string;
  /** What deduplicates it: one open problem, or one quiet period, per key. */
  key: string;
  /** ISO, when it happened. */
  at: string;
  event: NotificationEvent;
  /** Audience keys it already reached, so a retried batch goes only to the rest. */
  delivered?: string[];
};

export type NotificationState = {
  /** Queued, oldest first; kept through failed sends until MAX_PENDING_AGE_MS. */
  pending: PendingNotice[];
  /**
   * Problems told about (or queued) and not over yet. `noticeId` is the queued alert, until a
   * send picks it up; a problem over before then is dropped without either email.
   */
  open: Record<string, { at: string; noticeId: string | null; event?: NotificationEvent }>;
  /** When a one-off key may be queued again, or "never". */
  quiet: Record<string, string>;
  /** Consecutive failures of a job only worth telling about once it keeps failing. */
  streaks: Record<string, number>;
  lastSentAt: string | null;
  /** English, as the SMTP server or the job said it; null after a good send. */
  lastError: string | null;
  lastErrorAt: string | null;
  /** Set when nothing was sent because there was no one to send to. */
  lastErrorCode: "noRecipients" | null;
  /** No send before this, after a failed one. */
  retryAt: string | null;
};

/** Everything raised within it goes out as one email. */
export const BATCH_MS = 60_000;
export const RETRY_MS = 5 * 60_000;
/** A notice this old is stale news: dropped rather than sent after a long outage. */
export const MAX_PENDING_AGE_MS = 24 * 60 * 60_000;
/** Bounds the stored row whatever an agent reports; the oldest go first. */
export const MAX_PENDING = 100;
export const MAX_BATCH = 50;

export const EMPTY_STATE: NotificationState = {
  pending: [],
  open: {},
  quiet: {},
  streaks: {},
  lastSentAt: null,
  lastError: null,
  lastErrorAt: null,
  lastErrorCode: null,
  retryAt: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A hand-edited or older row reads as far as it goes rather than failing every notification. */
export function normalizeState(stored: unknown): NotificationState {
  if (!isRecord(stored)) return EMPTY_STATE;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    pending: Array.isArray(stored.pending)
      ? (stored.pending as unknown[]).filter(
          (notice): notice is PendingNotice =>
            isRecord(notice) &&
            typeof notice.id === "string" &&
            typeof notice.key === "string" &&
            typeof notice.at === "string" &&
            isRecord(notice.event) &&
            typeof notice.event.kind === "string",
        )
      : [],
    open: isRecord(stored.open) ? (stored.open as NotificationState["open"]) : {},
    quiet: isRecord(stored.quiet) ? (stored.quiet as NotificationState["quiet"]) : {},
    streaks: isRecord(stored.streaks) ? (stored.streaks as NotificationState["streaks"]) : {},
    lastSentAt: text(stored.lastSentAt),
    lastError: text(stored.lastError),
    lastErrorAt: text(stored.lastErrorAt),
    lastErrorCode: stored.lastErrorCode === "noRecipients" ? "noRecipients" : null,
    retryAt: text(stored.retryAt),
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

function enqueue(pending: PendingNotice[], notice: PendingNotice): PendingNotice[] {
  const next = [...pending, notice];
  return next.length > MAX_PENDING ? next.slice(next.length - MAX_PENDING) : next;
}

/** A one-off: queued unless the key is still quiet from last time. `quietMs` 0 never is. */
export function planNotice(
  state: NotificationState,
  input: { key: string; event: NotificationEvent; quietMs: number | "forever" },
  now: number,
  id: string,
): NotificationState {
  const until = state.quiet[input.key];
  if (until === "never" || (until && Date.parse(until) > now)) return state;
  const quiet = { ...state.quiet };
  for (const [key, value] of Object.entries(quiet)) {
    if (value !== "never" && Date.parse(value) <= now) delete quiet[key];
  }
  if (input.quietMs === "forever") quiet[input.key] = "never";
  else if (input.quietMs > 0) quiet[input.key] = iso(now + input.quietMs);
  return {
    ...state,
    quiet,
    pending: enqueue(state.pending, { id, key: input.key, at: iso(now), event: input.event }),
  };
}

/** A problem that lasts: told once, until `planResolve` says it is over. */
export function planRaise(
  state: NotificationState,
  key: string,
  event: NotificationEvent,
  now: number,
  id: string,
): NotificationState {
  if (key in state.open) return state;
  return {
    ...state,
    open: { ...state.open, [key]: { at: iso(now), noticeId: id, event } },
    pending: enqueue(state.pending, { id, key, at: iso(now), event }),
  };
}

/**
 * Over: the recovery is queued once, if the alert went out. An alert still waiting for its batch
 * is withdrawn instead, so a blip costs no email at all.
 */
/** Built from the event that raised it, e.g. to name the agent again; null for none. */
export type Recovery =
  | NotificationEvent
  | null
  | ((raised: NotificationEvent | undefined) => NotificationEvent | null);

export function planResolve(
  state: NotificationState,
  key: string,
  recoveryOrBuild: Recovery,
  now: number,
  id: string,
): NotificationState {
  const problem = state.open[key];
  if (!problem) return state;
  const recovery =
    typeof recoveryOrBuild === "function" ? recoveryOrBuild(problem.event) : recoveryOrBuild;
  const open = { ...state.open };
  delete open[key];
  const queued = problem.noticeId && state.pending.some((notice) => notice.id === problem.noticeId);
  if (queued) {
    return {
      ...state,
      open,
      pending: state.pending.filter((notice) => notice.id !== problem.noticeId),
    };
  }
  return {
    ...state,
    open,
    pending: recovery
      ? enqueue(state.pending, { id, key, at: iso(now), event: recovery })
      : state.pending,
  };
}

/** One more failure in a row; raised once the streak reaches `threshold`. */
export function planFailure(
  state: NotificationState,
  key: string,
  threshold: number,
  event: (failures: number) => NotificationEvent,
  now: number,
  id: string,
): NotificationState {
  const failures = (state.streaks[key] ?? 0) + 1;
  const counted = { ...state, streaks: { ...state.streaks, [key]: failures } };
  return failures >= threshold ? planRaise(counted, key, event(failures), now, id) : counted;
}

/** The streak is over, and so is the problem if it was raised. */
export function planSuccess(
  state: NotificationState,
  key: string,
  recovery: Recovery,
  now: number,
  id: string,
): NotificationState {
  if (!(key in state.streaks) && !(key in state.open)) return state;
  const streaks = { ...state.streaks };
  delete streaks[key];
  return planResolve({ ...state, streaks }, key, recovery, now, id);
}

function dropStale(pending: PendingNotice[], now: number): PendingNotice[] {
  const fresh = pending.filter((notice) => now - Date.parse(notice.at) < MAX_PENDING_AGE_MS);
  return fresh.length === pending.length ? pending : fresh;
}

/**
 * What to send now, if anything: once the oldest notice has waited out the batch window and no
 * retry is pending. The problems in it count as told from here, so a recovery follows them.
 */
export function planBatch(
  state: NotificationState,
  now: number,
): { batch: PendingNotice[]; state: NotificationState } | null {
  const pending = dropStale(state.pending, now);
  if (pending.length === 0) {
    return pending === state.pending ? null : { batch: [], state: { ...state, pending } };
  }
  if (state.retryAt && Date.parse(state.retryAt) > now) return null;
  if (now - Date.parse(pending[0].at) < BATCH_MS) return null;
  const batch = pending.slice(0, MAX_BATCH);
  const picked = new Set(batch.map((notice) => notice.id));
  const open = { ...state.open };
  for (const [key, problem] of Object.entries(open)) {
    if (problem.noticeId && picked.has(problem.noticeId))
      open[key] = { ...problem, noticeId: null };
  }
  return { batch, state: { ...state, pending, open } };
}

function without(state: NotificationState, ids: readonly string[]): PendingNotice[] {
  const gone = new Set(ids);
  return state.pending.filter((notice) => !gone.has(notice.id));
}

export function planSent(
  state: NotificationState,
  ids: readonly string[],
  now: number,
): NotificationState {
  return {
    ...state,
    pending: without(state, ids),
    lastSentAt: iso(now),
    lastError: null,
    lastErrorAt: null,
    lastErrorCode: null,
    retryAt: null,
  };
}

/** `reached` maps a notice id to the audience keys that now have it. */
export function planDelivered(
  state: NotificationState,
  reached: ReadonlyMap<string, readonly string[]>,
): NotificationState {
  if (reached.size === 0) return state;
  return {
    ...state,
    pending: state.pending.map((notice) => {
      const keys = reached.get(notice.id);
      return keys
        ? { ...notice, delivered: [...new Set([...(notice.delivered ?? []), ...keys])] }
        : notice;
    }),
  };
}

/** Kept for the retry, with the error for Settings to show. */
export function planSendFailed(
  state: NotificationState,
  error: string,
  now: number,
): NotificationState {
  return {
    ...state,
    lastError: error.slice(0, 500),
    lastErrorAt: iso(now),
    lastErrorCode: null,
    retryAt: iso(now + RETRY_MS),
  };
}

/** Dropped unsent: a switch turned off since, or nobody to send them to. */
export function planDropped(
  state: NotificationState,
  ids: readonly string[],
  now: number,
  reason: "noRecipients" | null,
): NotificationState {
  if (ids.length === 0 && reason === null) return state;
  return {
    ...state,
    pending: without(state, ids),
    ...(reason
      ? { lastError: null, lastErrorAt: iso(now), lastErrorCode: reason, retryAt: null }
      : {}),
  };
}
