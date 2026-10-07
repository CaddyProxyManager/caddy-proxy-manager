/**
 * The single settings row notifications used to live in, read once and moved into the alert
 * tables. Deleted with RETURNING, so whichever replica gets there first moves it and the rest see
 * nothing; an older backup restored later brings it back and it moves again.
 */

import { eq } from "drizzle-orm";
import db from "../db";
import {
  alertDeliveries,
  alertEvents,
  alertKeys,
  notificationChannels,
  settings,
} from "../db/schema";
import type { Builtins } from "./builtins";
import { categoryOf, type NotificationEvent } from "./events";
import type { PendingNotice } from "./plan";

export const LEGACY_STATE_KEY = "admin_notifications";

export type LegacyState = {
  pending: PendingNotice[];
  open: Record<string, { at: string; noticeId: string | null; event?: NotificationEvent }>;
  quiet: Record<string, string>;
  streaks: Record<string, number>;
  lastSentAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastErrorCode: "noRecipients" | null;
  retryAt: string | null;
};

export const EMPTY_LEGACY_STATE: LegacyState = {
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

/** A hand-edited or older row reads as far as it goes rather than failing the move. */
export function normalizeLegacyState(stored: unknown): LegacyState {
  if (!isRecord(stored)) return EMPTY_LEGACY_STATE;
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
    open: isRecord(stored.open) ? (stored.open as LegacyState["open"]) : {},
    quiet: isRecord(stored.quiet) ? (stored.quiet as LegacyState["quiet"]) : {},
    streaks: isRecord(stored.streaks) ? (stored.streaks as LegacyState["streaks"]) : {},
    lastSentAt: text(stored.lastSentAt),
    lastError: text(stored.lastError),
    lastErrorAt: text(stored.lastErrorAt),
    lastErrorCode: stored.lastErrorCode === "noRecipients" ? "noRecipients" : null,
    retryAt: text(stored.retryAt),
  };
}

/**
 * Moves the row, if there is one. A queued notice becomes an event on its category's built-in
 * rule with a delivery to email and push, carrying who it already reached; one a send already
 * picked up counts as attempted, so resolving its problem sends the recovery as it did before.
 */
export async function moveLegacyState(builtins: Builtins, now: string): Promise<boolean> {
  const taken = await db
    .delete(settings)
    .where(eq(settings.key, LEGACY_STATE_KEY))
    .returning({ value: settings.value });
  if (taken.length === 0) return false;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(taken[0].value);
  } catch {
    // Unreadable: nothing to carry over.
  }
  const state = normalizeLegacyState(parsed);

  const waiting = new Set(
    Object.values(state.open).flatMap((problem) => (problem.noticeId ? [problem.noticeId] : [])),
  );
  const eventIds = new Map<string, number>();
  for (const notice of state.pending) {
    const category = categoryOf(notice.event);
    const rule = category ? builtins.rules.get(category) : undefined;
    const problem = state.open[notice.key]?.noticeId === notice.id;
    const [row] = await db
      .insert(alertEvents)
      .values({
        key: notice.key,
        ruleId: rule?.id ?? null,
        kind: notice.event.kind,
        category,
        severity: rule?.severity ?? "info",
        type: problem ? "problem" : "notice",
        event: JSON.stringify(notice.event),
        at: notice.at,
      })
      .returning({ id: alertEvents.id });
    eventIds.set(notice.id, row.id);
    const picked = !waiting.has(notice.id) && (notice.delivered?.length || state.retryAt);
    const reached = JSON.stringify(notice.delivered ?? []);
    await db.insert(alertDeliveries).values(
      [builtins.email, builtins.push].map((channelId) => ({
        eventId: row.id,
        channelId,
        attempts: picked ? 1 : 0,
        reached,
        createdAt: notice.at,
        updatedAt: now,
      })),
    );
  }

  const keys = new Set([
    ...Object.keys(state.open),
    ...Object.keys(state.quiet),
    ...Object.keys(state.streaks),
  ]);
  for (const key of keys) {
    const problem = state.open[key];
    const linked = problem?.noticeId ? eventIds.get(problem.noticeId) : undefined;
    const category = problem?.event ? categoryOf(problem.event) : null;
    const ruleId = category ? builtins.rules.get(category)?.id : undefined;
    const values = {
      openAt: problem?.at ?? null,
      openEvent: problem?.event ? JSON.stringify(problem.event) : null,
      openEventIds: JSON.stringify(linked === undefined ? [] : [linked]),
      openRuleIds: JSON.stringify(ruleId === undefined ? [] : [ruleId]),
      quietUntil: state.quiet[key] ?? null,
      streak: state.streaks[key] ?? 0,
      updatedAt: now,
    };
    await db
      .insert(alertKeys)
      .values({ key, ...values })
      .onConflictDoUpdate({ target: alertKeys.key, set: values });
  }

  await db
    .update(notificationChannels)
    .set({
      lastSentAt: state.lastSentAt,
      lastError: state.lastError,
      lastErrorAt: state.lastErrorAt,
      lastErrorCode: state.lastErrorCode,
      retryAt: state.retryAt,
      failures: state.retryAt ? 1 : 0,
      updatedAt: now,
    })
    .where(eq(notificationChannels.id, builtins.email));
  if (state.lastSentAt) {
    await db
      .update(notificationChannels)
      .set({ lastSentAt: state.lastSentAt, updatedAt: now })
      .where(eq(notificationChannels.id, builtins.push));
  }
  return true;
}
