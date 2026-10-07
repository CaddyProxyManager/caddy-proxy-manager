/**
 * Alert rules as the Alerts page and GraphQL change them, each change audited once here. A
 * built-in rule keeps its source and name, and its on switch stays the Settings toggle, so only
 * where it goes, how loud it is, its quiet period and a silence are edited here.
 */

import { asc, eq } from "drizzle-orm";
import { ATTENTION_CODES } from "../attention/types";
import { logAuditEvent } from "../audit";
import db, { nowIso } from "../db";
import { alertRules, notificationChannels } from "../db/schema";
import { domainError } from "../errors/domain-error";
import { ALERT_SEVERITIES, type AlertSeverity, builtins } from "../notifications/builtins";
import { ALERT_METRICS, EVENT_KINDS } from "../notifications/events";
import {
  type AlertRule,
  parseRule,
  RULE_SCOPES,
  RULE_SOURCES,
  type RuleScope,
  type RuleSource,
  ruleSwitchedOn,
} from "../notifications/rules";

/** The traffic signals a rule can watch, by the Needs attention codes they show up as. */
export const SIGNAL_CODES = {
  serverErrorBurst: ["serverErrorBurst"],
  mitigationSpike: ["mitigationSpike", "mitigationSpikeFleet"],
  blockedConcentration: ["blockedConcentration"],
} as const;
export type SignalKind = keyof typeof SIGNAL_CODES;
export const SIGNAL_KINDS = Object.keys(SIGNAL_CODES) as SignalKind[];

export const MAX_QUIET_MINUTES = 10_080;
export const MAX_METRIC_MINUTES = 1_440;

export type RuleInput = {
  name?: string | null;
  source?: string | null;
  /** event: the kinds it tells about. */
  kinds?: string[] | null;
  /** attention: the Needs attention codes. */
  codes?: string[] | null;
  /** signal: the traffic signals. */
  signals?: string[] | null;
  metric?: string | null;
  comparison?: string | null;
  threshold?: number | null;
  minutes?: number | null;
  scope?: string | null;
  hostIds?: number[] | null;
  tags?: string[] | null;
  severity?: string | null;
  channelIds?: number[] | null;
  quietMinutes?: number | null;
  enabled?: boolean | null;
  /** ISO; null or a past time lifts the silence. */
  silencedUntil?: string | null;
};

export type RuleView = Omit<AlertRule, "config" | "scopeValues"> & {
  config: Record<string, unknown>;
  hostIds: number[];
  tags: string[];
  /** For a built-in rule, its Settings switch; the rule's own flag otherwise. */
  on: boolean;
  /** The Settings key whose label names a built-in rule. */
  settingKey: string | null;
};

async function toView(rule: AlertRule, keys: Record<string, string>): Promise<RuleView> {
  const { scopeValues, ...rest } = rule;
  return {
    ...rest,
    hostIds:
      rule.scope === "hosts" ? scopeValues.filter((v): v is number => typeof v === "number") : [],
    tags:
      rule.scope === "tags" ? scopeValues.filter((v): v is string => typeof v === "string") : [],
    on: await ruleSwitchedOn(rule),
    settingKey: rule.builtin ? (keys[rule.builtin] ?? null) : null,
  };
}

export async function listRules(): Promise<RuleView[]> {
  await builtins();
  const rows = await db.select().from(alertRules).orderBy(asc(alertRules.id));
  const { categorySettingKeys } = await import("../notifications");
  const keys = await categorySettingKeys();
  return Promise.all(rows.map((row) => toView(parseRule(row), keys)));
}

export async function getRule(id: number): Promise<AlertRule | null> {
  const [row] = await db.select().from(alertRules).where(eq(alertRules.id, id));
  return row ? parseRule(row) : null;
}

export async function requireRule(id: number): Promise<AlertRule> {
  const rule = await getRule(id);
  if (!rule) throw domainError("alertRuleNotFound", {}, { status: 404 });
  return rule;
}

