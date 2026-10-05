/**
 * What an access list did to the hosts using it. The access log carries the outcome but not the
 * list, so a host whose location rules name other lists counts toward each of them. Written in the
 * ClickHouse SQL ./sqlite-store.ts translates.
 */

import type { TimeWindow } from "../analytics/explore-state";
import { queryRow, timeFilter, timeParams } from "./client";
import { hostNamesClause } from "./host-traffic";

export type AccessListTraffic = {
  /** Refused by the list's rules (or its fail-closed check). */
  stopped: number;
  /** 401s: a password that was missing or wrong. */
  failedSignIns: number;
};

export async function queryAccessListTraffic(
  window: TimeWindow,
  names: readonly string[],
): Promise<AccessListTraffic> {
  const clause = hostNamesClause(names);
  if (!clause) return { stopped: 0, failedSignIns: 0 };
  const row = await queryRow<Record<string, unknown>>(
    `
    SELECT countIf(outcome = 'access' AND status != 401) AS stopped,
           countIf(status = 401 AND (outcome = 'access' OR outcome = 'auth')) AS failed
    FROM traffic_events
    WHERE ${timeFilter()} AND ${clause.sql}
  `,
    { ...timeParams(window.from, window.to), ...clause.params },
  );
  const num = (value: unknown) => {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  return { stopped: num(row?.stopped), failedSignIns: num(row?.failed) };
}
