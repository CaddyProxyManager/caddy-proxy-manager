/**
 * Sending what is due on the channels an administrator added: each on its own queue and its own
 * backoff, a message per batch. A send claims its rows first, so a leader that lost the lead mid
 * send and the one that took over never both post the same alert. Three failures in a row raise
 * the channel's own problem, reported through the other channels.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import db from "../db";
import { alertDeliveries, alertRules, notificationChannels } from "../db/schema";
import {
  claim,
  type QueuedDelivery,
  pendingDeliveries,
  settle,
  stillWanted,
  trimQueue,
} from "../notifications/flush";
import { BATCH_MS } from "../notifications/plan";
import { BATCH_SIZE, type Channel, channelRequest, parseChannel } from "./channels";
import { postJson } from "./channels/send";
import { alertBatch } from "./message";

/** Failures in a row before the channel counts as failing. */
export const CHANNEL_FAILING_STREAK = 3;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 60 * 60_000;

const iso = (ms: number) => new Date(ms).toISOString();

export function backoffMs(failures: number, retryAfterMs: number | null = null): number {
  const grown = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
  return Math.max(grown, retryAfterMs ?? 0);
}

export function failingKey(channelId: number): string {
  return `channel-failing:${channelId}`;
}

type RuleName = { name: string; settingKey: string | null };

export async function ruleNames(ids: readonly (number | null)[]): Promise<Map<number, RuleName>> {
  const wanted = [...new Set(ids.filter((id): id is number => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({ id: alertRules.id, name: alertRules.name, builtin: alertRules.builtin })
    .from(alertRules)
    .where(inArray(alertRules.id, wanted));
  const { categorySettingKeys } = await import("../notifications");
  const keys = await categorySettingKeys();
  return new Map(
    rows.map((row) => [
      row.id,
      {
        name: row.name,
        settingKey: row.builtin ? (keys[row.builtin as keyof typeof keys] ?? null) : null,
      },
    ]),
  );
}

async function record(
  rows: readonly QueuedDelivery[],
  now: number,
  outcome: { ok: true } | { ok: false; error: string },
): Promise<void> {
  const at = iso(now);
  for (const row of rows) {
    await db
      .update(alertDeliveries)
      .set({
        attempts: row.attempts + 1,
        ...(outcome.ok
          ? { status: "sent", sentAt: at, lastError: null }
          : { lastError: outcome.error.slice(0, 500) }),
        claimedBy: null,
        claimedUntil: null,
        updatedAt: at,
      })
      .where(eq(alertDeliveries.id, row.id));
  }
}

/** One channel's due batch, if any. Never throws. */
export async function flushChannel(channel: Channel, now: number): Promise<void> {
  if (channel.builtin || channel.kind === "email" || channel.kind === "push") return;
  if (channel.retryAt && Date.parse(channel.retryAt) > now) return;
  const queue = await trimQueue(await pendingDeliveries([channel.id]), now);
  if (queue.length === 0 || now - Date.parse(queue[0].at) < BATCH_MS) return;

  const take = queue.slice(0, BATCH_SIZE[channel.kind]);
  const claimed = await claim(
    take.map((row) => row.id),
    now,
  );
  const mine = take.filter((row) => claimed.has(row.id));
  if (mine.length === 0) return;
  const wanted = await stillWanted(mine);
  const drop = mine.filter((row) => !wanted.has(row.eventId));
  await settle(
    drop.map((row) => row.id),
    "dropped",
    now,
  );
  const rows = mine.filter((row) => wanted.has(row.eventId));
  if (rows.length === 0) return;

  const names = await ruleNames(rows.map((row) => row.ruleId));
  const batch = await alertBatch(
    rows.map((row) => ({
      id: row.eventId,
      at: row.at,
      event: row.event,
      severity: row.severity,
      rule: row.ruleId === null ? null : (names.get(row.ruleId) ?? null),
    })),
  );
  let result: Awaited<ReturnType<typeof postJson>>;
  try {
    const request = channelRequest(
      channel,
      batch,
      rows.map((row) => row.id),
      now,
    );
    result = await postJson(request.url, request.body, request.headers, {
      discord: request.discord,
    });
  } catch (error) {
    result = {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
      retryAfterMs: null,
    };
  }

  const at = iso(now);
  const { recordJobFailure, recordJobSuccess } = await import("../notifications");
  if (result.ok) {
    await record(rows, now, { ok: true });
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
      .where(eq(notificationChannels.id, channel.id));
    await recordJobSuccess(
      failingKey(channel.id),
      (raised) =>
        raised?.kind === "channelFailing"
          ? { kind: "channelRecovered", channelId: channel.id, channel: channel.name }
          : null,
      now,
    );
    return;
  }

  const failures = channel.failures + 1;
  const error = result.error;
  console.warn(`[alerts] sending to channel "${channel.name}" failed:`, error);
  await record(rows, now, { ok: false, error });
  await db
    .update(notificationChannels)
    .set({
      lastError: error.slice(0, 500),
      lastErrorAt: at,
      lastErrorCode: null,
      failures,
      retryAt: iso(now + backoffMs(failures, result.retryAfterMs)),
      updatedAt: at,
    })
    .where(eq(notificationChannels.id, channel.id));
  await recordJobFailure(
    failingKey(channel.id),
    CHANNEL_FAILING_STREAK,
    (streak) => ({
      kind: "channelFailing",
      channelId: channel.id,
      channel: channel.name,
      failures: streak,
      error: error.slice(0, 300),
    }),
    now,
  );
}

/** Every added channel; a disabled one's queue is dropped rather than left to go stale. */
export async function flushChannels(now: number): Promise<void> {
  const rows = await db
    .select()
    .from(notificationChannels)
    .where(isNull(notificationChannels.builtin));
  for (const row of rows) {
    try {
      if (!row.enabled) {
        await db
          .update(alertDeliveries)
          .set({ status: "dropped", updatedAt: iso(now) })
          .where(and(eq(alertDeliveries.channelId, row.id), eq(alertDeliveries.status, "pending")));
        continue;
      }
      await flushChannel(parseChannel(row), now);
    } catch (error) {
      console.error(`[alerts] could not send to channel "${row.name}":`, error);
    }
  }
}
