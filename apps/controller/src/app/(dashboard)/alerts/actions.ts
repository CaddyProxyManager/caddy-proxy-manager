"use server";

import { requireCan } from "@/src/lib/users/permissions";
import { revalidatePath } from "next/cache";
import { getLocale, getTimeZone } from "next-intl/server";
import {
  createChannel,
  deleteChannel,
  listChannels,
  type SavedChannel,
  testChannel,
  updateChannel,
} from "@/src/lib/alerts/channel-store";
import type { ChannelInput, ChannelView } from "@/src/lib/alerts/channels";
import { previewDigest, sendDigestNow } from "@/src/lib/alerts/digest-runner";
import {
  createDigest,
  type DigestInput,
  type DigestRun,
  type DigestView,
  deleteDigest,
  listDigests,
  updateDigest,
} from "@/src/lib/alerts/digests";
import { HISTORY_PAGE, type HistoryFilter, listHistory } from "@/src/lib/alerts/history";
import {
  createRule,
  deleteRule,
  listRules,
  MAX_METRIC_MINUTES,
  MAX_QUIET_MINUTES,
  type RuleInput,
  type RuleView,
  SIGNAL_KINDS,
  silenceRule,
  testRule,
  updateRule,
} from "@/src/lib/alerts/rule-store";
import { withTranslatedErrors } from "@/src/lib/errors/translated-action";
import { DEFAULT_LOCALE, parseLocale } from "@/src/lib/locale";
import { listProxyHosts, listProxyHostTags } from "@/src/lib/models/proxy-hosts";
import { notificationCategoryStates } from "@/src/lib/notifications";
import { notificationText } from "@/src/lib/notifications/email";
import { categoryOf, EVENT_KINDS, type NotificationEvent } from "@/src/lib/notifications/events";

export type EventCategoryOption = { category: string; settingKey: string; kinds: string[] };

export type AlertsOverview = {
  rules: RuleView[];
  channels: ChannelView[];
  digests: DigestView[];
  hosts: { id: number; name: string }[];
  tags: string[];
  categories: EventCategoryOption[];
  signals: string[];
  maxQuietMinutes: number;
  maxMetricMinutes: number;
};

/** An event as History shows it: its sentence rendered here, since `email.*` stays on the server. */
export type HistoryRow = {
  id: number;
  at: string;
  resolvedAt: string | null;
  title: string;
  text: string;
  ruleId: number | null;
  ruleName: string | null;
  ruleSettingKey: string | null;
  severity: string;
  type: string;
  deliveries: {
    id: number;
    channelName: string;
    channelKind: string;
    status: string;
    attempts: number;
    lastError: string | null;
    sentAt: string | null;
  }[];
};

const PAGE = "/alerts";

async function adminId(): Promise<number> {
  return Number((await requireCan("alerts:write")).user.id);
}

export async function loadAlertsOverviewAction(): Promise<AlertsOverview> {
  await requireCan("alerts:read");
  const [rules, channels, digests, hosts, tags, states] = await Promise.all([
    listRules(),
    listChannels(),
    listDigests(),
    listProxyHosts(),
    listProxyHostTags(),
    notificationCategoryStates(),
  ]);
  const categories = states.map(({ category, settingKey }) => ({
    category,
    settingKey,
    kinds: EVENT_KINDS.filter(
      (kind) => categoryOf({ kind } as NotificationEvent) === category,
    ) as string[],
  }));
  return {
    rules,
    channels,
    digests,
    hosts: hosts.map((host) => ({ id: host.id, name: host.name || host.domains[0] || "" })),
    tags,
    categories,
    signals: SIGNAL_KINDS,
    maxQuietMinutes: MAX_QUIET_MINUTES,
    maxMetricMinutes: MAX_METRIC_MINUTES,
  };
}

// ── Rules ───────────────────────────────────────────────────────────────────

export async function saveRuleAction(id: number | null, input: RuleInput): Promise<RuleView> {
  const userId = await adminId();
  return withTranslatedErrors(async () => {
    const saved =
      id === null ? await createRule(input, userId) : await updateRule(id, input, userId);
    revalidatePath(PAGE);
    return saved;
  });
}

export async function deleteRuleAction(id: number): Promise<void> {
  const userId = await adminId();
  await withTranslatedErrors(async () => {
    await deleteRule(id, userId);
    revalidatePath(PAGE);
  });
}

/** Until an ISO time, or lifted with null. */
export async function silenceRuleAction(id: number, until: string | null): Promise<RuleView> {
  const userId = await adminId();
  return withTranslatedErrors(() => silenceRule(id, until, userId));
}

