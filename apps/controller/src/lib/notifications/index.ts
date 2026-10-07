/**
 * Tells the administrators what happened while nobody was looking: callers report events, rules
 * decide whether each is wanted and where it goes, and each channel batches a minute's worth. It
 * never throws into a caller: a notification is never worth failing the sign-in, the apply or the
 * agent report it came from.
 *
 * State lives in the alert tables (./state.ts), so a restart neither repeats an alert nor loses a
 * queued one, and every replica sees the same. Sending runs on the leader only.
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import db from "../db";
import {
  alertDeliveries,
  alertDigestRuns,
  alertDigests,
  alertEvents,
  alertKeys,
  alertRules,
  notificationChannels,
  settings,
} from "../db/schema";
import { isDemoMode } from "../demo/mode";
import { emailReady } from "../email/config";
import { sendEmail } from "../email/transport";
import { hasAdminPushTarget } from "../models/push-subscriptions";
import { builtins, forgetBuiltins } from "./builtins";
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationEvent,
} from "./events";
import { LEGACY_STATE_KEY, moveLegacyState } from "./legacy";
import type { AlertRule } from "./rules";
import {
  clearFailures,
  countFailure,
  openKeys,
  pruneKeys,
  queueNotice,
  type Recovery,
  raiseOpen,
  resolveOpen,
} from "./state";

export type { NotificationEvent } from "./events";
export type { Recovery } from "./state";

const TICK_MS = 15_000;

let chain: Promise<unknown> = Promise.resolve();

/** One change at a time in this process, so events keep their order; replicas meet in the tables. */
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.catch(() => {});
  return next;
}

let moved: Promise<unknown> | null = null;

/** The settings row an older release kept everything in, moved over before anything reads. */
function carriedOver(now = Date.now()): Promise<unknown> {
  moved ??= builtins(now)
    .then((ids) => moveLegacyState(ids, new Date(now).toISOString()))
    .catch((error: unknown) => {
      moved = null;
      throw error;
    });
  return moved;
}

function update(work: () => Promise<void>, now: number): Promise<void> {
  return serialized(async () => {
    await carriedOver(now);
    await work();
  });
}

/** Whether this category's switch is on. Imported lazily, as the registry reads env on load. */
async function categorySwitches() {
  const registry = await import("../settings/registry");
  return {
    accountDisabled: registry.notifyAccountDisabled,
    adminLocked: registry.notifyAdminLocked,
    adminAdded: registry.notifyAdminAdded,
    agentOffline: registry.notifyAgentOffline,
    upstreamErrors: registry.notifyUpstreamErrors,
    caddyApply: registry.notifyCaddyApply,
    agentProblems: registry.notifyAgentProblems,
    geoip: registry.notifyGeoipFailed,
    crsPlugin: registry.notifyCrsPluginDisabled,
    updateAvailable: registry.notifyUpdateAvailable,
    backups: registry.notifyBackupFailed,
    auditSinks: registry.notifyAuditSinkFailed,
    channels: registry.notifyChannelFailing,
  } satisfies Record<NotificationCategory, typeof registry.notifyAccountDisabled>;
}

/** Each category's Settings key, which also names its built-in rule's label. */
export async function categorySettingKeys(): Promise<Record<NotificationCategory, string>> {
  const switches = await categorySwitches();
  return Object.fromEntries(
    NOTIFICATION_CATEGORIES.map((category) => [category, switches[category].key]),
  ) as Record<NotificationCategory, string>;
}

export async function notificationCategoryEnabled(
  category: NotificationCategory,
): Promise<boolean> {
  const [switches, { getSetting }] = await Promise.all([
    categorySwitches(),
    import("../settings/resolve"),
  ]);
  return getSetting(switches[category]);
}

/** Each category with its Settings switch, for a page that labels it the way Settings does. */
export async function notificationCategoryStates(): Promise<
  { category: NotificationCategory; settingKey: string; enabled: boolean }[]
> {
  const [switches, { getSetting }] = await Promise.all([
    categorySwitches(),
    import("../settings/resolve"),
  ]);
  return Promise.all(
    NOTIFICATION_CATEGORIES.map(async (category) => ({
      category,
      settingKey: switches[category].key,
      enabled: await getSetting(switches[category]),
    })),
  );
}

/**
 * Whether anything would carry this kind of event: its category's switch on with email or push
 * ready, or a rule naming it with an added channel switched on. Sources that cost work to watch
 * (the access log's upstream errors, the release check) ask this before doing it.
 */
