/**
 * What each email says. Translated with `createTranslator` rather than `getTranslations`: the
 * certificate alerts are sent from a timer, where there is no request to read a locale from.
 */

import type { AccountDisabledReason } from "../notifications/account-owner";
import { createTranslator } from "next-intl";
import { getAppName } from "../branding/app-name";
import { DEFAULT_LOCALE, type Locale } from "../locale";
import { getPublicBaseUrl } from "../http/public-url";
import type { EmailMessage } from "./transport";

type Catalog = typeof import("../../../messages/en.json");

async function emailTranslator(locale: Locale) {
  const messages = (await import(`../../../messages/${locale}.json`)).default as Catalog;
  return createTranslator({ locale, messages, namespace: "email" });
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

type Body = {
  paragraphs: string[];
  /** Bulleted, after the paragraphs. */
  items?: string[];
  action?: { label: string; url: string };
  /** After the action, in the small print. */
  notes?: string[];
  footer: string;
};

/** Plain text first; the HTML part carries the same words, escaped, with no remote content. */
export function renderBody(body: Body): { text: string; html: string } {
  const text = [
    ...body.paragraphs,
    ...(body.items?.length ? [body.items.map((item) => `- ${item}`).join("\n")] : []),
    ...(body.action ? [`${body.action.label}:\n${body.action.url}`] : []),
    ...(body.notes ?? []),
    "--",
    body.footer,
  ].join("\n\n");

  const p = (content: string, style = "") =>
    `<p style="margin:0 0 16px;${style}">${escapeHtml(content)}</p>`;
  const html = [
    '<!doctype html><html><body style="margin:0;padding:24px;font-family:system-ui,sans-serif;' +
      'font-size:15px;line-height:1.5;color:#1f2328;background:#ffffff">',
    '<div style="max-width:560px;margin:0 auto">',
    ...body.paragraphs.map((paragraph) => p(paragraph)),
    ...(body.items?.length
      ? [
          `<ul style="margin:0 0 16px;padding-left:20px">${body.items
            .map((item) => `<li>${escapeHtml(item)}</li>`)
            .join("")}</ul>`,
        ]
      : []),
    ...(body.action
      ? [
          `<p style="margin:24px 0"><a href="${escapeHtml(body.action.url)}" style="display:inline-block;` +
            "padding:10px 18px;border-radius:6px;background:#1f6feb;color:#ffffff;" +
            `text-decoration:none;font-weight:600">${escapeHtml(body.action.label)}</a></p>`,
          p(body.action.url, "font-size:13px;color:#59636e;word-break:break-all"),
        ]
      : []),
    ...(body.notes ?? []).map((note) => p(note, "font-size:13px;color:#59636e")),
    '<hr style="border:none;border-top:1px solid #d1d9e0;margin:24px 0">',
    p(body.footer, "font-size:12px;color:#59636e"),
    "</div></body></html>",
  ].join("");

  return { text, html };
}

/** Shared with the admin notifications (lib/notifications/email.ts). */
export async function emailContext(locale: Locale) {
  const [t, appName, url] = await Promise.all([
    emailTranslator(locale),
    getAppName(),
    getPublicBaseUrl(),
  ]);
  return { t, appName, url, footer: t("footer", { appName, url }) };
}

export async function testEmail(
  to: string,
  host: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<EmailMessage> {
  const { t, appName, footer } = await emailContext(locale);
  return {
    to,
    subject: t("test.subject", { appName }),
    ...renderBody({ paragraphs: [t("test.body", { appName, host })], footer }),
  };
}

export async function resetLinkEmail(
  input: { to: string; link: string; minutes: number },
  locale: Locale = DEFAULT_LOCALE,
): Promise<EmailMessage> {
  const { t, appName, footer } = await emailContext(locale);
  return {
    to: input.to,
    subject: t("passwordReset.subject", { appName }),
    ...renderBody({
      paragraphs: [t("passwordReset.intro", { appName, email: input.to })],
      action: { label: t("passwordReset.action"), url: input.link },
      notes: [t("passwordReset.expiry", { minutes: input.minutes }), t("passwordReset.ignore")],
      footer,
    }),
  };
}

export async function accountDisabledEmail(
  input: { to: string; reason: AccountDisabledReason },
  locale: Locale = DEFAULT_LOCALE,
): Promise<EmailMessage> {
  const { t, appName, footer } = await emailContext(locale);
  const why =
    input.reason.by === "failedSignIns"
      ? t("accountDisabled.byFailedSignIns", { failures: input.reason.failures })
      : t("accountDisabled.byAdministrator");
  return {
    to: input.to,
    subject: t("accountDisabled.subject", { appName }),
    ...renderBody({
      paragraphs: [t("accountDisabled.intro", { appName, email: input.to }), why],
      notes: [t("accountDisabled.nothingElse")],
      footer,
    }),
  };
}

export async function inviteEmail(
  input: { to: string; link: string; days: number; inviter: string },
  locale: Locale = DEFAULT_LOCALE,
): Promise<EmailMessage> {
  const { t, appName, footer } = await emailContext(locale);
  return {
    to: input.to,
    subject: t("invite.subject", { appName }),
    ...renderBody({
      paragraphs: [
        t("invite.intro", { appName, inviter: input.inviter, email: input.to }),
        t("invite.signIn", { username: input.to }),
      ],
      action: { label: t("invite.action"), url: input.link },
      notes: [t("invite.expiry", { days: input.days })],
      footer,
    }),
  };
}

export type CertificateAlertItem = {
  name: string;
  /** ISO timestamp. */
  notAfter: string;
  /** Where it was found: an agent's name, or "imported". */
  source: { kind: "imported" } | { kind: "agent"; name: string };
};

export async function certificateAlertEmail(
  input: { to: string[]; items: CertificateAlertItem[]; thresholdDays: number; now?: number },
  locale: Locale = DEFAULT_LOCALE,
): Promise<EmailMessage> {
  const { t, appName, url, footer } = await emailContext(locale);
  const now = input.now ?? Date.now();
  const items = input.items.map((item) => {
    const notAfter = Date.parse(item.notAfter);
    // A date, not a time: the reader's zone is unknown, and UTC keeps it unambiguous.
    const date = new Date(notAfter).toISOString().slice(0, 10);
    const where =
      item.source.kind === "imported"
        ? t("certificateAlert.sourceImported")
        : t("certificateAlert.sourceAgent", { agent: item.source.name });
    if (notAfter <= now) return t("certificateAlert.expired", { name: item.name, date, where });
    const days = Math.floor((notAfter - now) / 86_400_000);
    return t("certificateAlert.expiring", { name: item.name, date, days, where });
  });
  return {
    to: input.to,
    subject: t("certificateAlert.subject", { appName, count: input.items.length }),
    ...renderBody({
      paragraphs: [t("certificateAlert.intro", { appName, days: input.thresholdDays })],
      items,
      action: { label: t("certificateAlert.action"), url: `${url}/certificates` },
      notes: [t("certificateAlert.once")],
      footer,
    }),
  };
}
