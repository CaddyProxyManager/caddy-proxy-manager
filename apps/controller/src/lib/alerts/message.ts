/**
 * A batch of alerts as every chat and webhook channel renders it: each item's title and sentence
 * from the email catalog, its severity, and whether it says something is over. The payload
 * builders take this and nothing else, so they stay pure and testable.
 */

import { createFormatter } from "next-intl";
import type { AlertSeverity } from "../notifications/builtins";
import { RECOVERY_KINDS, type NotificationEvent } from "../notifications/events";
import { DEFAULT_LOCALE, type Locale } from "../locale";
import { settingLabel } from "../settings/messages";

export type AlertItem = {
  /** The alert_events row. */
  id: number;
  kind: NotificationEvent["kind"];
  title: string;
  text: string;
  severity: AlertSeverity;
  resolved: boolean;
  /** ISO. */
  at: string;
  /** In UTC and saying so, as the emails are: a channel has no reader to ask for a zone. */
  time: string;
  rule: string | null;
  event: NotificationEvent;
  /** False for a digest section: no severity, time or rule beside it. */
  facts?: boolean;
};

export type AlertBatch = {
  /** What a webhook says it carries. */
  type?: "alerts" | "digest";
  subject: string;
  appName: string;
  url: string;
  items: AlertItem[];
  labels: {
    severity: string;
    rule: string;
    time: string;
    open: string;
    severities: Record<AlertSeverity | "resolved", string>;
    /** "…and N more", for a payload cut short. */
    more: (count: number) => string;
  };
};

export type AlertSource = {
  id: number;
  at: string;
  event: NotificationEvent;
  severity: string;
  /** A built-in rule is named by its category's Settings label, in the reader's language. */
  rule: { name: string; settingKey: string | null } | null;
};

const TIME_FORMAT = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
} as const;

function severityOf(value: string): AlertSeverity {
  return value === "critical" || value === "info" ? value : "warning";
}

export async function alertBatch(
  sources: readonly AlertSource[],
  locale: Locale = DEFAULT_LOCALE,
): Promise<AlertBatch> {
  const { notificationText } = await import("../notifications/email");
  const notices = sources.map((source) => ({
    id: String(source.id),
    key: "",
    at: source.at,
    event: source.event,
  }));
  const { t, tRoot, appName, url, subject, texts, titles } = await notificationText(
    notices,
    locale,
  );
  const translate = tRoot as unknown as (key: string) => string;
  // Said once in the catalog: the labels Needs attention, the WAF and analytics already use.
  const ruleName = (rule: AlertSource["rule"]) =>
    rule === null
      ? null
      : rule.settingKey
        ? settingLabel(tRoot as unknown as Parameters<typeof settingLabel>[0], rule.settingKey)
        : rule.name;
  const format = createFormatter({ locale, timeZone: "UTC" });
  return {
    subject,
    appName,
    url,
    items: sources.map((source, index) => ({
      id: source.id,
      kind: source.event.kind,
      title: titles[index],
      text: texts[index],
      severity: severityOf(source.severity),
      resolved: RECOVERY_KINDS.has(source.event.kind),
      at: source.at,
      time: format.dateTime(new Date(source.at), TIME_FORMAT),
      rule: ruleName(source.rule),
      event: source.event,
    })),
    labels: {
      severity: translate("waf.severity"),
      rule: translate("analytics.rule"),
      time: translate("proxyHosts.detail.auditTime"),
      open: t("notifications.action"),
      severities: {
        critical: translate("attention.severity.critical"),
        warning: translate("attention.severity.warning"),
        info: translate("attention.severity.info"),
        resolved: t("chat.resolved"),
      },
      more: (count) => t("notifications.pushMore", { count }),
    },
  };
}

/** Cut to `max` characters, marking the cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
