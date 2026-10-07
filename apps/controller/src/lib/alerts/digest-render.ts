/**
 * A digest in words: sections of lines, every sentence from `email.digest.*` in the reader's
 * locale, every time in the reader's time zone. The email renders them as headed lists; the chat
 * channels get one alert item per section, so each builder's own limits cut it down to size.
 */

import { createFormatter } from "next-intl";
import { attentionMessageValues } from "../attention/types";
import { auditSummaryText } from "../audit/summary";
import { emailContext, escapeHtml } from "../email/messages";
import type { EmailMessage } from "../email/transport";
import { DEFAULT_LOCALE, type Locale } from "../locale";
import { regionName } from "../locale/region-names";
import type { AlertBatch } from "./message";
import { CERTIFICATE_DAYS, type DigestData } from "./digest-content";

export type DigestSection = { title: string; lines: string[] };

export type RenderedDigest = {
  subject: string;
  intro: string;
  sections: DigestSection[];
  appName: string;
  url: string;
  action: string;
  footer: string;
};

type Translate = (key: string, values?: Record<string, string | number | Date>) => string;

const DATE = { year: "numeric", month: "short", day: "numeric" } as const;
const TIME = { ...DATE, hour: "2-digit", minute: "2-digit", timeZoneName: "short" } as const;

/** `rate_limit` as stored, `rateLimit` as the catalog keys it. */
function outcomeKey(outcome: string): string {
  return outcome.replace(/_(\w)/g, (_, letter: string) => letter.toUpperCase());
}

export async function renderDigest(
  data: DigestData,
  reader: { locale?: Locale; timeZone: string } = { timeZone: "UTC" },
): Promise<RenderedDigest> {
  const locale = reader.locale ?? DEFAULT_LOCALE;
  const context = await emailContext(locale);
  const t = context.t as unknown as Translate;
  const tRoot = context.tRoot as unknown as Translate;
  const format = createFormatter({ locale, timeZone: reader.timeZone });
  const time = (at: number | string) => format.dateTime(new Date(at), TIME);
  const sections: DigestSection[] = [];
  const unavailable = t("digest.unavailable");

  const traffic = data.traffic;
  if (!data.analyticsOn) {
    sections.push({ title: t("digest.traffic.title"), lines: [t("digest.traffic.off")] });
  } else if (!traffic) {
    sections.push({ title: t("digest.traffic.title"), lines: [unavailable] });
  } else {
    sections.push({
      title: t("digest.traffic.title"),
      lines: [
        t("digest.traffic.totals", { requests: traffic.requests, mitigated: traffic.mitigated }),
        ...traffic.outcomes.map((row) =>
          t("digest.count", {
            name: tRoot(`analytics.outcomes.${outcomeKey(row.outcome)}`),
            count: row.count,
          }),
        ),
      ],
    });
    const top: [string, string[]][] = [
      [
        t("digest.hosts"),
        traffic.hosts.map((row) => t("digest.count", { name: row.host, count: row.count })),
      ],
      [
        t("digest.paths"),
        traffic.paths.map((row) =>
          t("digest.count", { name: `${row.host}${row.path}`, count: row.count }),
        ),
      ],
      [
        t("digest.rules"),
        traffic.rules.map((row) =>
          t("digest.count", {
            name: row.message ? `${row.ruleId} ${row.message}` : String(row.ruleId),
            count: row.count,
          }),
        ),
      ],
      [
        t("digest.newCountries"),
        traffic.newCountries.map((code) => `${regionName(code, locale)} (${code})`),
      ],
      [
        t("digest.newAsns"),
        traffic.newAsns.map((row) => (row.org ? `AS${row.asn} ${row.org}` : `AS${row.asn}`)),
      ],
    ];
    for (const [title, lines] of top) {
      sections.push({ title, lines: lines.length > 0 ? lines : [t("digest.none")] });
    }
  }

  sections.push({
    title: t("digest.certificates.title", { days: CERTIFICATE_DAYS }),
    lines: !data.certificates
      ? [unavailable]
      : data.certificates.length === 0
        ? [t("digest.certificates.none", { days: CERTIFICATE_DAYS })]
        : data.certificates.map((row) =>
            t("digest.certificates.line", {
              name: row.name,
              days: row.days,
              expired: row.expired ? "yes" : "no",
            }),
          ),
  });

  sections.push({
    title: t("digest.changes.title"),
    lines: !data.changes
      ? [unavailable]
      : [
          t("digest.changes.count", { count: data.changes.total }),
          ...data.changes.recent.map((event) =>
            t("digest.changes.line", {
              time: time(event.at),
              summary:
                auditSummaryText(
                  context.tRoot as unknown as Parameters<typeof auditSummaryText>[0],
                  event,
                ) ?? `${event.entityType} ${event.action}`,
            }),
          ),
        ],
  });

  sections.push({
    title: t("digest.backups.title"),
    lines: !data.backups
      ? [unavailable]
      : data.backups.length === 0
        ? [t("digest.backups.none")]
        : data.backups.map((row) =>
            row.at
              ? t("digest.backups.line", {
                  name: row.name,
                  status: row.status ?? "none",
                  time: time(row.at),
                })
              : t("digest.backups.never", { name: row.name }),
          ),
  });

  sections.push({
    title: tRoot("attention.title"),
    lines: !data.attention
      ? [unavailable]
      : [
          t("digest.attention.count", { count: data.attention.total }),
          ...data.attention.items.map((item) =>
            tRoot(`attention.items.${item.code}.title`, attentionMessageValues(item)),
          ),
        ],
  });

  const day = format.dateTime(new Date(data.to), DATE);
  return {
    subject: t("digest.subject", { appName: context.appName, date: day }),
    intro: t("digest.intro", {
      appName: context.appName,
      from: time(data.from),
      to: time(data.to),
    }),
    sections,
    appName: context.appName,
    url: context.url,
    action: t("notifications.action"),
    footer: context.footer,
  };
}

