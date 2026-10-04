/**
 * Tells the administrators what happened while nobody was looking, by email and browser push.
 * Callers report events; this decides whether each is wanted (its Settings switch, a channel being
 * set up), deduplicates it, and batches a minute's worth into one email and one push. It never throws into a caller: a notification is
 * never worth failing the sign-in, the apply or the agent report it came from.
 *
 * State is one JSON row in `settings`, like the certificate alerts', so a restart neither repeats
 * an alert nor loses a queued one. In memory, per process, like the agent registry it watches.
 */

import { randomUUID } from "node:crypto";
import { isDemoMode } from "../demo-mode";
import { emailReady } from "../email/config";
import { sendEmail } from "../email/transport";
import { hasAdminPushTarget } from "../models/push-subscriptions";
import { getSetting as getStoredJson, setSetting as setStoredJson } from "../settings";
import { outsideStagingScope } from "../settings/staging-context";
import {
  categoryOf,
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationEvent,
} from "./events";
import {
  EMPTY_STATE,
  type NotificationState,
  normalizeState,
  planBatch,
  planDropped,
  planFailure,
  planNotice,
  planDelivered,
  type PendingNotice,
  planRaise,
  planResolve,
  planSendFailed,
  planSent,
  planSuccess,
  type Recovery,
} from "./plan";

export type { NotificationEvent } from "./events";

const STATE_KEY = "admin_notifications";
const TICK_MS = 15_000;

let chain: Promise<unknown> = Promise.resolve();

/** One writer at a time: every change is a read, a plan and a write of the same row. */
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.catch(() => {});
  return next;
}

async function readState(): Promise<NotificationState> {
  // A cache of what was sent, not configuration: it must never land in a staged change set.
  return normalizeState(await outsideStagingScope(() => getStoredJson<unknown>(STATE_KEY)));
}

function writeState(state: NotificationState): Promise<void> {
  return outsideStagingScope(() => setStoredJson(STATE_KEY, state));
}

