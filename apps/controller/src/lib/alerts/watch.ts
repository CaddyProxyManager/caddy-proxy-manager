/**
 * Rules that watch for themselves, run from the notification tick once a minute: Needs attention
 * items and traffic signals (which reach Needs attention too), and metric thresholds per proxy host
 * over ClickHouse. Each match is a problem keyed by the rule and what it found, so it is told once
 * and resolved when it is gone. A source that could not be read resolves nothing.
 */

import { emptyGrants } from "../models/group-grants";
import type { AlertMetric } from "../notifications/events";
import {
  type AlertRule,
  hostsNamed,
  inScope,
  loadRules,
  ruleSilenced,
  ruleSwitchedOn,
  type ScopeHost,
  scopeHosts,
} from "../notifications/rules";
import { SIGNAL_CODES, type SignalKind } from "./rule-store";

const EVERY_MS = 60_000;
let lastRun = 0;

/** Test seam. */
export function resetRuleWatchForTests(): void {
  lastRun = 0;
}

export function ruleKey(ruleId: number, what: string): string {
  return `rule:${ruleId}:${what}`;
}

async function activeRules(now: number): Promise<AlertRule[]> {
  const rules = (await loadRules()).filter(
    (rule) => rule.source !== "event" && !rule.builtin && !ruleSilenced(rule, now),
  );
  const on: AlertRule[] = [];
  for (const rule of rules) if (await ruleSwitchedOn(rule)) on.push(rule);
  return on;
}

/** Closes what a rule had open and no longer finds. */
async function resolveGone(
  rule: AlertRule,
  found: ReadonlySet<string>,
  recovery: (key: string) => Parameters<typeof import("../notifications").resolveProblem>[1],
  now: number,
): Promise<void> {
  const { openProblemKeys, resolveProblem } = await import("../notifications");
  for (const key of await openProblemKeys(ruleKey(rule.id, ""))) {
    if (!found.has(key)) await resolveProblem(key, recovery(key), now);
  }
}

async function watchAttention(rules: readonly AlertRule[], now: number): Promise<void> {
  const watching = rules.filter((rule) => rule.source === "attention" || rule.source === "signal");
  if (watching.length === 0) return;
  const { collectAttention } = await import("../attention");
  const list = await collectAttention(
    { userId: 0, role: "admin", isAdmin: true, isOperator: false, grants: emptyGrants() },
    { now },
  );
  const { raiseRuleProblem } = await import("../notifications");
  for (const rule of watching) {
    const codes: string[] =
      rule.source === "attention"
        ? ((rule.config.codes as string[] | undefined) ?? [])
        : ((rule.config.signals as SignalKind[] | undefined) ?? []).flatMap((signal) => [
            ...(SIGNAL_CODES[signal] ?? []),
          ]);
    const found = new Set<string>();
    for (const item of list.items) {
      if (!codes.includes(item.code)) continue;
      if (rule.scope !== "all") {
        const hosts = (await scopeHosts(now)).filter((host) =>
          (item.scope.proxyHosts ?? []).includes(host.id),
        );
        if (!inScope(rule, hosts)) continue;
      }
      const key = ruleKey(rule.id, item.id);
      found.add(key);
      await raiseRuleProblem(
        rule,
        key,
        { kind: "attention", code: item.code, values: item.values, href: item.href },
        now,
      );
    }
    // A skipped provider's items are missing, not cleared.
    if (list.skipped.length > 0) continue;
    await resolveGone(
      rule,
      found,
      () => (raised) =>
        raised?.kind === "attention"
          ? { kind: "attentionResolved", code: raised.code, values: raised.values }
          : null,
      now,
    );
  }
}

export type HostCounts = { requests: number; serverErrors: number; mitigated: number };

