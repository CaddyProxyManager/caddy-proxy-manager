/**
 * Proxy hosts answering 502/503/504, counted from what agents relay out of the access log
 * (`upstream-errors`), analytics or not. Kept in memory per proxy host and minute; a restart
 * starts the count over, and waits a whole window before calling anything recovered.
 */

import { UPSTREAM_ERROR_STATUSES, type UpstreamErrorRow } from "@cpm/shared";
import db from "../db";
import { hostMatchesPattern } from "../host-pattern-priority";
import {
  notificationCategoryEnabled,
  openProblemKeys,
  raiseProblem,
  resolveProblem,
} from "./index";

const PREFIX = "upstream:";
const MINUTE_MS = 60_000;
/** Bounds the counts whatever an agent reports. */
const MAX_HOSTS = 10_000;

/** Errors per proxy host id, per minute (ms). */
const buckets = new Map<number, Map<number, number>>();
let watchingSince: number | null = null;

type Host = { id: number; domains: string[] };
let hostCache: { at: number; hosts: Host[] } | null = null;
const HOST_CACHE_MS = 60_000;

/** Test seam. */
export function resetUpstreamErrorsForTests(): void {
  buckets.clear();
  watchingSince = null;
  hostCache = null;
}

async function proxyHosts(now: number): Promise<Host[]> {
  if (hostCache && now - hostCache.at < HOST_CACHE_MS) return hostCache.hosts;
  const rows = await db.query.proxyHosts.findMany({ columns: { id: true, domains: true } });
  const hosts = rows.flatMap((row) => {
    try {
      const domains = (JSON.parse(row.domains) as string[]).map((domain) => domain.toLowerCase());
      return [{ id: row.id, domains }];
    } catch {
      return [];
    }
  });
  hostCache = { at: now, hosts };
  return hosts;
}

/**
 * The proxy host a logged Host header reached, exact before wildcard as Caddy routes it. An
 * agent is less trusted: a name no host has is dropped rather than put in an email.
 */
function matchHost(hosts: readonly Host[], requestHost: string): Host | null {
  const name = requestHost.toLowerCase().replace(/:\d+$/, "");
  if (!name) return null;
  const exact = hosts.find((host) => host.domains.includes(name));
  if (exact) return exact;
  return (
    hosts.find((host) => host.domains.some((domain) => hostMatchesPattern(name, domain))) ?? null
  );
}

async function limits(): Promise<{ count: number; windowMs: number }> {
  const [registry, { getSetting }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);
  const [count, minutes] = await Promise.all([
    getSetting(registry.notifyUpstreamErrorCount),
    getSetting(registry.notifyUpstreamErrorMinutes),
  ]);
  return { count, windowMs: minutes * MINUTE_MS };
}

/** Within the window; prunes what fell out of it. */
function total(perMinute: Map<number, number>, since: number): number {
  let sum = 0;
  for (const [minute, count] of perMinute) {
    if (minute + MINUTE_MS <= since) perMinute.delete(minute);
    else sum += count;
  }
  return sum;
}

/** From `agentAnalytics`: counts them, and raises each host now at the threshold. */
export async function recordUpstreamErrors(
  rows: readonly UpstreamErrorRow[],
  now = Date.now(),
): Promise<void> {
  watchingSince ??= now;
  if (rows.length === 0 || !(await notificationCategoryEnabled("upstreamErrors"))) return;
  const { count: threshold, windowMs } = await limits();
  const since = now - windowMs;
  const hosts = await proxyHosts(now);
  const touched = new Map<number, string>();
  for (const row of rows) {
    const minute = row.minute * 1000;
    // An agent's backlog after an outage can hold hours of minutes; only the window matters.
    if (minute + MINUTE_MS <= since || minute > now + MINUTE_MS) continue;
    const host = matchHost(hosts, row.host);
    if (!host) continue;
    let perMinute = buckets.get(host.id);
    if (!perMinute) {
      if (buckets.size >= MAX_HOSTS) continue;
      perMinute = new Map();
      buckets.set(host.id, perMinute);
    }
    perMinute.set(minute, (perMinute.get(minute) ?? 0) + row.count);
    touched.set(host.id, row.host.toLowerCase().replace(/:\d+$/, ""));
  }
  const minutes = windowMs / MINUTE_MS;
  for (const [id, host] of touched) {
    const count = total(buckets.get(id) ?? new Map(), since);
    if (count >= threshold) {
      await raiseProblem(`${PREFIX}${id}`, { kind: "upstreamErrors", host, count, minutes }, now);
    }
  }
}

/** A tick: a host with no error for a whole window has recovered. */
export async function watchUpstreamErrors(now: number): Promise<void> {
  watchingSince ??= now;
  const open = await openProblemKeys(PREFIX);
  if (open.length === 0) return;
  const { windowMs } = await limits();
  // After a restart the counts are gone; quiet means a whole window of them.
  if (now - watchingSince < windowMs) return;
  for (const key of open) {
    const id = Number(key.slice(PREFIX.length));
    const perMinute = buckets.get(id);
    if (perMinute && total(perMinute, now - windowMs) > 0) continue;
    buckets.delete(id);
    await resolveProblem(
      key,
      (raised) =>
        raised?.kind === "upstreamErrors" ? { kind: "upstreamRecovered", host: raised.host } : null,
      now,
    );
  }
}

function isWhole(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Field by field, as the other analytics rows: an agent is less trusted. */
export function parseUpstreamErrorRow(value: unknown): UpstreamErrorRow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !isWhole(row.minute, 0, 4_294_967_295) ||
    typeof row.host !== "string" ||
    row.host.length > 1024 ||
    !isWhole(row.status, 0, 999) ||
    !(UPSTREAM_ERROR_STATUSES as readonly number[]).includes(row.status) ||
    !isWhole(row.count, 1, 10_000_000)
  ) {
    return null;
  }
  return { minute: row.minute, host: row.host, status: row.status, count: row.count };
}

/** What the agents are told: counting costs a parse of the access log, so only when wanted. */
export async function upstreamErrorsWanted(): Promise<boolean> {
  const [{ emailReady }, { isDemoMode }] = await Promise.all([
    import("../email/config"),
    import("../demo-mode"),
  ]);
  if (isDemoMode()) return false;
  return (await notificationCategoryEnabled("upstreamErrors")) && (await emailReady());
}