function list<T extends string>(values: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is T => allowed.includes(value as T)))];
}

function whole(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

async function channelIdsFrom(input: number[] | null | undefined, fallback: number[]) {
  const ids = [...new Set((input ?? fallback).filter((id) => Number.isInteger(id)))];
  const rows = await db.select({ id: notificationChannels.id }).from(notificationChannels);
  if (ids.length === 0 || !ids.every((id) => rows.some((row) => row.id === id))) {
    throw domainError("alertRuleChannelsInvalid", {}, { status: 400 });
  }
  return ids;
}

function sourceConfig(source: RuleSource, input: RuleInput, existing: AlertRule | null) {
  const stored = existing?.source === source ? existing.config : {};
  switch (source) {
    case "event": {
      const kinds = list(input.kinds ?? stored.kinds, EVENT_KINDS);
      if (kinds.length === 0) throw domainError("alertRuleSourceInvalid", {}, { status: 400 });
      return { kinds };
    }
    case "attention": {
      const codes = list(input.codes ?? stored.codes, ATTENTION_CODES);
      if (codes.length === 0) throw domainError("alertRuleSourceInvalid", {}, { status: 400 });
      return { codes };
    }
    case "signal": {
      const signals = list(input.signals ?? stored.signals, SIGNAL_KINDS);
      if (signals.length === 0) throw domainError("alertRuleSourceInvalid", {}, { status: 400 });
      return { signals };
    }
    case "metric": {
      const metric = input.metric ?? stored.metric;
      const comparison = input.comparison ?? stored.comparison ?? "above";
      const threshold = input.threshold ?? stored.threshold;
      const minutes = whole(input.minutes ?? stored.minutes, 1, MAX_METRIC_MINUTES);
      if (
        !ALERT_METRICS.includes(metric as never) ||
        !["above", "below"].includes(String(comparison))
      ) {
        throw domainError("alertRuleSourceInvalid", {}, { status: 400 });
      }
      if (
        typeof threshold !== "number" ||
        !Number.isFinite(threshold) ||
        threshold < 0 ||
        minutes === null
      ) {
        throw domainError("alertRuleThresholdInvalid", {}, { status: 400 });
      }
      return { metric, comparison, threshold, minutes };
    }
  }
}

function scopeFrom(input: RuleInput, existing: AlertRule | null) {
  const scope = (input.scope ?? existing?.scope ?? "all") as RuleScope;
  if (!RULE_SCOPES.includes(scope)) throw domainError("alertRuleScopeInvalid", {}, { status: 400 });
  if (scope === "all") return { scope, scopeValues: [] as (number | string)[] };
  // Left out of an edit that keeps the scope, the stored hosts or tags stay.
  const kept = existing?.scope === scope ? existing.scopeValues : [];
  const values =
    scope === "hosts"
      ? [
          ...new Set(
            (input.hostIds ?? kept.filter((v): v is number => typeof v === "number")).filter((id) =>
              Number.isInteger(id),
            ),
          ),
        ]
      : [
          ...new Set(
            (input.tags ?? kept.filter((v): v is string => typeof v === "string"))
              .map((tag) => tag.trim().toLowerCase())
              .filter(Boolean),
          ),
        ];
  if (values.length === 0) throw domainError("alertRuleScopeInvalid", {}, { status: 400 });
  return { scope, scopeValues: values };
}

function silenceFrom(value: string | null | undefined, existing: AlertRule | null): string | null {
  if (value === undefined) return existing?.silencedUntil ?? null;
  if (value === null || value === "") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

async function prepare(input: RuleInput, existing: AlertRule | null) {
  const severity = (input.severity ?? existing?.severity ?? "warning") as AlertSeverity;
  if (!ALERT_SEVERITIES.includes(severity)) {
    throw domainError("alertRuleSourceInvalid", {}, { status: 400 });
  }
  const quietMinutes = whole(
    input.quietMinutes ?? existing?.quietMinutes ?? 0,
    0,
    MAX_QUIET_MINUTES,
  );
  if (quietMinutes === null) throw domainError("alertRuleQuietInvalid", {}, { status: 400 });
  const common = {
    severity,
    quietMinutes,
    channelIds: JSON.stringify(await channelIdsFrom(input.channelIds, existing?.channelIds ?? [])),
    silencedUntil: silenceFrom(input.silencedUntil, existing),
  };
  if (existing?.builtin) {
    if (
      (input.source && input.source !== existing.source) ||
      (input.name && input.name !== existing.name)
    ) {
      throw domainError("alertRuleBuiltin", {}, { status: 400 });
    }
    return common;
  }
  const name = input.name?.trim() ?? existing?.name ?? "";
  if (!name || name.length > 100) throw domainError("alertRuleNameRequired", {}, { status: 400 });
  const source = (input.source ?? existing?.source) as RuleSource;
  if (!RULE_SOURCES.includes(source))
    throw domainError("alertRuleSourceInvalid", {}, { status: 400 });
  const { scope, scopeValues } = scopeFrom(input, existing);
  return {
    ...common,
    name,
    source,
    sourceConfig: JSON.stringify(sourceConfig(source, input, existing)),
    scope,
    scopeValues: JSON.stringify(scopeValues),
    enabled: input.enabled ?? existing?.enabled ?? true,
  };
}

async function viewOf(id: number): Promise<RuleView> {
  const { categorySettingKeys } = await import("../notifications");
  return toView(await requireRule(id), await categorySettingKeys());
}

export async function createRule(input: RuleInput, userId: number | null): Promise<RuleView> {
  const prepared = await prepare(input, null);
  // Only a built-in rule's edit leaves these out, and nothing creates one here.
  if (!("name" in prepared)) throw domainError("alertRuleBuiltin", {}, { status: 400 });
  const at = nowIso();
  const [row] = await db
    .insert(alertRules)
    .values({ ...prepared, createdAt: at, updatedAt: at })
    .returning();
  await logAuditEvent({
    userId,
    action: "create",
    entityType: "alert_rule",
    entityId: row.id,
    summary: `Created alert rule ${row.name}`,
  });
  return viewOf(row.id);
}

export async function updateRule(
  id: number,
  input: RuleInput,
  userId: number | null,
): Promise<RuleView> {
  const existing = await requireRule(id);
  const prepared = await prepare(input, existing);
  await db
    .update(alertRules)
    .set({ ...prepared, updatedAt: nowIso() })
    .where(eq(alertRules.id, id));
  await logAuditEvent({
    userId,
    action: "update",
    entityType: "alert_rule",
    entityId: id,
    summary: `Updated alert rule ${existing.name}`,
  });
  return viewOf(id);
}

/** Until `until`, or lifted with null; audited as an update. */
export async function silenceRule(
  id: number,
  until: string | null,
  userId: number | null,
): Promise<RuleView> {
  return updateRule(id, { silencedUntil: until }, userId);
}

export async function deleteRule(id: number, userId: number | null): Promise<void> {
  const existing = await requireRule(id);
  if (existing.builtin) throw domainError("alertRuleBuiltin", {}, { status: 400 });
  await db.delete(alertRules).where(eq(alertRules.id, id));
  await logAuditEvent({
    userId,
    action: "delete",
    entityType: "alert_rule",
    entityId: id,
    summary: `Deleted alert rule ${existing.name}`,
  });
}

/** Queues a test through the rule's channels; the event id, or 0 with none enabled. */
export async function testRule(id: number, displayName?: string): Promise<number> {
  const rule = await requireRule(id);
  const { queueRuleTest } = await import("../notifications");
  return queueRuleTest(rule, displayName ?? rule.name);
}
