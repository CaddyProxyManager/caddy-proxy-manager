/**
 * Each host keeps its latest N revisions and everything younger than D days, whichever keeps more.
 * Run after each write rather than on a timer: past the count, revisions only pile up through
 * writes, and a host left alone never has more than N to prune.
 */

import { inArray, sql } from "drizzle-orm";
import db from "../db";
import { hostRevisions } from "../db/schema";
import { hostHistoryKeepDays, hostHistoryKeepRevisions } from "../settings/registry";
import { resolveSetting } from "../settings/resolve";
import type { HostKind } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Best effort: a failed prune leaves extra history, never a failed save. */
export async function pruneHostRevisions(kind: HostKind, hostIds: readonly number[]) {
  try {
    const [{ value: keep }, { value: days }] = await Promise.all([
      resolveSetting(hostHistoryKeepRevisions),
      resolveSetting(hostHistoryKeepDays),
    ]);
    const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
    const ids = [...new Set(hostIds)];
    if (ids.length === 0) return;
    // One statement for every host: a bulk save names hundreds. Past the keep-th newest and older
    // than the cutoff goes; window functions and this subquery read the same on both dialects.
    const ranked = sql`(select "id" from (select "id", "createdAt", row_number() over (partition by "hostKind", "hostId" order by "id" desc) as "rank" from "host_revisions" where "hostKind" = ${kind} and "hostId" in ${ids}) as "ranked" where "rank" > ${keep} and "createdAt" < ${cutoff})`;
    await db.delete(hostRevisions).where(inArray(hostRevisions.id, ranked));
  } catch (error) {
    console.error("Failed to prune host revisions:", error);
  }
}
