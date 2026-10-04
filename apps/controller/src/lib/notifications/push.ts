/**
 * Browser push for the same batches the email carries. VAPID keys are generated on first use and
 * kept in the database, private half encrypted: they identify this server to every push service,
 * so a new pair would orphan every subscription.
 */

import webpush, { WebPushError } from "web-push";
import { DEFAULT_LOCALE, type Locale, parseLocale } from "../locale";
import {
  adminPushTargets,
  forgetPushEndpoint,
  type PushTarget,
} from "../models/push-subscriptions";
import { getPublicBaseUrl } from "../public-url";
import { decryptSecret, encryptSecret } from "../secret";
import { getSetting as getStoredJson, setSetting as setStoredJson } from "../settings";
import { outsideStagingScope } from "../settings/staging-context";
import type { PendingNotice } from "./plan";

const VAPID_KEY = "web_push_vapid";
/** A batch older than this is stale news, as an email that never got through would be. */
const TTL_SECONDS = 24 * 60 * 60;
const SEND_TIMEOUT_MS = 15_000;
/** Lines in one notification before the rest become "and N more". */
const MAX_LINES = 3;
/** Push services cap the encrypted payload near 4 KB. */
const MAX_BODY = 1_000;

type VapidKeys = { publicKey: string; privateKey: string };
type Deliver = (
  target: PushTarget,
  payload: string,
  options: webpush.RequestOptions,
) => Promise<unknown>;

let deliver: Deliver = (target, payload, options) =>
  webpush.sendNotification(target, payload, options);

let keys: Promise<VapidKeys> | null = null;

/** Memoized, so two first sends cannot each generate and store a different pair. */
export function vapidKeys(): Promise<VapidKeys> {
  keys ??= loadOrCreateKeys().catch((error: unknown) => {
    keys = null;
    throw error;
  });
  return keys;
}

async function loadOrCreateKeys(): Promise<VapidKeys> {
  // Identity, not configuration: it must never land in a staged change set.
  const stored = await outsideStagingScope(() =>
    getStoredJson<{ publicKey?: unknown; privateKey?: unknown }>(VAPID_KEY),
  );
  if (typeof stored?.publicKey === "string" && typeof stored.privateKey === "string") {
    return { publicKey: stored.publicKey, privateKey: decryptSecret(stored.privateKey) };
  }
  const created = webpush.generateVAPIDKeys();
  await outsideStagingScope(() =>
    setStoredJson(VAPID_KEY, {
      publicKey: created.publicKey,
      privateKey: encryptSecret(created.privateKey),
    }),
  );
  return created;
}

export type PushPayload = { title: string; body: string; url: string; tag: string };

/** One notification per batch: its subject as the title, the first few sentences as the body. */
export async function pushPayload(
  notices: readonly PendingNotice[],
  locale: Locale = DEFAULT_LOCALE,
): Promise<PushPayload> {
  const { notificationText } = await import("./email");
  const { t, url, subject, texts } = await notificationText(notices, locale);
  const lines = texts.slice(0, MAX_LINES);
  if (texts.length > MAX_LINES) {
    lines.push(t("notifications.pushMore", { count: texts.length - MAX_LINES }));
  }
  const body = lines.join("\n");
  return {
    title: subject,
    body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 1)}…` : body,
    url,
    // A later batch replaces an unread one rather than stacking beside it.
    tag: "cpm-notifications",
  };
}

export type PushOutcome = { delivered: number; failed: number };

/** To every administrator's browsers. Never throws; dead subscriptions are dropped on the way. */
/** Pushes in flight at once: each waits up to SEND_TIMEOUT_MS on a push service. */
const SEND_CONCURRENCY = 8;

/**
 * To every administrator's browsers. Never throws; dead subscriptions are dropped on the way.
 * `payloads` caches the rendered payload per locale and batch across calls in one flush, since
 * every administrator with the same notices gets the same words.
 */
export async function sendPush(
  notices: readonly PendingNotice[],
  targets?: PushTarget[],
  payloads: Map<string, string> = new Map(),
): Promise<PushOutcome> {
  const outcome: PushOutcome = { delivered: 0, failed: 0 };
  try {
    const recipients = targets ?? (await adminPushTargets());
    if (recipients.length === 0 || notices.length === 0) return outcome;
    const [{ publicKey, privateKey }, subject] = await Promise.all([
      vapidKeys(),
      getPublicBaseUrl(),
    ]);
    const batch = notices.map((notice) => notice.id).join(",");
    const payloadFor = async (locale: Locale) => {
      const key = `${locale}:${batch}`;
      let payload = payloads.get(key);
      if (payload === undefined) {
        payload = JSON.stringify(await pushPayload(notices, locale));
        payloads.set(key, payload);
      }
      return payload;
    };

    const send = async (target: PushTarget) => {
      const payload = await payloadFor(parseLocale(target.locale ?? undefined) ?? DEFAULT_LOCALE);
      try {
        await deliver(target, payload, {
          vapidDetails: { subject, publicKey, privateKey },
          TTL: TTL_SECONDS,
          urgency: "high",
          timeout: SEND_TIMEOUT_MS,
        });
        outcome.delivered += 1;
      } catch (error) {
        outcome.failed += 1;
        // 404 and 410 are the push service saying the browser unsubscribed or expired it.
        if (
          error instanceof WebPushError &&
          (error.statusCode === 404 || error.statusCode === 410)
        ) {
          await forgetPushEndpoint(target.endpoint).catch((forgetError: unknown) => {
            console.error(
              "[notifications] could not forget a push endpoint:",
              describe(forgetError),
            );
          });
          return;
        }
        console.error("[notifications] push failed:", describe(error));
      }
    };

    const queue = [...recipients];
    await Promise.all(
      Array.from({ length: Math.min(SEND_CONCURRENCY, queue.length) }, async () => {
        for (let target = queue.shift(); target; target = queue.shift()) await send(target);
      }),
    );
  } catch (error) {
    console.error("[notifications] could not send push notifications:", describe(error));
  }
  return outcome;
}

/**
 * Never the endpoint or keys, which are bearer credentials: a push service's status and body, or
 * else only the error's kind, since a database error's message carries its bound parameters.
 */
function describe(error: unknown): string {
  if (error instanceof WebPushError) return `${error.statusCode} ${error.body || error.message}`;
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? `${error.name} ${code}` : error.name;
  }
  return typeof error;
}

/** Test seams: what a send hands the push service, and forgetting the memoized keys. */
export function setPushDeliveryForTests(fake: Deliver | null): void {
  deliver =
    fake ?? ((target, payload, options) => webpush.sendNotification(target, payload, options));
}

export function resetPushKeysForTests(): void {
  keys = null;
}
