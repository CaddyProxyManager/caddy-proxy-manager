/**
 * One email for a batch of notices. Every sentence is a catalog entry per kind; times are in UTC
 * and say so, since a batch has no reader whose zone could be asked.
 */

import { createFormatter } from "next-intl";
import { DEFAULT_LOCALE, type Locale } from "../locale";
import { emailContext, renderBody } from "../email/messages";
import type { EmailMessage } from "../email/transport";
import { attentionMessageValues } from "../attention/types";
import { storedErrorMessage } from "../errors/action-error";
import { geoipUpdateErrorMessage } from "../geoip/messages";
import type { NotificationEvent } from "./events";
import type { PendingNotice } from "./plan";

/** Keys are composed from the kind, so the narrowing is given up here, as in audit/summary.ts. */
type DynamicTranslate = (key: string, values?: Record<string, string | number>) => string;

const TIME_FORMAT = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
} as const;

/** Names and errors can come from an agent: one line each, and bounded, in a subject too. */
function clean(values: Record<string, string | number>): Record<string, string | number> {
  const cleaned: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(values)) {
    cleaned[name] =
      typeof value === "string"
        ? value
            .replace(/\p{Cc}+/gu, " ")
            .trim()
            .slice(0, 300)
        : value;
  }
  return cleaned;
}

type RootTranslate = Parameters<typeof storedErrorMessage>[0];

/** The ICU values for a kind's `item` and `title`. Errors with a stored code in `tRoot`'s language. */
export function values(
  event: NotificationEvent,
  tRoot: RootTranslate,
): Record<string, string | number> {
  switch (event.kind) {
    case "accountDisabled":
    case "lastAdminKept":
    case "adminLocked":
      return { email: event.email, failures: event.failures };
    case "adminAdded":
      return { email: event.email, promoted: event.promoted ? "yes" : "no" };
    case "agentOffline":
      return { agent: event.agent, minutes: event.minutes };
    case "agentOnline":
      return { agent: event.agent };
    case "upstreamErrors":
      return { host: event.host, count: event.count, minutes: event.minutes };
    case "upstreamRecovered":
      return { host: event.host };
    case "caddyApplyFailed":
      return {
        scope: event.agent === null ? "all" : "agent",
        agent: event.agent ?? "",
        error: storedErrorMessage(tRoot, event.error, event.errorCode),
      };
    case "caddyApplyRecovered":
      return { scope: event.agent === null ? "all" : "agent", agent: event.agent ?? "" };
    case "agentProblem":
    case "agentProblemResolved":
      return { agent: event.agent, problem: event.problem };
    case "geoipFailed":
      return {
        failures: event.failures,
        error:
          geoipUpdateErrorMessage(tRoot, {
            downloaded: [],
            error: event.error,
            checkError: event.checkError,
            failures: event.editionFailures,
          }) ?? event.error,
      };
    case "crsPluginDisabled":
      return { plugin: event.plugin, version: event.version };
    case "updateAvailable":
      return { version: event.version, current: event.current };
    case "backupFailed":
      return {
        schedule: event.schedule,
        error: storedErrorMessage(tRoot, event.error, event.errorCode),
      };
    case "backupRecovered":
      return { schedule: event.schedule };
    case "auditSinkFailed":
      return { sink: event.sink, error: storedErrorMessage(tRoot, event.error, event.errorCode) };
    case "auditSinkRecovered":
      return { sink: event.sink };
    case "channelFailing":
      return { channel: event.channel, failures: event.failures, error: event.error };
    case "channelRecovered":
    case "channelTest":
      return { channel: event.channel };
    case "ruleTest":
      return { rule: event.rule };
    case "attention":
    case "attentionResolved": {
      const translate = tRoot as unknown as (
        key: string,
        values?: Record<string, string | number | Date>,
      ) => string;
      const parts = attentionMessageValues({ values: event.values });
      return {
        title: translate(`attention.items.${event.code}.title`, parts),
        detail: translate(`attention.items.${event.code}.detail`, parts),
      };
    }
    case "metricThreshold":
      return {
        host: event.host,
        metric: event.metric,
        comparison: event.comparison,
        value: event.value,
        threshold: event.threshold,
        minutes: event.minutes,
      };
    case "metricRecovered":
      return { host: event.host, metric: event.metric };
    case "geoipRecovered":
    case "test":
      return {};
  }
}

/** The subject and each notice's sentence, shared by every channel that sends a batch. */
export async function notificationText(notices: readonly PendingNotice[], locale: Locale) {
  const context = await emailContext(locale);
  const { t, appName } = context;
  const translate = t as unknown as DynamicTranslate;
  const tRoot = context.tRoot as unknown as RootTranslate;

  const texts = notices.map(({ event }) => {
    const text = translate(`notifications.kinds.${event.kind}.item`, clean(values(event, tRoot)));
    return event.kind === "agentProblem" && event.detail
      ? t("notifications.withDetail", { text, detail: String(clean({ d: event.detail }).d) })
      : text;
  });
  const titles = notices.map(({ event }) =>
    translate(`notifications.kinds.${event.kind}.title`, clean(values(event, tRoot))),
  );
  const subject =
    notices.length === 1
      ? t("notifications.subjectOne", { appName, title: titles[0] })
      : t("notifications.subjectMany", { appName, count: notices.length });
  return { ...context, subject, texts, titles };
}

export async function notificationEmail(
  input: { to: string[]; notices: readonly PendingNotice[] },
  locale: Locale = DEFAULT_LOCALE,
): Promise<EmailMessage> {
  const { t, appName, url, footer, subject, texts } = await notificationText(input.notices, locale);
  const format = createFormatter({ locale, timeZone: "UTC" });
  const items = input.notices.map(({ at }, index) =>
    t("notifications.item", {
      time: format.dateTime(new Date(at), TIME_FORMAT),
      text: texts[index],
    }),
  );

  return {
    to: input.to,
    subject,
    ...renderBody({
      paragraphs: [t("notifications.intro", { appName, count: input.notices.length })],
      items,
      action: { label: t("notifications.action"), url },
      notes: [t("notifications.manage")],
      footer,
    }),
  };
}
