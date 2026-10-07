/**
 * Sending what is due on the built-in email and push channels, together, as one batch: each
 * administrator by their own choices, the Recipients list as extra addresses, one email per
 * distinct set of notices. The two share one retry, as they always have.
 */

import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { replicaId } from "../cluster";
import db from "../db";
import { alertDeliveries, alertEvents, notificationChannels } from "../db/schema";
import { emailReady } from "../email/config";
import { sendEmail } from "../email/transport";
import { type Builtins, builtins } from "./builtins";
import { categoryOf, type NotificationCategory, type NotificationEvent } from "./events";
import {
  BATCH_MS,
  MAX_BATCH,
  MAX_PENDING,
  MAX_PENDING_AGE_MS,
  type PendingNotice,
  RETRY_MS,
} from "./plan";
import { jsonArray, loadRules, ruleSwitchedOn } from "./rules";

/** Longer than any send takes; a claim older than this is a worker that died mid-send. */
export const CLAIM_MS = 2 * 60_000;

const iso = (ms: number) => new Date(ms).toISOString();

export type QueuedDelivery = {
  id: number;
  eventId: number;
  channelId: number;
  attempts: number;
  reached: string[];
  ruleId: number | null;
  key: string;
  at: string;
  event: NotificationEvent;
  severity: string;
};

/** What is pending on these channels, in the order it was queued. */
export async function pendingDeliveries(channelIds: readonly number[]): Promise<QueuedDelivery[]> {
  const rows = await db
    .select({
      id: alertDeliveries.id,
      eventId: alertDeliveries.eventId,
      channelId: alertDeliveries.channelId,
      attempts: alertDeliveries.attempts,
      reached: alertDeliveries.reached,
      ruleId: alertEvents.ruleId,
      key: alertEvents.key,
      at: alertEvents.at,
      event: alertEvents.event,
      severity: alertEvents.severity,
    })
    .from(alertDeliveries)
    .innerJoin(alertEvents, eq(alertEvents.id, alertDeliveries.eventId))
    .where(
      and(
        inArray(alertDeliveries.channelId, [...channelIds]),
        eq(alertDeliveries.status, "pending"),
      ),
    )
    .orderBy(asc(alertEvents.id), asc(alertDeliveries.id));
  return rows.flatMap((row) => {
    try {
      return [
        {
          ...row,
          reached: jsonArray(row.reached).filter((key): key is string => typeof key === "string"),
          event: JSON.parse(row.event) as NotificationEvent,
        },
      ];
    } catch {
      return [];
    }
  });
}

export async function settle(
  ids: readonly number[],
  status: "sent" | "dropped" | "failed",
  now: number,
  lastError: string | null = null,
): Promise<void> {
  if (ids.length === 0) return;
  const at = iso(now);
  await db
    .update(alertDeliveries)
    .set({
      status,
      ...(status === "sent" && { sentAt: at }),
      ...(lastError !== null && { lastError }),
      claimedBy: null,
      claimedUntil: null,
      updatedAt: at,
    })
    .where(inArray(alertDeliveries.id, [...ids]));
}

/** Takes these deliveries for this worker; returns the ids it got. */
export async function claim(ids: readonly number[], now: number): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const at = iso(now);
  const rows = await db
    .update(alertDeliveries)
    .set({ claimedBy: replicaId(), claimedUntil: iso(now + CLAIM_MS), updatedAt: at })
    .where(
      and(
        inArray(alertDeliveries.id, [...ids]),
        eq(alertDeliveries.status, "pending"),
        or(isNull(alertDeliveries.claimedUntil), lt(alertDeliveries.claimedUntil, at)),
      ),
    )
    .returning({ id: alertDeliveries.id });
  return new Set(rows.map((row) => row.id));
}

/**
 * Stale news and the overflow past MAX_PENDING are dropped; what is left, oldest first. Shared by
 * every channel's queue.
 */
