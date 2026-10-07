/**
 * Each host keeps its latest N revisions and everything younger than D days, whichever keeps more.
 * Run after each write rather than on a timer: past the count, revisions only pile up through
 * writes, and a host left alone never has more than N to prune.
 */

import { and, desc, eq, lt } from "drizzle-orm";
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
    for (const hostId of new Set(hostIds)) {
      const host = and(eq(hostRevisions.hostKind, kind), eq(hostRevisions.hostId, hostId));
      // The keep-th newest; nothing older than it and the cutoff both survives.
      const [boundary] = await db
        .select({ id: hostRevisions.id })
        .from(hostRevisions)
        .where(host)
        .orderBy(desc(hostRevisions.id))
        .limit(1)
        .offset(keep - 1);
      if (!boundary) continue;
      await db
        .delete(hostRevisions)
        .where(and(host, lt(hostRevisions.id, boundary.id), lt(hostRevisions.createdAt, cutoff)));
    }
  } catch (error) {
    console.error("Failed to prune host revisions:", error);
  }
}
