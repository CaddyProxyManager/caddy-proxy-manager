/**
 * The host list's traffic columns: requests against the busiest host, 5xx, status, protections
 * and certificate days left. Only with analytics on; without them the list keeps its plain columns.
 * Each slow input (signals, the certificate inventory) is read under a short budget and simply
 * missing when late, so the list never waits on an agent.
 */

import type { ProxyHost } from "../models/proxy-hosts";
import { type HostProtections, hostProtections } from "./protections";
import { type HostStatus, hostProblems, hostStatus, signalsByProxyHost } from "./traffic-status";

export type HostInsight = {
  requests: number;
  blocked: number;
  serverErrors: number;
  /** Against the busiest host the list's filters match, 0 to 1. */
  share: number;
  status: HostStatus;
  /** Null when the certificate is not known, e.g. no agent answered in time. */
  certificateDaysLeft: number | null;
  protections: HostProtections;
};

export type ListInsights =
  | { available: false }
  | {
      available: true;
      /** Across every host the filters match, not this page. */
      totals: { requests: number; blocked: number };
      byHost: Record<number, HostInsight>;
    };

type Traffic = { total: number; blocked: number; serverErrors: number };

/** Busiest first; ties keep the given order, which is newest first. */
export function sortIdsByRequests(
  ids: readonly number[],
  traffic: ReadonlyMap<number, { total: number }>,
  dir: "asc" | "desc",
): number[] {
  const order = new Map(ids.map((id, index) => [id, index]));
  const sign = dir === "asc" ? 1 : -1;
  return [...ids].sort((a, b) => {
    const diff = (traffic.get(a)?.total ?? 0) - (traffic.get(b)?.total ?? 0);
    return diff !== 0 ? sign * diff : (order.get(a) ?? 0) - (order.get(b) ?? 0);
  });
}

const LIST_BUDGET_MS = 1500;

export async function getTrafficForList(
  refs: readonly { id: number; domains: string[] }[],
  now = Date.now(),
): Promise<{ available: boolean; byHost: Map<number, Traffic> }> {
  const { getTrafficByProxyHost } = await import("../analytics/db");
  const to = Math.floor(now / 1000);
  return getTrafficByProxyHost(to - 86400, to, [...refs]);
}

/** The slow inputs, each under its own budget; started by the page before the list is read. */
export async function startListInsightInputs(now = Date.now()) {
  const [{ detectTrafficSignals }, expiry, { getCrowdSecSettings }] = await Promise.all([
    import("../analytics/signals"),
    import("../certificates/expiry"),
    import("../settings"),
  ]);
  const [signals, managed, days, crowdsec] = await Promise.all([
    detectTrafficSignals({ budgetMs: LIST_BUDGET_MS, now: Math.floor(now / 1000) }).catch(
      () => null,
    ),
    expiry.managedCertificates(LIST_BUDGET_MS).catch(() => null),
    expiry.certificateTroubleDays().catch(() => expiry.DEFAULT_TROUBLE_DAYS),
    getCrowdSecSettings().catch(() => null),
  ]);
  return { signals, managed, days, crowdsec };
}

export async function listInsights(input: {
  pageHosts: readonly ProxyHost[];
  traffic: { available: boolean; byHost: ReadonlyMap<number, Traffic> };
  certificates: readonly {
    id: number;
    name: string;
    type: string;
    domainNames: string[];
    certificatePem: string | null;
  }[];
  now?: number;
  /** From `startListInsightInputs`, when the caller started it early. */
  inputs?: ReturnType<typeof startListInsightInputs>;
}): Promise<ListInsights> {
  if (!input.traffic.available) return { available: false };
  const now = input.now ?? Date.now();
  const [expiry, { signals, managed, days, crowdsec }] = await Promise.all([
    import("../certificates/expiry"),
    input.inputs ?? startListInsightInputs(now),
  ]);

  const imported = new Map(
    input.certificates.flatMap((c) => {
      const found = expiry.importedExpiry(c);
      return found ? [[c.id, found] as const] : [];
    }),
  );
  const bySignal = signalsByProxyHost(signals?.signals ?? [], input.pageHosts);
  let busiest = 0;
  let requests = 0;
  let blocked = 0;
  for (const row of input.traffic.byHost.values()) {
    busiest = Math.max(busiest, row.total);
    requests += row.total;
    blocked += row.blocked;
  }

  const byHost: Record<number, HostInsight> = {};
  for (const host of input.pageHosts) {
    const traffic = input.traffic.byHost.get(host.id) ?? { total: 0, blocked: 0, serverErrors: 0 };
    const certificate = expiry.hostCertificate(host, imported, managed, days, now);
    const problems = hostProblems({
      traffic,
      signals: bySignal.get(host.id) ?? [],
      certificateStage: certificate?.stage ?? null,
    });
    byHost[host.id] = {
      requests: traffic.total,
      blocked: traffic.blocked,
      serverErrors: traffic.serverErrors,
      share: busiest > 0 ? traffic.total / busiest : 0,
      status: hostStatus(host, problems),
      certificateDaysLeft: certificate?.daysLeft ?? null,
      protections: hostProtections(host, crowdsec?.enabled ?? false),
    };
  }
  return { available: true, totals: { requests, blocked }, byHost };
}
