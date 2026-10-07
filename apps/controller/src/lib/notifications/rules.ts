/**
 * Which rules an event matches. A built-in rule is on while its category's Settings switch is;
 * one an administrator added has its own. A rule scoped to hosts or tags matches only an event
 * that names a proxy host, by the same exact-then-wildcard match Caddy routes by.
 */

import { asc } from "drizzle-orm";
import db from "../db";
import { alertRules, proxyHosts } from "../db/schema";
import { hostMatchesPattern } from "../proxy-hosts/pattern-priority";
import type { AlertSeverity } from "./builtins";
import { categoryOf, hostOf, type NotificationCategory, type NotificationEvent } from "./events";

export const RULE_SOURCES = ["event", "attention", "signal", "metric"] as const;
export type RuleSource = (typeof RULE_SOURCES)[number];
export const RULE_SCOPES = ["all", "hosts", "tags"] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

export type AlertRule = {
  id: number;
  name: string;
  builtin: NotificationCategory | null;
  source: RuleSource;
  config: Record<string, unknown>;
  scope: RuleScope;
  /** Host ids for `hosts`, tags for `tags`. */
  scopeValues: (number | string)[];
  severity: AlertSeverity;
  channelIds: number[];
  quietMinutes: number;
  enabled: boolean;
  silencedUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function jsonArray(text: string): unknown[] {
  const parsed = parse(text);
  return Array.isArray(parsed) ? parsed : [];
}

export function jsonObject(text: string): Record<string, unknown> {
  const parsed = parse(text);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export function parseRule(row: typeof alertRules.$inferSelect): AlertRule {
  const channelIds = jsonArray(row.channelIds).filter((id): id is number => typeof id === "number");
  return {
    id: row.id,
    name: row.name,
    builtin: (row.builtin as NotificationCategory | null) ?? null,
    source: row.source as RuleSource,
    config: jsonObject(row.sourceConfig),
    scope: row.scope as RuleScope,
    scopeValues: jsonArray(row.scopeValues).filter(
      (value): value is number | string => typeof value === "number" || typeof value === "string",
    ),
    severity: row.severity as AlertSeverity,
    channelIds,
    quietMinutes: row.quietMinutes,
    enabled: row.enabled,
    silencedUntil: row.silencedUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function loadRules(): Promise<AlertRule[]> {
  const rows = await db.select().from(alertRules).orderBy(asc(alertRules.id));
  return rows.map(parseRule);
}

/** On, ignoring a silence: a built-in rule follows its Settings switch. */
export async function ruleSwitchedOn(rule: AlertRule): Promise<boolean> {
  if (!rule.builtin) return rule.enabled;
  const { notificationCategoryEnabled } = await import("./index");
  return notificationCategoryEnabled(rule.builtin);
}

export function ruleSilenced(rule: AlertRule, now: number): boolean {
  return rule.silencedUntil !== null && Date.parse(rule.silencedUntil) > now;
}

export type ScopeHost = { id: number; domains: string[]; tags: string[] };

let hostCache: { at: number; hosts: ScopeHost[] } | null = null;
const HOST_CACHE_MS = 30_000;

export function forgetScopeHosts(): void {
  hostCache = null;
}

export async function scopeHosts(now = Date.now()): Promise<ScopeHost[]> {
  if (hostCache && now - hostCache.at < HOST_CACHE_MS) return hostCache.hosts;
  const rows = await db
    .select({ id: proxyHosts.id, domains: proxyHosts.domains, tags: proxyHosts.tags })
    .from(proxyHosts);
  const list = (text: string) =>
    jsonArray(text).flatMap((value) => (typeof value === "string" ? [value.toLowerCase()] : []));
  const hosts = rows.map((row) => ({
    id: row.id,
    domains: list(row.domains),
    tags: list(row.tags),
  }));
  hostCache = { at: now, hosts };
  return hosts;
}

/** The proxy hosts a request host reaches: exact names first, else the wildcard that catches it. */
export function hostsNamed(hosts: readonly ScopeHost[], name: string): ScopeHost[] {
  const bare = name.toLowerCase().replace(/:\d+$/, "");
  if (!bare) return [];
  const exact = hosts.filter((host) => host.domains.includes(bare));
  if (exact.length > 0) return exact;
  return hosts.filter((host) => host.domains.some((domain) => hostMatchesPattern(bare, domain)));
}

export function inScope(rule: AlertRule, hosts: readonly ScopeHost[]): boolean {
  if (rule.scope === "all") return true;
  if (rule.scope === "hosts") return hosts.some((host) => rule.scopeValues.includes(host.id));
  return hosts.some((host) => host.tags.some((tag) => rule.scopeValues.includes(tag)));
}

/** The event rules an event matches, on and not silenced, oldest first. */
export async function rulesForEvent(
  event: NotificationEvent,
  now: number,
  rules?: readonly AlertRule[],
): Promise<AlertRule[]> {
  if (event.kind === "test") return [];
  const category = categoryOf(event);
  const host = hostOf(event);
  let named: ScopeHost[] | null = null;
  const matched: AlertRule[] = [];
  for (const rule of rules ?? (await loadRules())) {
    if (rule.source !== "event" || ruleSilenced(rule, now)) continue;
    const kinds = Array.isArray(rule.config.kinds) ? rule.config.kinds : [];
    const categories = Array.isArray(rule.config.categories) ? rule.config.categories : [];
    if (!kinds.includes(event.kind) && !(category && categories.includes(category))) continue;
    if (rule.scope !== "all") {
      if (host === null) continue;
      named ??= hostsNamed(await scopeHosts(now), host);
      if (!inScope(rule, named)) continue;
    }
    if (!(await ruleSwitchedOn(rule))) continue;
    matched.push(rule);
  }
  return matched;
}
