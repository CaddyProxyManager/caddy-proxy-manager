/**
 * The notification state in the alert tables: per key, what is open, quiet or failing; per event,
 * one row for each rule it matched and one delivery for each channel. Every change to a key is a
 * compare-and-swap on the column it turns on, so two replicas raising the same problem tell it once.
 */

import { and, eq, inArray, isNotNull, isNull, like, lt, ne, or, sql } from "drizzle-orm";
import db from "../db";
import { alertDeliveries, alertEvents, alertKeys, notificationChannels } from "../db/schema";
import { type Builtins, builtins } from "./builtins";
import { categoryOf, type NotificationEvent } from "./events";
import {
  type AlertRule,
  jsonArray,
  loadRules,
  ruleSilenced,
  ruleSwitchedOn,
  rulesForEvent,
} from "./rules";

export type EventType = "notice" | "problem" | "recovery";

/** Built from the event that raised it, e.g. to name the agent again; null for none. */
export type Recovery =
  | NotificationEvent
  | null
  | ((raised: NotificationEvent | undefined) => NotificationEvent | null);

const iso = (ms: number) => new Date(ms).toISOString();

type KeyRow = typeof alertKeys.$inferSelect;

async function readKey(key: string): Promise<KeyRow | null> {
  const [row] = await db.select().from(alertKeys).where(eq(alertKeys.key, key));
  return row ?? null;
}

function numbers(text: string): number[] {
  return jsonArray(text).filter((value): value is number => typeof value === "number");
}

/** Email and push are ready together: either can carry what the built-in rules send. */
async function builtinReady(): Promise<boolean> {
  const { notificationChannelReady } = await import("./index");
  return notificationChannelReady();
}

type Route = { rule: AlertRule; channels: number[] };

/**
 * The rules worth recording an event for: on, not silenced, not in their own quiet period for this
 * key, with at least one channel that could carry it. None means the event is not wanted at all.
 */
export async function routesFor(
  event: NotificationEvent,
  key: string,
  now: number,
  /** A rule that watches something itself (attention, signals, metrics) raises for itself only. */
  only?: AlertRule,
): Promise<Route[]> {
  const rules = only
    ? (await ruleSwitchedOn(only)) && !ruleSilenced(only, now)
      ? [only]
      : []
    : await rulesForEvent(event, now);
  if (rules.length === 0) return [];
  const channels = await db
    .select({
      id: notificationChannels.id,
      builtin: notificationChannels.builtin,
      enabled: notificationChannels.enabled,
    })
    .from(notificationChannels);
  let jointReady: Promise<boolean> | null = null;
  const ready = async (id: number) => {
    const channel = channels.find((row) => row.id === id);
    if (!channel?.enabled) return false;
    if (!channel.builtin) return true;
    jointReady ??= builtinReady();
    return jointReady;
  };
  // A failing channel is told about on the others, never on itself.
  const own =
    event.kind === "channelFailing" || event.kind === "channelRecovered" ? event.channelId : null;
  const routes: Route[] = [];
  for (const rule of rules) {
    if (rule.quietMinutes > 0) {
      const quiet = await readKey(ruleQuietKey(rule.id, key));
      if (quiet?.quietUntil && Date.parse(quiet.quietUntil) > now) continue;
    }
    const usable: number[] = [];
    for (const id of rule.channelIds) if (id !== own && (await ready(id))) usable.push(id);
    if (usable.length > 0) routes.push({ rule, channels: usable });
  }
  return routes;
}

function ruleQuietKey(ruleId: number, key: string): string {
  return `rule-quiet:${ruleId}:${key}`;
}

/**
 * One event row per route and a pending delivery per channel, each channel once however many
 * rules name it. Returns the events and the rules they came from.
 */
