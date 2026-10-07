/** What was raised, resolved and told, newest first, with how each channel's delivery went. */

import { and, desc, eq, gte, inArray, lt, lte, type SQL } from "drizzle-orm";
import db from "../db";
import { alertDeliveries, alertEvents, alertRules, notificationChannels } from "../db/schema";
import type { NotificationEvent } from "../notifications/events";

export const HISTORY_PAGE = 50;

export type HistoryFilter = {
  ruleId?: number | null;
  channelId?: number | null;
  severity?: string | null;
  /** `notice`, `problem` or `recovery`. */
  type?: string | null;
  /** A delivery status: only events with a delivery in it. */
  status?: string | null;
  from?: string | null;
  to?: string | null;
  /** The last id of the previous page. */
  before?: number | null;
  limit?: number | null;
};

export type HistoryDelivery = {
  id: number;
  channelId: number;
  channelName: string;
  channelKind: string;
  status: string;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  updatedAt: string;
};

export type HistoryEvent = {
  id: number;
  key: string;
  ruleId: number | null;
  ruleName: string | null;
  ruleBuiltin: string | null;
  kind: string;
  category: string | null;
  severity: string;
  type: string;
  event: NotificationEvent;
  at: string;
  resolvedAt: string | null;
  deliveries: HistoryDelivery[];
};

export async function listHistory(filter: HistoryFilter = {}): Promise<HistoryEvent[]> {
  const limit = Math.min(Math.max(filter.limit ?? HISTORY_PAGE, 1), 200);
  const where: SQL[] = [];
  if (filter.ruleId) where.push(eq(alertEvents.ruleId, filter.ruleId));
  if (filter.severity) where.push(eq(alertEvents.severity, filter.severity));
  if (filter.type) where.push(eq(alertEvents.type, filter.type));
  if (filter.from) where.push(gte(alertEvents.at, filter.from));
  if (filter.to) where.push(lte(alertEvents.at, filter.to));
  if (filter.before) where.push(lt(alertEvents.id, filter.before));
  if (filter.channelId || filter.status) {
    const matching = db
      .select({ id: alertDeliveries.eventId })
      .from(alertDeliveries)
      .where(
        and(
          ...(filter.channelId ? [eq(alertDeliveries.channelId, filter.channelId)] : []),
          ...(filter.status ? [eq(alertDeliveries.status, filter.status)] : []),
        ),
      );
    where.push(inArray(alertEvents.id, matching));
  }
  const events = await db
    .select({
      id: alertEvents.id,
      key: alertEvents.key,
      ruleId: alertEvents.ruleId,
      ruleName: alertRules.name,
      ruleBuiltin: alertRules.builtin,
      kind: alertEvents.kind,
      category: alertEvents.category,
      severity: alertEvents.severity,
      type: alertEvents.type,
      event: alertEvents.event,
      at: alertEvents.at,
      resolvedAt: alertEvents.resolvedAt,
    })
    .from(alertEvents)
    .leftJoin(alertRules, eq(alertRules.id, alertEvents.ruleId))
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(desc(alertEvents.id))
    .limit(limit);
  if (events.length === 0) return [];
  const deliveries = await db
    .select({
      id: alertDeliveries.id,
      eventId: alertDeliveries.eventId,
      channelId: alertDeliveries.channelId,
      channelName: notificationChannels.name,
      channelKind: notificationChannels.kind,
      status: alertDeliveries.status,
      attempts: alertDeliveries.attempts,
      lastError: alertDeliveries.lastError,
      sentAt: alertDeliveries.sentAt,
      updatedAt: alertDeliveries.updatedAt,
    })
    .from(alertDeliveries)
    .innerJoin(notificationChannels, eq(notificationChannels.id, alertDeliveries.channelId))
    .where(
      inArray(
        alertDeliveries.eventId,
        events.map((event) => event.id),
      ),
    );
  return events.map((event) => {
    let parsed: NotificationEvent;
    try {
      parsed = JSON.parse(event.event) as NotificationEvent;
    } catch {
      parsed = { kind: "test" };
    }
    return {
      ...event,
      event: parsed,
      deliveries: deliveries
        .filter((delivery) => delivery.eventId === event.id)
        .map(({ eventId: _, ...delivery }) => delivery),
    };
  });
}

/** History is kept this long; the leader prunes older events with their deliveries. */
export const HISTORY_DAYS = 90;

let prunedAt = 0;

/** A notification watcher: hourly is plenty for a 90-day window. */
export async function pruneHistoryHourly(now: number): Promise<void> {
  if (now - prunedAt < 3_600_000) return;
  prunedAt = now;
  await pruneHistory(now);
}

export async function pruneHistory(now: number): Promise<void> {
  const cutoff = new Date(now - HISTORY_DAYS * 86_400_000).toISOString();
  const old = db.select({ id: alertEvents.id }).from(alertEvents).where(lt(alertEvents.at, cutoff));
  await db.delete(alertDeliveries).where(inArray(alertDeliveries.eventId, old));
  await db.delete(alertEvents).where(lt(alertEvents.at, cutoff));
}