export async function eventKindDeliverable(
  kind: NotificationEvent["kind"],
  category: NotificationCategory,
  now = Date.now(),
): Promise<boolean> {
  if ((await notificationCategoryEnabled(category)) && (await notificationChannelReady())) {
    return true;
  }
  const [{ loadRules, ruleSilenced, ruleSwitchedOn }, channels] = await Promise.all([
    import("./rules"),
    db
      .select({ id: notificationChannels.id, enabled: notificationChannels.enabled })
      .from(notificationChannels)
      .where(isNull(notificationChannels.builtin)),
  ]);
  const usable = new Set(channels.filter((row) => row.enabled).map((row) => row.id));
  for (const rule of await loadRules()) {
    if (rule.source !== "event" || ruleSilenced(rule, now)) continue;
    const kinds = Array.isArray(rule.config.kinds) ? rule.config.kinds : [];
    const categories = Array.isArray(rule.config.categories) ? rule.config.categories : [];
    if (!kinds.includes(kind) && !categories.includes(category)) continue;
    if (!rule.channelIds.some((id) => usable.has(id))) continue;
    if (await ruleSwitchedOn(rule)) return true;
  }
  return false;
}

/** Email set up, or an administrator's browser subscribed: either can carry a notification. */
export async function notificationChannelReady(): Promise<boolean> {
  return (await emailReady()) || (await hasAdminPushTarget());
}

function quietly(what: string, work: () => Promise<unknown>): Promise<void> {
  return work().then(
    () => {},
    (error: unknown) => {
      console.error(`[notifications] could not ${what}:`, error);
    },
  );
}

/** A one-off. The key stays quiet for `quietMs` ("forever": once and for all) after it is queued. */
export function notify(
  key: string,
  event: NotificationEvent,
  quietMs: number | "forever" = 0,
  now = Date.now(),
): Promise<void> {
  if (isDemoMode()) return Promise.resolve();
  return quietly("queue a notification", () =>
    update(() => queueNotice(key, event, quietMs, now), now),
  );
}

/** A problem that lasts until `resolveProblem`; told once however often it is raised. */
export function raiseProblem(
  key: string,
  event: NotificationEvent,
  now = Date.now(),
): Promise<void> {
  if (isDemoMode()) return Promise.resolve();
  return quietly("queue a notification", () => update(() => raiseOpen(key, event, now), now));
}

/** A problem a rule found by watching for itself, routed to that rule's channels only. */
export function raiseRuleProblem(
  rule: AlertRule,
  key: string,
  event: NotificationEvent,
  now = Date.now(),
): Promise<void> {
  if (isDemoMode()) return Promise.resolve();
  return quietly("queue a notification", () => update(() => raiseOpen(key, event, now, rule), now));
}

/** "Send test" on a rule: queued through its channels like anything it raises. */
export async function queueRuleTest(
  rule: AlertRule,
  name: string,
  now = Date.now(),
): Promise<number> {
  return serialized(async () => {
    await carriedOver(now);
    const { recordEvent } = await import("./state");
    const channels = await db
      .select({ id: notificationChannels.id, enabled: notificationChannels.enabled })
      .from(notificationChannels);
    const usable = rule.channelIds.filter((id) =>
      channels.some((channel) => channel.id === id && channel.enabled),
    );
    if (usable.length === 0) return 0;
    const { eventIds } = await recordEvent(
      `rule-test:${rule.id}:${now}`,
      { kind: "ruleTest", rule: name },
      "notice",
      [{ rule, channels: usable }],
      now,
    );
    return eventIds[0] ?? 0;
  });
}

/** Queues `recovery` where the problem was told; nothing at all if it was not. */
export function resolveProblem(key: string, recovery: Recovery, now = Date.now()): Promise<void> {
  return quietly("resolve a notification", () =>
    update(() => resolveOpen(key, recovery, now), now),
  );
}

/** For a job only worth telling about once it keeps failing: raised on the `threshold`th in a row. */
export function recordJobFailure(
  key: string,
  threshold: number,
  event: (failures: number) => NotificationEvent,
  now = Date.now(),
): Promise<void> {
  return quietly("count a failure", () =>
    update(async () => {
      // Counted with the switch off too, so turning it on mid-streak tells at the right time.
      const failures = await countFailure(key, now);
      if (failures >= threshold && !isDemoMode()) await raiseOpen(key, event(failures), now);
    }, now),
  );
}

export function recordJobSuccess(key: string, recovery: Recovery, now = Date.now()): Promise<void> {
  return quietly("clear a failure", () => update(() => clearFailures(key, recovery, now), now));
}

/** Keys of the problems currently open, for a watcher that must close ones it no longer sees. */
export async function openProblemKeys(prefix: string): Promise<string[]> {
  try {
    return await serialized(async () => {
      await carriedOver();
      return openKeys(prefix);
    });
  } catch (error) {
    console.error("[notifications] could not read the open problems:", error);
    return [];
  }
}

let flushing: Promise<void> | null = null;

/** Sends what is due. Called by the tick; tests call it with a later `now`. */
export function flushNotifications(now = Date.now()): Promise<void> {
  flushing ??= quietly("send notifications", () => flush(now)).finally(() => {
    flushing = null;
  });
  return flushing;
}