export async function trimQueue<T extends { id: number; at: string; eventId: number }>(
  queue: readonly T[],
  now: number,
  groupBy: (item: T) => number = (item) => item.eventId,
): Promise<T[]> {
  const stale = queue.filter((item) => now - Date.parse(item.at) >= MAX_PENDING_AGE_MS);
  let fresh = queue.filter((item) => now - Date.parse(item.at) < MAX_PENDING_AGE_MS);
  const groups = [...new Set(fresh.map(groupBy))];
  const overflow = new Set(groups.slice(0, Math.max(0, groups.length - MAX_PENDING)));
  const dropped = [...stale, ...fresh.filter((item) => overflow.has(groupBy(item)))];
  fresh = fresh.filter((item) => !overflow.has(groupBy(item)));
  await settle(
    dropped.map((item) => item.id),
    "dropped",
    now,
  );
  return fresh;
}

type Notice = PendingNotice & {
  eventId: number;
  ruleId: number | null;
  category: NotificationCategory | null;
  email?: QueuedDelivery;
  push?: QueuedDelivery;
};

async function channelRow(id: number) {
  const [row] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, id));
  return row;
}

/** Each event's rule is still on: a switch turned off since it was queued drops it unsent. */
export async function stillWanted(
  rows: readonly { eventId: number; ruleId: number | null }[],
): Promise<Set<number>> {
  const rules = await loadRules();
  const on = new Map<number, boolean>();
  const wanted = new Set<number>();
  for (const row of rows) {
    if (row.ruleId === null) {
      wanted.add(row.eventId);
      continue;
    }
    if (!on.has(row.ruleId)) {
      const rule = rules.find((candidate) => candidate.id === row.ruleId);
      on.set(row.ruleId, rule ? await ruleSwitchedOn(rule) : false);
    }
    if (on.get(row.ruleId)) wanted.add(row.eventId);
  }
  return wanted;
}

