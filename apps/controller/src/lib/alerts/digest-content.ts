/**
 * What a daily digest reports on, for the 24 hours before it is sent. Each section is read on its
 * own under a budget and comes back null when it could not be, so a slow ClickHouse or a broken
 * provider leaves a gap rather than no digest. Without analytics the traffic sections are null.
 */

import { and, desc, gte, lt, sql } from "drizzle-orm";
import db from "../db";
import { auditEvents } from "../db/schema";
import { systemAccess } from "../users/permissions";

export const DIGEST_WINDOW_MS = 24 * 60 * 60_000;
/** Countries and networks count as new against this much history before the window. */
export const NEW_AGAINST_DAYS = 30;
export const CERTIFICATE_DAYS = 14;
const TOP = 5;
const SECTION_BUDGET_MS = 8_000;

export type DigestTraffic = {
  requests: number;
  mitigated: number;
  outcomes: { outcome: string; count: number }[];
  hosts: { host: string; count: number }[];
  paths: { host: string; path: string; count: number }[];
  rules: { ruleId: number; message: string | null; count: number }[];
  newCountries: string[];
  newAsns: { asn: number; org: string }[];
};

export type DigestData = {
  /** Epoch ms. */
  from: number;
  to: number;
  /** Null without analytics, or when ClickHouse did not answer in time. */
  traffic: DigestTraffic | null;
  analyticsOn: boolean;
  certificates: { name: string; days: number; expired: boolean }[] | null;
  changes: {
    total: number;
    recent: { action: string; entityType: string; summary: string | null; at: string }[];
  } | null;
  backups: { name: string; status: string | null; at: string | null }[] | null;
  attention: {
    total: number;
    items: { code: string; severity: string; values: Record<string, string | number> }[];
  } | null;
};