async function update(
  plan: (state: NotificationState) => NotificationState,
): Promise<NotificationState> {
  return serialized(async () => {
    const state = await readState();
    const next = plan(state);
    if (next !== state) await writeState(next);
    return next;
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
  } satisfies Record<NotificationCategory, typeof registry.notifyAccountDisabled>;
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
 * Wanted at all: with neither email nor a subscribed browser nothing is queued, so nothing floods
 * out once one is set up.
 */
async function wanted(event: NotificationEvent): Promise<boolean> {
  if (isDemoMode()) return false;
  const category = categoryOf(event);
  if (category && !(await notificationCategoryEnabled(category))) return false;
  return notificationChannelReady();
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
  return quietly("queue a notification", async () => {
    if (!(await wanted(event))) return;
    await update((state) => planNotice(state, { key, event, quietMs }, now, randomUUID()));
  });
}

/** A problem that lasts until `resolveProblem`; told once however often it is raised. */
export function raiseProblem(
  key: string,
  event: NotificationEvent,
  now = Date.now(),
): Promise<void> {
  return quietly("queue a notification", async () => {
    if (!(await wanted(event))) return;
    await update((state) => planRaise(state, key, event, now, randomUUID()));
  });
}

/** Queues `recovery` if the problem was told about; nothing at all if it was not. */
export function resolveProblem(key: string, recovery: Recovery, now = Date.now()): Promise<void> {
  return quietly("resolve a notification", () =>
    update((state) => planResolve(state, key, recovery, now, randomUUID())),
  );
}

/** For a job only worth telling about once it keeps failing: raised on the `threshold`th in a row. */
export function recordJobFailure(
  key: string,
  threshold: number,
  event: (failures: number) => NotificationEvent,
  now = Date.now(),
): Promise<void> {
  return quietly("count a failure", async () => {
    // Counted with the switch off too, so turning it on mid-streak tells at the right time.
    const probe = event(threshold);
    const tell = await wanted(probe);
    await update((state) =>
      tell
        ? planFailure(state, key, threshold, event, now, randomUUID())
        : { ...state, streaks: { ...state.streaks, [key]: (state.streaks[key] ?? 0) + 1 } },
    );
  });
}

export function recordJobSuccess(key: string, recovery: Recovery, now = Date.now()): Promise<void> {
  return quietly("clear a failure", () =>
    update((state) => planSuccess(state, key, recovery, now, randomUUID())),
  );
}

/** Keys of the problems currently open, for a watcher that must close ones it no longer sees. */
export async function openProblemKeys(prefix: string): Promise<string[]> {
  try {
    const state = await serialized(readState);
    return Object.keys(state.open).filter((key) => key.startsWith(prefix));
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
  let batch: NotificationState["pending"] = [];
  await update((state) => {
    const picked = planBatch(state, now);
    if (!picked) return state;
    batch = picked.batch;
    return picked.state;
  });
  if (batch.length === 0) return;

  const ready = await emailReady();
  const { notificationAudiences, audienceWants } = await import("./audience");
  const audiences = await notificationAudiences({ email: ready });
  const keep: typeof batch = [];
  const drop: string[] = [];
  for (const notice of batch) {
    const category = categoryOf(notice.event);
    const on =
      (ready || audiences.length > 0) &&
      (!category || (await notificationCategoryEnabled(category)));
    if (on) keep.push(notice);
    else drop.push(notice.id);
  }
  if (keep.length === 0) {
    await update((state) => planDropped(state, drop, now, null));
    return;
  }
  if (audiences.length === 0) {
    await update((state) =>
      planDropped(
        state,
        batch.map((notice) => notice.id),
        now,
        "noRecipients",
      ),
    );
    return;
  }

  const owed = (key: string, wants: (category: ReturnType<typeof categoryOf>) => boolean) =>
    keep.filter((notice) => !notice.delivered?.includes(key) && wants(categoryOf(notice.event)));
  const reached = new Map<string, string[]>();
  const mark = (notices: readonly PendingNotice[], keys: readonly string[]) => {
    for (const notice of notices)
      reached.set(notice.id, [...(reached.get(notice.id) ?? []), ...keys]);
  };

  // Once each: a failed email is retried, a push is not worth repeating.
  // In parallel: each waits on push services; one shared cache renders each payload once.
  const { sendPush } = await import("./push");
  const payloads = new Map<string, string>();
  await Promise.all(
    audiences.map(async (audience) => {
      if (audience.kind !== "push") return;
      const notices = owed(audience.key, (category) => audienceWants(audience, category));
      if (notices.length === 0) return;
      await sendPush(notices, audience.targets, payloads);
      mark(notices, [audience.key]);
    }),
  );

  // One email per distinct set of notices, so muting a category costs no one else their copy.
  const emails = new Map<string, { notices: PendingNotice[]; to: string[]; keys: string[] }>();
  for (const audience of audiences) {
    if (audience.kind !== "email") continue;
    const notices = owed(audience.key, (category) => audienceWants(audience, category));
    if (notices.length === 0) continue;
    const signature = notices.map((notice) => notice.id).join(",");
    const email = emails.get(signature) ?? { notices, to: [], keys: [] };
    email.to.push(audience.address);
    email.keys.push(audience.key);
    emails.set(signature, email);
  }
  let failure: string | null = null;
  if (emails.size > 0) {
    const { notificationEmail } = await import("./email");
    for (const email of emails.values()) {
      try {
        await sendEmail(await notificationEmail({ to: email.to, notices: email.notices }));
        mark(email.notices, email.keys);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
    }
  }

  if (failure !== null) {
    const message = failure;
    console.error("[notifications] send failed; retrying later:", message);
    await update((state) =>
      planDropped(planSendFailed(planDelivered(state, reached), message, now), drop, now, null),
    );
    return;
  }
  await update((state) =>
    planDropped(
      planSent(
        state,
        keep.map((notice) => notice.id),
        now,
      ),
      drop,
      now,
      null,
    ),
  );
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

export type NotificationStatus = Pick<
  NotificationState,
  "lastSentAt" | "lastError" | "lastErrorAt" | "lastErrorCode"
> & { pending: number };

export async function getNotificationStatus(): Promise<NotificationStatus> {
  const state = await readState().catch(() => EMPTY_STATE);
  return {
    lastSentAt: state.lastSentAt,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    lastErrorCode: state.lastErrorCode,
    pending: state.pending.length,
  };
}

/** Test seam: wait for queued writes, then forget the stored state. */
export async function resetNotificationsForTests(): Promise<void> {
  await serialized(() => writeState(EMPTY_STATE));
}

type Watcher = (now: number) => Promise<void>;
const watchers: Watcher[] = [];

/** Something a tick checks, e.g. how long an agent has been gone. */
export function addNotificationWatcher(watcher: Watcher): void {
  watchers.push(watcher);
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
  void Promise.all([import("./agents"), import("./jobs"), import("./upstream-errors")])
    .then(([{ watchAgents }, { watchReleases }, { watchUpstreamErrors }]) => {
      addNotificationWatcher(watchAgents);
      addNotificationWatcher(watchReleases);
      addNotificationWatcher(watchUpstreamErrors);
    })
    .catch((error: unknown) => {
      console.error("[notifications] could not start the agent watch:", error);
    });
  timer = setInterval(() => {
    void notificationTick();
  }, TICK_MS);
  timer.unref();
}
