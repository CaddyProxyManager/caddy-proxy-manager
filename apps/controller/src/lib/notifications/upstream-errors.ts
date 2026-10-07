/**
 * Proxy hosts answering 502/503/504, counted from what agents relay out of the access log
 * (`upstream-errors`), analytics or not. Counted per proxy host and minute in the database, since
 * an agent reports to whichever replica it reaches and the leader judges recovery.
 */

import { UPSTREAM_ERROR_STATUSES, type UpstreamErrorRow } from "@cpm/shared";
import { and, eq, gt, lte, sql, sum } from "drizzle-orm";
import db from "../db";
import { upstreamErrorCounts } from "../db/schema";
import { hostMatchesPattern } from "../proxy-hosts/pattern-priority";
import {
  notificationCategoryEnabled,
  openProblemKeys,
  raiseProblem,
  resolveProblem,
} from "./index";

const PREFIX = "upstream:";
const MINUTE_MS = 60_000;

type Host = { id: number; domains: string[] };
let hostCache: { at: number; hosts: Host[] } | null = null;
const HOST_CACHE_MS = 60_000;

/** Test seam. */
export function resetUpstreamErrorsForTests(): void {
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

/** Errors from minutes reaching into the window. */
async function total(proxyHostId: number, since: number): Promise<number> {
  const [row] = await db
    .select({ errors: sum(upstreamErrorCounts.count) })
    .from(upstreamErrorCounts)
    .where(
      and(
        eq(upstreamErrorCounts.proxyHostId, proxyHostId),
        gt(upstreamErrorCounts.minute, since - MINUTE_MS),
      ),
    );
  return Number(row?.errors ?? 0);
}

/** From `agentAnalytics`: counts them, and raises each host now at the threshold. */
export async function recordUpstreamErrors(
  rows: readonly UpstreamErrorRow[],
  now = Date.now(),
): Promise<void> {
  if (rows.length === 0 || !(await notificationCategoryEnabled("upstreamErrors"))) return;
  const { count: threshold, windowMs } = await limits();
  const since = now - windowMs;
  const hosts = await proxyHosts(now);
  const touched = new Map<number, string>();
  for (const row of rows) {
    const minute = row.minute * 1000;
    // An agent's backlog after an outage can hold hours of minutes; only the window matters.
    if (minute + MINUTE_MS <= since || minute > now + MINUTE_MS) continue;
    // Only hosts that exist, which bounds the rows whatever an agent reports.
    const host = matchHost(hosts, row.host);
    if (!host) continue;
    await db
      .insert(upstreamErrorCounts)
      .values({ proxyHostId: host.id, minute, count: row.count })
      .onConflictDoUpdate({
        target: [upstreamErrorCounts.proxyHostId, upstreamErrorCounts.minute],
        set: { count: sql`${upstreamErrorCounts.count} + ${row.count}` },
      });
    touched.set(host.id, row.host.toLowerCase().replace(/:\d+$/, ""));
  }
  const minutes = windowMs / MINUTE_MS;
  for (const [id, host] of touched) {
    const count = await total(id, since);
    if (count >= threshold) {
      await raiseProblem(`${PREFIX}${id}`, { kind: "upstreamErrors", host, count, minutes }, now);
    }
  }
}

/** A tick, on the leader: a host with no error for a whole window has recovered. */
export async function watchUpstreamErrors(now: number): Promise<void> {
  const { windowMs } = await limits();
  await db
    .delete(upstreamErrorCounts)
    .where(lte(upstreamErrorCounts.minute, now - windowMs - MINUTE_MS));
  const open = await openProblemKeys(PREFIX);
  for (const key of open) {
    const id = Number(key.slice(PREFIX.length));
    if ((await total(id, now - windowMs)) > 0) continue;
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
  const { isDemoMode } = await import("../demo/mode");
  if (isDemoMode()) return false;
  const { eventKindDeliverable } = await import("./index");
  return eventKindDeliverable("upstreamErrors", "upstreamErrors");
}
