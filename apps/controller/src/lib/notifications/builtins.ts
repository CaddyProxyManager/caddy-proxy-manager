/**
 * The email and push channels every install has, and one built-in rule per notification category
 * routed to both: what was sent before rules existed. Created on first use rather than by the SQL
 * migration, so a restored backup or a category added in a later release fills itself in.
 */

import { inArray, isNotNull } from "drizzle-orm";
import db, { nowIso } from "../db";
import { alertRules, notificationChannels } from "../db/schema";
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from "./events";

export const ALERT_SEVERITIES = ["critical", "warning", "info"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const BUILTIN_CHANNELS = ["email", "push"] as const;
export type BuiltinChannel = (typeof BUILTIN_CHANNELS)[number];

export const CATEGORY_SEVERITY: Record<NotificationCategory, AlertSeverity> = {
  accountDisabled: "warning",
  adminLocked: "warning",
  adminAdded: "info",
  agentOffline: "critical",
  upstreamErrors: "warning",
  caddyApply: "critical",
  agentProblems: "warning",
  geoip: "warning",
  crsPlugin: "warning",
  updateAvailable: "info",
  backups: "critical",
  auditSinks: "critical",
  channels: "warning",
};

export type Builtins = {
  email: number;
  push: number;
  rules: ReadonlyMap<string, { id: number; severity: AlertSeverity }>;
};

/** Long enough to spare a query per event, short enough that a restore is picked up. */
const MEMO_MS = 60_000;
let memo: { at: number; value: Promise<Builtins> } | null = null;

export function builtins(now = Date.now()): Promise<Builtins> {
  if (memo && now - memo.at < MEMO_MS) return memo.value;
  const value = ensureBuiltins().catch((error: unknown) => {
    memo = null;
    throw error;
  });
  memo = { at: now, value };
  return value;
}

export function forgetBuiltins(): void {
  memo = null;
}

async function ensureBuiltins(): Promise<Builtins> {
  const at = nowIso();
  await db
    .insert(notificationChannels)
    .values(
      BUILTIN_CHANNELS.map((kind) => ({
        name: kind,
        kind,
        builtin: kind,
        createdAt: at,
        updatedAt: at,
      })),
    )
    .onConflictDoNothing();
  const channels = await db
    .select({ id: notificationChannels.id, builtin: notificationChannels.builtin })
    .from(notificationChannels)
    .where(inArray(notificationChannels.builtin, [...BUILTIN_CHANNELS]));
  const email = channels.find((row) => row.builtin === "email")?.id;
  const push = channels.find((row) => row.builtin === "push")?.id;
  // A name an administrator gave a channel of their own blocks the insert: rename theirs.
  if (email === undefined || push === undefined) throw new Error("built-in channels missing");

  await db
    .insert(alertRules)
    .values(
      NOTIFICATION_CATEGORIES.map((category) => ({
        name: category,
        builtin: category,
        source: "event",
        sourceConfig: JSON.stringify({ categories: [category] }),
        severity: CATEGORY_SEVERITY[category],
        channelIds: JSON.stringify([email, push]),
        createdAt: at,
        updatedAt: at,
      })),
    )
    .onConflictDoNothing();
  const rules = await db
    .select({ id: alertRules.id, builtin: alertRules.builtin, severity: alertRules.severity })
    .from(alertRules)
    .where(isNotNull(alertRules.builtin));
  return {
    email,
    push,
    rules: new Map(
      rules.map((rule) => [
        rule.builtin as string,
        { id: rule.id, severity: rule.severity as AlertSeverity },
      ]),
    ),
  };
}