export async function flushBuiltin(now: number, ids?: Builtins): Promise<void> {
  const { email, push } = ids ?? (await builtins(now));
  const queue = await trimQueue(await pendingDeliveries([email, push]), now);
  if (queue.length === 0) return;
  const status = await channelRow(email);
  if (status?.retryAt && Date.parse(status.retryAt) > now) return;
  if (now - Date.parse(queue[0].at) < BATCH_MS) return;

  const byEvent = new Map<number, Notice>();
  for (const row of queue) {
    let notice = byEvent.get(row.eventId);
    if (!notice) {
      if (byEvent.size >= MAX_BATCH) continue;
      notice = {
        id: String(row.eventId),
        eventId: row.eventId,
        key: row.key,
        at: row.at,
        event: row.event,
        ruleId: row.ruleId,
        category: categoryOf(row.event),
        delivered: [],
      };
      byEvent.set(row.eventId, notice);
    }
    if (row.channelId === email) notice.email = row;
    else notice.push = row;
    notice.delivered = [...new Set([...(notice.delivered ?? []), ...row.reached])];
  }
  const claimed = await claim(
    queue.filter((row) => byEvent.has(row.eventId)).map((row) => row.id),
    now,
  );
  const batch = [...byEvent.values()].filter((notice) => {
    if (notice.email && !claimed.has(notice.email.id)) notice.email = undefined;
    if (notice.push && !claimed.has(notice.push.id)) notice.push = undefined;
    return notice.email || notice.push;
  });
  if (batch.length === 0) return;
  const rowsOf = (notices: readonly Notice[]) =>
    notices.flatMap((notice) =>
      [notice.email, notice.push].flatMap((row) => (row ? [row.id] : [])),
    );

  const ready = await emailReady();
  const { notificationAudiences, audienceWants } = await import("./audience");
  const audiences = await notificationAudiences({ email: ready });
  const wanted = await stillWanted(batch);
  const keep = batch.filter(
    (notice) => (ready || audiences.length > 0) && wanted.has(notice.eventId),
  );
  const drop = batch.filter((notice) => !keep.includes(notice));
  await settle(rowsOf(drop), "dropped", now);
  if (keep.length === 0) return;
  if (audiences.length === 0) {
    await settle(rowsOf(keep), "dropped", now);
    await db
      .update(notificationChannels)
      .set({
        lastError: null,
        lastErrorAt: iso(now),
        lastErrorCode: "noRecipients",
        retryAt: null,
        updatedAt: iso(now),
      })
      .where(eq(notificationChannels.id, email));
    return;
  }

  const owed = (
    audience: { key: string; kind: "email" | "push" },
    wants: (category: NotificationCategory | null) => boolean,
  ) =>
    keep.filter(
      (notice) =>
        notice[audience.kind] !== undefined &&
        !notice.delivered?.includes(audience.key) &&
        wants(notice.category),
    );
  const reached = new Map<number, string[]>();
  const mark = (notices: readonly Notice[], keys: readonly string[]) => {
    for (const notice of notices)
      reached.set(notice.eventId, [...(reached.get(notice.eventId) ?? []), ...keys]);
  };

  // Once each: a failed email is retried, a push is not worth repeating.
  // In parallel: each waits on push services; one shared cache renders each payload once.
  const { sendPush } = await import("./push");
  const payloads = new Map<string, string>();
  await Promise.all(
    audiences.map(async (audience) => {
      if (audience.kind !== "push") return;
      const notices = owed(audience, (category) => audienceWants(audience, category));
      if (notices.length === 0) return;
      await sendPush(notices, audience.targets, payloads);
      mark(notices, [audience.key]);
    }),
  );

  // One email per distinct set of notices, so muting a category costs no one else their copy.
  const emails = new Map<string, { notices: Notice[]; to: string[]; keys: string[] }>();
  for (const audience of audiences) {
    if (audience.kind !== "email") continue;
    const notices = owed(audience, (category) => audienceWants(audience, category));
    if (notices.length === 0) continue;
    const signature = notices.map((notice) => notice.id).join(",");
    const entry = emails.get(signature) ?? { notices, to: [], keys: [] };
    entry.to.push(audience.address);
    entry.keys.push(audience.key);
    emails.set(signature, entry);
  }
  let failure: string | null = null;
  if (emails.size > 0) {
    const { notificationEmail } = await import("./email");
    for (const entry of emails.values()) {
      try {
        await sendEmail(await notificationEmail({ to: entry.to, notices: entry.notices }));
        mark(entry.notices, entry.keys);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
    }
  }

  const at = iso(now);
  if (failure !== null) {
    const message = failure.slice(0, 500);
    console.error("[notifications] send failed; retrying later:", message);
    for (const notice of keep) {
      const keys = [
        ...new Set([...(notice.delivered ?? []), ...(reached.get(notice.eventId) ?? [])]),
      ];
      for (const row of [notice.email, notice.push]) {
        if (!row) continue;
        await db
          .update(alertDeliveries)
          .set({
            attempts: row.attempts + 1,
            reached: JSON.stringify(keys),
            lastError: row === notice.email ? message : null,
            claimedBy: null,
            claimedUntil: null,
            updatedAt: at,
          })
          .where(eq(alertDeliveries.id, row.id));
      }
    }
    await db
      .update(notificationChannels)
      .set({
        lastError: message,
        lastErrorAt: at,
        lastErrorCode: null,
        retryAt: iso(now + RETRY_MS),
        failures: (status?.failures ?? 0) + 1,
        updatedAt: at,
      })
      .where(eq(notificationChannels.id, email));
    return;
  }

  for (const notice of keep) {
    for (const row of [notice.email, notice.push]) {
      if (!row) continue;
      await db
        .update(alertDeliveries)
        .set({ attempts: row.attempts + 1, updatedAt: at })
        .where(eq(alertDeliveries.id, row.id));
    }
  }
  await settle(rowsOf(keep), "sent", now);
  await db
    .update(notificationChannels)
    .set({
      lastSentAt: at,
      lastError: null,
      lastErrorAt: null,
      lastErrorCode: null,
      retryAt: null,
      failures: 0,
      updatedAt: at,
    })
    .where(inArray(notificationChannels.id, [email, push]));
}