/** Requests, 5xx and mitigated per request host over the last `minutes`. */
export async function hostMetricCounts(
  minutes: number,
  now: number,
): Promise<Map<string, HostCounts> | null> {
  const { isAnalyticsEnabled, queryRows, timeFilter, timeParams } = await import(
    "../clickhouse/client"
  );
  if (!(await isAnalyticsEnabled().catch(() => false))) return null;
  const to = Math.floor(now / 1000);
  const rows = await queryRows<Record<string, unknown>>(
    `
    SELECT host, count() AS requests, countIf(status >= 500) AS errors,
           countIf(outcome != 'served') AS mitigated
    FROM traffic_events
    WHERE ${timeFilter()} AND host != ''
    GROUP BY host
    LIMIT 10000
  `,
    timeParams(to - minutes * 60, to),
  );
  return new Map(
    rows.map((row) => [
      String(row.host),
      {
        requests: Number(row.requests),
        serverErrors: Number(row.errors),
        mitigated: Number(row.mitigated),
      },
    ]),
  );
}

let metricCounts = hostMetricCounts;

/** Test seam: what a metric rule reads instead of ClickHouse. */
export function setHostMetricCountsForTests(fake: typeof hostMetricCounts | null): void {
  metricCounts = fake ?? hostMetricCounts;
}

function measure(metric: AlertMetric, counts: HostCounts): number {
  switch (metric) {
    case "requests":
      return counts.requests;
    case "serverErrors":
      return counts.serverErrors;
    case "mitigated":
      return counts.mitigated;
    case "serverErrorShare":
      return counts.requests === 0
        ? 0
        : Math.round((counts.serverErrors / counts.requests) * 1000) / 10;
  }
}

/** Per proxy host: the counts of every name it serves added up. */
function perHost(
  hosts: readonly ScopeHost[],
  counts: ReadonlyMap<string, HostCounts>,
): Map<number, HostCounts> {
  const totals = new Map<number, HostCounts>(
    hosts.map((host) => [host.id, { requests: 0, serverErrors: 0, mitigated: 0 }]),
  );
  for (const [name, row] of counts) {
    for (const host of hostsNamed(hosts, name)) {
      const total = totals.get(host.id)!;
      total.requests += row.requests;
      total.serverErrors += row.serverErrors;
      total.mitigated += row.mitigated;
    }
  }
  return totals;
}

async function watchMetrics(rules: readonly AlertRule[], now: number): Promise<void> {
  const watching = rules.filter((rule) => rule.source === "metric");
  if (watching.length === 0) return;
  const hosts = await scopeHosts(now);
  const { raiseRuleProblem } = await import("../notifications");
  const byWindow = new Map<number, Map<number, HostCounts> | null>();
  for (const rule of watching) {
    const metric = rule.config.metric as AlertMetric;
    const comparison = rule.config.comparison === "below" ? "below" : "above";
    const threshold = Number(rule.config.threshold);
    const minutes = Number(rule.config.minutes);
    if (!byWindow.has(minutes)) {
      const counts = await metricCounts(minutes, now);
      byWindow.set(minutes, counts && perHost(hosts, counts));
    }
    const totals = byWindow.get(minutes);
    if (!totals) continue;
    const found = new Set<string>();
    for (const host of hosts) {
      if (!inScope(rule, [host])) continue;
      const value = measure(metric, totals.get(host.id)!);
      const crossed = comparison === "above" ? value > threshold : value < threshold;
      if (!crossed) continue;
      const key = ruleKey(rule.id, `host:${host.id}`);
      found.add(key);
      await raiseRuleProblem(
        rule,
        key,
        {
          kind: "metricThreshold",
          host: host.domains[0] ?? String(host.id),
          metric,
          comparison,
          value,
          threshold,
          minutes,
        },
        now,
      );
    }
    await resolveGone(
      rule,
      found,
      () => (raised) =>
        raised?.kind === "metricThreshold"
          ? { kind: "metricRecovered", host: raised.host, metric: raised.metric }
          : null,
      now,
    );
  }
}

/** A notification watcher: once a minute, whatever the tick. */
export async function watchRuleSources(now: number): Promise<void> {
  if (now - lastRun < EVERY_MS) return;
  lastRun = now;
  const rules = await activeRules(now);
  if (rules.length === 0) return;
  await watchAttention(rules, now).catch((error: unknown) => {
    console.error("[alerts] could not check Needs attention for rules:", error);
  });
  await watchMetrics(rules, now).catch((error: unknown) => {
    console.error("[alerts] could not check metric rules:", error);
  });
}