/**
 * False when the rule has no enabled channel to queue the test on. `displayName` is the rule as
 * the reader sees it: a built-in one is named by its Settings label, not its stored name.
 */
export async function testRuleAction(
  id: number,
  displayName: string,
): Promise<{ queued: boolean }> {
  await requireCan("alerts:write");
  const eventId = await withTranslatedErrors(() => testRule(id, displayName.slice(0, 200)));
  return { queued: eventId > 0 };
}

// ── Channels ────────────────────────────────────────────────────────────────

export async function saveChannelAction(
  id: number | null,
  input: ChannelInput,
): Promise<SavedChannel> {
  const userId = await adminId();
  return withTranslatedErrors(async () => {
    const saved =
      id === null ? await createChannel(input, userId) : await updateChannel(id, input, userId);
    revalidatePath(PAGE);
    return saved;
  });
}

export async function deleteChannelAction(id: number): Promise<void> {
  const userId = await adminId();
  await withTranslatedErrors(async () => {
    await deleteChannel(id, userId);
    revalidatePath(PAGE);
  });
}

export type ChannelTestOutcome =
  | { ok: true; outcome: "delivered" | "accepted"; recipients: string[] }
  | { ok: false; message: string };

/** A saved channel as stored, or with `input` the form as typed: its blank secrets are the stored ones. */
export async function testChannelAction(
  id: number | null,
  input: ChannelInput | null,
): Promise<ChannelTestOutcome> {
  await requireCan("alerts:write");
  try {
    const result = await withTranslatedErrors(() => testChannel(id, input));
    return { ok: true, outcome: result.outcome, recipients: result.recipients ?? [] };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

// ── History ─────────────────────────────────────────────────────────────────

export async function loadHistoryAction(
  filter: HistoryFilter,
): Promise<{ rows: HistoryRow[]; hasMore: boolean }> {
  await requireCan("alerts:read");
  const limit = HISTORY_PAGE;
  const [events, locale] = await Promise.all([listHistory({ ...filter, limit }), getLocale()]);
  if (events.length === 0) return { rows: [], hasMore: false };
  const { titles, texts } = await notificationText(
    events.map((event) => ({
      id: String(event.id),
      key: event.key,
      at: event.at,
      event: event.event,
    })),
    parseLocale(locale) ?? DEFAULT_LOCALE,
  );
  const states = await notificationCategoryStates();
  const settingKeys = new Map(states.map((state) => [state.category, state.settingKey]));
  return {
    rows: events.map((event, index) => ({
      id: event.id,
      at: event.at,
      resolvedAt: event.resolvedAt,
      title: titles[index],
      text: texts[index],
      ruleId: event.ruleId,
      ruleName: event.ruleName,
      ruleSettingKey: event.ruleBuiltin
        ? (settingKeys.get(event.ruleBuiltin as never) ?? null)
        : null,
      severity: event.severity,
      type: event.type,
      deliveries: event.deliveries.map((delivery) => ({
        id: delivery.id,
        channelName: delivery.channelName,
        channelKind: delivery.channelKind,
        status: delivery.status,
        attempts: delivery.attempts,
        lastError: delivery.lastError,
        sentAt: delivery.sentAt,
      })),
    })),
    hasMore: events.length === limit,
  };
}

// ── Digests ─────────────────────────────────────────────────────────────────

export async function saveDigestAction(id: number | null, input: DigestInput): Promise<void> {
  const userId = await adminId();
  await withTranslatedErrors(async () => {
    if (id === null) await createDigest(input, userId);
    else await updateDigest(id, input, userId);
    revalidatePath(PAGE);
  });
}

export async function deleteDigestAction(id: number): Promise<void> {
  const userId = await adminId();
  await withTranslatedErrors(async () => {
    await deleteDigest(id, userId);
    revalidatePath(PAGE);
  });
}

/** What it would say now, in the reader's language and time zone. */
export async function previewDigestAction(id: number): Promise<{ subject: string; text: string }> {
  await requireCan("alerts:read");
  const [locale, timeZone] = await Promise.all([getLocale(), getTimeZone()]);
  return withTranslatedErrors(() =>
    previewDigest(id, { locale: parseLocale(locale) ?? DEFAULT_LOCALE, timeZone }),
  );
}

export async function sendDigestNowAction(id: number): Promise<DigestRun | null> {
  await requireCan("alerts:write");
  return withTranslatedErrors(() => sendDigestNow(id));
}