export function digestEmail(rendered: RenderedDigest, to: string[]): EmailMessage {
  const text = [
    rendered.intro,
    ...rendered.sections.map(
      (section) => `${section.title}\n${section.lines.map((line) => `- ${line}`).join("\n")}`,
    ),
    `${rendered.action}:\n${rendered.url}`,
    "--",
    rendered.footer,
  ].join("\n\n");
  const p = (content: string, style = "") =>
    `<p style="margin:0 0 16px;${style}">${escapeHtml(content)}</p>`;
  const html = [
    '<!doctype html><html><body style="margin:0;padding:24px;font-family:system-ui,sans-serif;' +
      'font-size:15px;line-height:1.5;color:#1f2328;background:#ffffff">',
    '<div style="max-width:600px;margin:0 auto">',
    p(rendered.intro),
    ...rendered.sections.map(
      (section) =>
        `<h3 style="margin:24px 0 8px;font-size:16px">${escapeHtml(section.title)}</h3>` +
        `<ul style="margin:0 0 16px;padding-left:20px">${section.lines
          .map((line) => `<li>${escapeHtml(line)}</li>`)
          .join("")}</ul>`,
    ),
    `<p style="margin:24px 0"><a href="${escapeHtml(rendered.url)}" style="display:inline-block;` +
      "padding:10px 18px;border-radius:6px;background:#1f6feb;color:#ffffff;" +
      `text-decoration:none;font-weight:600">${escapeHtml(rendered.action)}</a></p>`,
    '<hr style="border:none;border-top:1px solid #d1d9e0;margin:24px 0">',
    p(rendered.footer, "font-size:12px;color:#59636e"),
    "</div></body></html>",
  ].join("");
  return { to, subject: rendered.subject, text, html };
}

/** The chat form: a section per item, each builder cutting to its own limits. */
export function digestBatch(rendered: RenderedDigest, base: AlertBatch, at: number): AlertBatch {
  return {
    ...base,
    type: "digest",
    subject: rendered.subject,
    items: rendered.sections.map((section, index) => ({
      id: index + 1,
      kind: "test",
      title: section.title,
      text: section.lines.join("\n"),
      severity: "info",
      resolved: false,
      at: new Date(at).toISOString(),
      time: "",
      rule: null,
      event: { kind: "test" },
      facts: false,
    })),
  };
}