export async function recordEvent(
  key: string,
  event: NotificationEvent,
  type: EventType,
  routes: readonly Route[],
  now: number,
): Promise<{ eventIds: number[]; ruleIds: number[] }> {
  const at = iso(now);
  const covered = new Set<number>();
  const eventIds: number[] = [];
  const ruleIds: number[] = [];
  for (const { rule, channels } of routes) {
    const [row] = await db
      .insert(alertEvents)
      .values({
        key,
        ruleId: rule.id,
        kind: event.kind,
        category: categoryOf(event),
        severity: rule.severity,
        type,
        event: JSON.stringify(event),
        at,
      })
      .returning({ id: alertEvents.id });
    eventIds.push(row.id);
    ruleIds.push(rule.id);
    const fresh = channels.filter((id) => !covered.has(id));
    for (const id of fresh) covered.add(id);
    if (fresh.length > 0) {
      await db
        .insert(alertDeliveries)
        .values(
          fresh.map((channelId) => ({ eventId: row.id, channelId, createdAt: at, updatedAt: at })),
        );
    }
    if (rule.quietMinutes > 0) {
      const quietKey = ruleQuietKey(rule.id, key);
      const until = iso(now + rule.quietMinutes * 60_000);
      await db
        .insert(alertKeys)
        .values({ key: quietKey, quietUntil: until, updatedAt: at })
        .onConflictDoUpdate({ target: alertKeys.key, set: { quietUntil: until, updatedAt: at } });
    }
  }
  return { eventIds, ruleIds };
}

/** A one-off. The key stays quiet for `quietMs` ("forever": once and for all) after it is queued. */
export async function queueNotice(
  key: string,
  event: NotificationEvent,
  quietMs: number | "forever",
  now: number,
): Promise<void> {
  const routes = await routesFor(event, key, now);
  if (routes.length === 0) return;
  if (quietMs !== 0) {
    const row = await readKey(key);
    const until = row?.quietUntil ?? null;
    if (until === "never" || (until && Date.parse(until) > now)) return;
    const quietUntil = quietMs === "forever" ? "never" : iso(now + quietMs);
    const at = iso(now);
    const won = row
      ? await db
          .update(alertKeys)
          .set({ quietUntil, updatedAt: at })
          .where(
            and(
              eq(alertKeys.key, key),
              until === null ? isNull(alertKeys.quietUntil) : eq(alertKeys.quietUntil, until),
            ),
          )
          .returning({ key: alertKeys.key })
      : await db
          .insert(alertKeys)
          .values({ key, quietUntil, updatedAt: at })
          .onConflictDoNothing()
          .returning({ key: alertKeys.key });
    if (won.length === 0) return;
  }
  await recordEvent(key, event, "notice", routes, now);
}

/** A problem that lasts until `resolveOpen`; told once however often it is raised. */
export async function raiseOpen(
  key: string,
  event: NotificationEvent,
  now: number,
  only?: AlertRule,
): Promise<void> {
  const row = await readKey(key);
  if (row?.openAt) return;
  const routes = await routesFor(event, key, now, only);
  if (routes.length === 0) return;
  const at = iso(now);
  const open = { openAt: at, openEvent: JSON.stringify(event), updatedAt: at };
  const won = row
    ? await db
        .update(alertKeys)
        .set(open)
        .where(and(eq(alertKeys.key, key), isNull(alertKeys.openAt)))
        .returning({ key: alertKeys.key })
    : await db
        .insert(alertKeys)
        .values({ key, ...open })
        .onConflictDoNothing()
        .returning({ key: alertKeys.key });
  if (won.length === 0) return;
  const { eventIds, ruleIds } = await recordEvent(key, event, "problem", routes, now);
  await db
    .update(alertKeys)
    .set({ openEventIds: JSON.stringify(eventIds), openRuleIds: JSON.stringify(ruleIds) })
    .where(and(eq(alertKeys.key, key), eq(alertKeys.openAt, at)));
}

/**
 * Over. A channel still waiting to send the alert is withdrawn, so a blip costs it nothing; a
 * channel that already took it up gets the recovery.
 */