async function flush(now: number): Promise<void> {
  await serialized(async () => {
    // Every pass: an older backup restored since may have brought the row back.
    const ids = await builtins(now);
    moved = moveLegacyState(ids, new Date(now).toISOString());
    await moved;
  });
  const { flushBuiltin } = await import("./flush");
  await flushBuiltin(now);
  const { flushChannels } = await import("../alerts/deliver");
  await flushChannels(now);
  await pruneKeys(now);
}

/**
 * Straight away, by email to everyone notifications are emailed to; throws so Settings can say
 * why it failed.
 */
export async function sendTestNotification(now = Date.now()): Promise<string[]> {
  const { notificationAudiences } = await import("./audience");
  const recipients = (await notificationAudiences({ email: true })).flatMap((audience) =>
    audience.kind === "email" ? [audience.address] : [],
  );
  if (recipients.length === 0) return [];
  const { notificationEmail } = await import("./email");
  await sendEmail(
    await notificationEmail({
      to: recipients,
      notices: [
        { id: randomUUID(), key: "test", at: new Date(now).toISOString(), event: { kind: "test" } },
      ],
    }),
  );
  return recipients;
}

export type NotificationStatus = {
  lastSentAt: string | null;
  /** English, as the SMTP server or the job said it; null after a good send. */
  lastError: string | null;
  lastErrorAt: string | null;
  /** Set when nothing was sent because there was no one to send to. */
  lastErrorCode: "noRecipients" | null;
  pending: number;
};

/** The built-in email and push channels, which Settings reports on together. */
export async function getNotificationStatus(): Promise<NotificationStatus> {
  try {
    await carriedOver();
    const { email, push } = await builtins();
    const [row] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, email));
    const pending = await db
      .selectDistinct({ eventId: alertDeliveries.eventId })
      .from(alertDeliveries)
      .where(
        and(
          inArray(alertDeliveries.channelId, [email, push]),
          eq(alertDeliveries.status, "pending"),
        ),
      );
    return {
      lastSentAt: row?.lastSentAt ?? null,
      lastError: row?.lastError ?? null,
      lastErrorAt: row?.lastErrorAt ?? null,
      lastErrorCode: row?.lastErrorCode === "noRecipients" ? "noRecipients" : null,
      pending: pending.length,
    };
  } catch {
    return {
      lastSentAt: null,
      lastError: null,
      lastErrorAt: null,
      lastErrorCode: null,
      pending: 0,
    };
  }
}

/** Test seam: wait for queued writes, then forget every alert, rule and channel. */
export async function resetNotificationsForTests(): Promise<void> {
  await serialized(async () => {
    await db.delete(alertDigestRuns);
    await db.delete(alertDigests);
    await db.delete(alertDeliveries);
    await db.delete(alertEvents);
    await db.delete(alertKeys);
    await db.delete(alertRules);
    await db.delete(notificationChannels);
    await db.delete(settings).where(eq(settings.key, LEGACY_STATE_KEY));
    forgetBuiltins();
    moved = null;
  });
}

type Watcher = (now: number) => Promise<void>;
const watchers: Watcher[] = [];

/** Something a tick checks, e.g. how long an agent has been gone. */
export function addNotificationWatcher(watcher: Watcher): void {
  // Once, though a replica that takes the lead again starts this module over.
  if (!watchers.includes(watcher)) watchers.push(watcher);
}

/** One pass: every watcher, then whatever is due. */
export async function notificationTick(now = Date.now()): Promise<void> {
  for (const watcher of watchers) await quietly("run a notification check", () => watcher(now));
  await flushNotifications(now);
}

let timer: NodeJS.Timeout | null = null;

/** Idempotent. */
export function startNotifications(): void {
  if (timer) return;
  // Imported here: each reaches back into this module, and the agent registry.
  void Promise.all([
    import("./agents"),
    import("./jobs"),
    import("./upstream-errors"),
    import("../alerts/watch"),
    import("../alerts/history"),
  ])
    .then(
      ([
        { watchAgents },
        { watchReleases },
        { watchUpstreamErrors },
        { watchRuleSources },
        { pruneHistoryHourly },
      ]) => {
        addNotificationWatcher(watchAgents);
        addNotificationWatcher(watchReleases);
        addNotificationWatcher(watchUpstreamErrors);
        addNotificationWatcher(watchRuleSources);
        addNotificationWatcher(pruneHistoryHourly);
      },
    )
    .catch((error: unknown) => {
      console.error("[notifications] could not start the agent watch:", error);
    });
  timer = setInterval(() => {
    void notificationTick();
  }, TICK_MS);
  timer.unref();
}

/** On losing the lead (lib/cluster); a pass already running finishes. */
export function stopNotifications(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