async function within<T>(what: string, work: () => Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SECTION_BUDGET_MS);
  });
  try {
    return await Promise.race([work(), deadline]);
  } catch (error) {
    console.warn(`[alerts] the digest's ${what} could not be read:`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function traffic(from: number, to: number): Promise<DigestTraffic> {
  const { queryRows, timeFilter, timeParams } = await import("../clickhouse/client");
  const { PATH_SQL } = await import("../clickhouse/explore");
  const params = timeParams(Math.floor(from / 1000), Math.floor(to / 1000));
  const since = Math.floor((from - NEW_AGAINST_DAYS * 86_400_000) / 1000);
  const [totals, outcomes, hosts, paths, rules, countries, asns] = await Promise.all([
    queryRows<Record<string, unknown>>(
      `SELECT count() AS requests, countIf(outcome != 'served') AS mitigated
       FROM traffic_events WHERE ${timeFilter()}`,
      params,
    ),
    queryRows<Record<string, unknown>>(
      `SELECT outcome, count() AS n FROM traffic_events
       WHERE ${timeFilter()} AND outcome != 'served' GROUP BY outcome ORDER BY n DESC`,
      params,
    ),
    queryRows<Record<string, unknown>>(
      `SELECT host, count() AS n FROM traffic_events
       WHERE ${timeFilter()} AND outcome != 'served' AND host != ''
       GROUP BY host ORDER BY n DESC LIMIT ${TOP}`,
      params,
    ),
    queryRows<Record<string, unknown>>(
      `SELECT host, ${PATH_SQL} AS path, count() AS n FROM traffic_events
       WHERE ${timeFilter()} AND outcome != 'served'
       GROUP BY host, path ORDER BY n DESC LIMIT ${TOP}`,
      params,
    ),
    queryRows<Record<string, unknown>>(
      `SELECT rule_id, any(rule_message) AS message, count() AS n FROM waf_events
       WHERE ${timeFilter()} AND rule_id IS NOT NULL
       GROUP BY rule_id ORDER BY n DESC LIMIT ${TOP}`,
      params,
    ),
    queryRows<Record<string, unknown>>(
      `SELECT country_code AS country FROM traffic_events
       WHERE ${timeFilter()} AND country_code IS NOT NULL AND country_code != ''
       GROUP BY country
       HAVING country NOT IN (
         SELECT DISTINCT country_code FROM traffic_events
         WHERE ts >= toDateTime({p_since:UInt32}) AND ts < toDateTime({p_from:UInt32})
           AND country_code IS NOT NULL
       )
       ORDER BY count() DESC LIMIT 20`,
      { ...params, p_since: since },
    ),
    queryRows<Record<string, unknown>>(
      `SELECT asn, any(asn_org) AS org FROM traffic_events
       WHERE ${timeFilter()} AND asn != 0
       GROUP BY asn
       HAVING asn NOT IN (
         SELECT DISTINCT asn FROM traffic_events
         WHERE ts >= toDateTime({p_since:UInt32}) AND ts < toDateTime({p_from:UInt32})
       )
       ORDER BY count() DESC LIMIT 20`,
      { ...params, p_since: since },
    ),
  ]);
  return {
    requests: Number(totals[0]?.requests ?? 0),
    mitigated: Number(totals[0]?.mitigated ?? 0),
    outcomes: outcomes.map((row) => ({ outcome: String(row.outcome), count: Number(row.n) })),
    hosts: hosts.map((row) => ({ host: String(row.host), count: Number(row.n) })),
    paths: paths.map((row) => ({
      host: String(row.host),
      path: String(row.path),
      count: Number(row.n),
    })),
    rules: rules.map((row) => ({
      ruleId: Number(row.rule_id),
      message: row.message === null || row.message === undefined ? null : String(row.message),
      count: Number(row.n),
    })),
    newCountries: countries.map((row) => String(row.country)),
    newAsns: asns.map((row) => ({ asn: Number(row.asn), org: String(row.org ?? "") })),
  };
}

async function changes(from: number, to: number): Promise<NonNullable<DigestData["changes"]>> {
  const range = and(
    gte(auditEvents.createdAt, new Date(from).toISOString()),
    lt(auditEvents.createdAt, new Date(to).toISOString()),
  );
  const [count] = await db.select({ n: sql<number>`count(*)` }).from(auditEvents).where(range);
  const recent = await db
    .select({
      action: auditEvents.action,
      entityType: auditEvents.entityType,
      summary: auditEvents.summary,
      at: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(range)
    .orderBy(desc(auditEvents.createdAt))
    .limit(10);
  return { total: Number(count?.n ?? 0), recent };
}

async function backups(): Promise<NonNullable<DigestData["backups"]>> {
  const [{ listEnabledSchedules }, { latestRuns }] = await Promise.all([
    import("../backup/schedules"),
    import("../backup/runs"),
  ]);
  const schedules = await listEnabledSchedules();
  const runs = await latestRuns(schedules.map((schedule) => schedule.id));
  return schedules.map((schedule) => {
    const last = runs.get(schedule.id)?.last ?? null;
    return {
      name: schedule.name,
      status: last?.status ?? null,
      at: last?.finishedAt ?? last?.startedAt ?? null,
    };
  });
}

/** Everything a digest says, as of `now`. */
export async function collectDigest(now: number): Promise<DigestData> {
  const from = now - DIGEST_WINDOW_MS;
  const { isAnalyticsEnabled } = await import("../clickhouse/client");
  const analyticsOn = await isAnalyticsEnabled().catch(() => false);
  const { collectAttention } = await import("../attention");
  const [trafficData, attention, changed, backed] = await Promise.all([
    analyticsOn ? within("traffic", () => traffic(from, now)) : Promise.resolve(null),
    within("Needs attention", () => collectAttention(systemAccess(), { now })),
    within("changes", () => changes(from, now)),
    within("backups", backups),
  ]);
  return {
    from,
    to: now,
    analyticsOn,
    traffic: trafficData,
    certificates: attention
      ? attention.items.flatMap((item) => {
          if (item.code !== "certificateExpiring" && item.code !== "certificateExpired") return [];
          const days = Number(item.values.days ?? 0);
          return days <= CERTIFICATE_DAYS
            ? [
                {
                  name: String(item.values.name),
                  days,
                  expired: item.code === "certificateExpired",
                },
              ]
            : [];
        })
      : null,
    changes: changed,
    backups: backed,
    attention: attention
      ? {
          total: attention.items.length + attention.truncated,
          items: attention.items
            .slice(0, 10)
            .map((item) => ({ code: item.code, severity: item.severity, values: item.values })),
        }
      : null,
  };
}