export async function resolveOpen(key: string, recovery: Recovery, now: number): Promise<void> {
  const row = await readKey(key);
  if (!row?.openAt) return;
  const at = iso(now);
  const won = await db
    .update(alertKeys)
    .set({ openAt: null, openEvent: null, openEventIds: "[]", openRuleIds: "[]", updatedAt: at })
    .where(
      and(
        eq(alertKeys.key, key),
        eq(alertKeys.openAt, row.openAt),
        eq(alertKeys.openEventIds, row.openEventIds),
      ),
    )
    .returning({ key: alertKeys.key });
  if (won.length === 0) return;

  const eventIds = numbers(row.openEventIds);
  const ruleIds = numbers(row.openRuleIds);
  const picked = new Map<number, number[]>();
  if (eventIds.length > 0) {
    await db.update(alertEvents).set({ resolvedAt: at }).where(inArray(alertEvents.id, eventIds));
    await db
      .update(alertDeliveries)
      .set({ status: "withdrawn", updatedAt: at })
      .where(
        and(
          inArray(alertDeliveries.eventId, eventIds),
          eq(alertDeliveries.status, "pending"),
          eq(alertDeliveries.attempts, 0),
          or(isNull(alertDeliveries.claimedUntil), lt(alertDeliveries.claimedUntil, at)),
        ),
      );
    const rows = await db
      .select({
        ruleId: alertEvents.ruleId,
        channelId: alertDeliveries.channelId,
      })
      .from(alertDeliveries)
      .innerJoin(alertEvents, eq(alertEvents.id, alertDeliveries.eventId))
      .where(
        and(inArray(alertDeliveries.eventId, eventIds), ne(alertDeliveries.status, "withdrawn")),
      );
    for (const { ruleId, channelId } of rows) {
      if (ruleId === null) continue;
      picked.set(ruleId, [...(picked.get(ruleId) ?? []), channelId]);
    }
  }

  let raised: NotificationEvent | undefined;
  try {
    raised = row.openEvent ? (JSON.parse(row.openEvent) as NotificationEvent) : undefined;
  } catch {
    raised = undefined;
  }
  const event = typeof recovery === "function" ? recovery(raised) : recovery;
  if (!event) return;

  const rules = await loadRules();
  let routeRules = ruleIds;
  if (routeRules.length === 0) {
    const category = categoryOf(event);
    const builtin = category ? (await builtins(now)).rules.get(category) : undefined;
    routeRules = builtin ? [builtin.id] : [];
  }
  const routes: Route[] = [];
  for (const ruleId of routeRules) {
    const rule = rules.find((candidate) => candidate.id === ruleId);
    if (!rule) continue;
    // A problem carried over from the settings row has no events: it was told everywhere.
    const channels = eventIds.length > 0 ? (picked.get(ruleId) ?? []) : rule.channelIds;
    if (channels.length > 0) routes.push({ rule, channels });
  }
  if (routes.length > 0) await recordEvent(key, event, "recovery", routes, now);
}

/** One more failure in a row; returns the streak. */
export async function countFailure(key: string, now: number): Promise<number> {
  const at = iso(now);
  const [row] = await db
    .insert(alertKeys)
    .values({ key, streak: 1, updatedAt: at })
    .onConflictDoUpdate({
      target: alertKeys.key,
      set: { streak: sql`${alertKeys.streak} + 1`, updatedAt: at },
    })
    .returning({ streak: alertKeys.streak });
  return row?.streak ?? 1;
}

/** The streak is over, and so is the problem if it was raised. */
export async function clearFailures(key: string, recovery: Recovery, now: number): Promise<void> {
  const row = await readKey(key);
  if (!row || (row.streak === 0 && !row.openAt)) return;
  if (row.streak !== 0) {
    await db
      .update(alertKeys)
      .set({ streak: 0, updatedAt: iso(now) })
      .where(eq(alertKeys.key, key));
  }
  await resolveOpen(key, recovery, now);
}

export async function openKeys(prefix: string): Promise<string[]> {
  const rows = await db
    .select({ key: alertKeys.key })
    .from(alertKeys)
    .where(and(isNotNull(alertKeys.openAt), like(alertKeys.key, `${prefix}%`)));
  return rows.map((row) => row.key).filter((key) => key.startsWith(prefix));
}

/** Keys that hold nothing any more, so the table does not grow with every one-off. */
export async function pruneKeys(now: number): Promise<void> {
  await db
    .delete(alertKeys)
    .where(
      and(
        isNull(alertKeys.openAt),
        eq(alertKeys.streak, 0),
        or(
          isNull(alertKeys.quietUntil),
          and(ne(alertKeys.quietUntil, "never"), lt(alertKeys.quietUntil, iso(now))),
        ),
      ),
    );
}

export type { Builtins };
