/**
 * A proxy host's status from its traffic, its signals and its certificate: what the host list's
 * Status column and the host page say. Pure and client safe; the server gathers the inputs.
 */

import type { TrafficSignal } from "../analytics/signals";
import type { AttentionSeverity } from "../attention/types";

/** A 5xx share this high, over at least this many requests, is a problem without a burst. */
export const SERVER_ERROR_SHARE_MIN = 0.05;
export const SERVER_ERROR_SHARE_MIN_REQUESTS = 20;

export type HostProblemCode =
  | "serverErrorBurst"
  | "serverErrorShare"
  | "blockedTraffic"
  | "certificateExpired"
  | "certificateExpiring";

export type HostProblem = { code: HostProblemCode; severity: AttentionSeverity };

export type HostState = "healthy" | "disabled" | "maintenance" | "problem";

export type HostStatus = { state: HostState; problem: HostProblem | null };

/** The names traffic is logged under. Wildcards are not expanded, as the list's totals are not. */
export function hostTrafficNames(domains: readonly string[]): string[] {
  return [
    ...new Set(
      domains.map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0 && !d.includes("*")),
    ),
  ];
}

/** The Host header carries a port on a non-default one. */
export function trafficHostName(host: string): string {
  return host.trim().toLowerCase().split(":")[0] ?? "";
}

export function indexHostsByName(
  hosts: readonly { id: number; domains: readonly string[] }[],
): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (const host of hosts) {
    for (const name of hostTrafficNames(host.domains)) {
      const ids = index.get(name);
      if (ids) ids.push(host.id);
      else index.set(name, [host.id]);
    }
  }
  return index;
}

/** A fleet-wide spike belongs to no host and is left out. */
export function signalsByProxyHost(
  signals: readonly TrafficSignal[],
  hosts: readonly { id: number; domains: readonly string[] }[],
): Map<number, TrafficSignal[]> {
  const index = indexHostsByName(hosts);
  const found = new Map<number, TrafficSignal[]>();
  for (const signal of signals) {
    if (signal.host === null) continue;
    for (const id of index.get(trafficHostName(signal.host)) ?? []) {
      const list = found.get(id);
      if (list) list.push(signal);
      else found.set(id, [signal]);
    }
  }
  return found;
}

export function hasServerErrorShare(traffic: { total: number; serverErrors: number }): boolean {
  return (
    traffic.total >= SERVER_ERROR_SHARE_MIN_REQUESTS &&
    traffic.serverErrors / traffic.total >= SERVER_ERROR_SHARE_MIN
  );
}

const RANK: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Worst first. */
export function hostProblems(input: {
  traffic: { total: number; serverErrors: number } | null;
  signals: readonly TrafficSignal[];
  certificateStage: "expired" | "expiring" | null;
}): HostProblem[] {
  const problems: HostProblem[] = [];
  const bursts = input.signals.filter((s) => s.kind === "serverErrorBurst");
  if (bursts.length > 0) {
    const ongoing = bursts.some((s) => s.kind === "serverErrorBurst" && s.ongoing);
    problems.push({ code: "serverErrorBurst", severity: ongoing ? "critical" : "warning" });
  } else if (input.traffic && hasServerErrorShare(input.traffic)) {
    problems.push({ code: "serverErrorShare", severity: "warning" });
  }
  if (input.certificateStage === "expired") {
    problems.push({ code: "certificateExpired", severity: "critical" });
  } else if (input.certificateStage === "expiring") {
    problems.push({ code: "certificateExpiring", severity: "warning" });
  }
  if (
    input.signals.some((s) => s.kind === "mitigationSpike" || s.kind === "blockedConcentration")
  ) {
    const spike = input.signals.some((s) => s.kind === "mitigationSpike");
    problems.push({ code: "blockedTraffic", severity: spike ? "warning" : "info" });
  }
  return problems.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/** Off and maintenance say more about a host than anything its traffic does. */
export function hostStatus(
  host: { enabled: boolean; maintenance?: { enabled?: boolean } | null },
  problems: readonly HostProblem[],
): HostStatus {
  if (!host.enabled) return { state: "disabled", problem: null };
  if (host.maintenance?.enabled) return { state: "maintenance", problem: null };
  const worst = problems[0] ?? null;
  return worst ? { state: "problem", problem: worst } : { state: "healthy", problem: null };
}

/** The same problems, read off a host's Needs attention items rather than raw signals. */
export function problemsFromAttention(
  items: readonly { code: string; severity: AttentionSeverity }[],
): HostProblem[] {
  const codes: Record<string, HostProblemCode> = {
    serverErrorBurst: "serverErrorBurst",
    serverErrorShare: "serverErrorShare",
    mitigationSpike: "blockedTraffic",
    blockedConcentration: "blockedTraffic",
    certificateExpired: "certificateExpired",
    certificateExpiring: "certificateExpiring",
  };
  const found = new Map<HostProblemCode, HostProblem>();
  for (const item of items) {
    const code = codes[item.code];
    if (!code) continue;
    const known = found.get(code);
    if (!known || RANK[item.severity] < RANK[known.severity]) {
      found.set(code, { code, severity: item.severity });
    }
  }
  return [...found.values()].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}
