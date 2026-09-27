/**
 * Edited-but-unapplied settings. Nothing here pushes to Caddy; ./apply.ts moves rows into
 * `settings` and reloads once. Same keys and values as `settings`, so rows substitute directly.
 */

import db, { nowIso } from "../db";
import { settings, settingsStaged } from "../db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { getSetting } from "../settings";
import { withStagedReads } from "./staging-context";

export type StagedEntry = {
  key: string;
  /** Serialized JSON, as stored. */
  value: string;
  stagedAt: string;
};

/** Oldest first. */
export async function listStagedSettings(userId: number): Promise<StagedEntry[]> {
  const rows = await db
    .select({
      key: settingsStaged.key,
      value: settingsStaged.value,
      stagedAt: settingsStaged.stagedAt,
    })
    .from(settingsStaged)
    .where(eq(settingsStaged.userId, userId));

  return rows.sort((a, b) => a.stagedAt.localeCompare(b.stagedAt));
}

export async function stagedOverlay(userId: number): Promise<Map<string, string>> {
  const entries = await listStagedSettings(userId);
  return new Map(entries.map((entry) => [entry.key, entry.value]));
}

export async function countStagedSettings(userId: number): Promise<number> {
  return (await listStagedSettings(userId)).length;
}

/** A write matching the stored value is *unstaged*, so an edit put back leaves nothing pending. */
export async function stageWrites(userId: number, writes: Map<string, string>): Promise<void> {
  if (writes.size === 0) return;
  const now = nowIso();
  const stored = await storedValues([...writes.keys()]);

  for (const [key, value] of writes) {
    if (stored.get(key) === value) {
      await discardStagedKey(userId, key);
      continue;
    }

    await db
      .insert(settingsStaged)
      .values({ key, userId, value, stagedAt: now })
      .onConflictDoUpdate({
        target: [settingsStaged.userId, settingsStaged.key],
        set: { value, stagedAt: now },
      });
  }
}

export async function discardStagedKey(userId: number, key: string): Promise<void> {
  await db
    .delete(settingsStaged)
    .where(and(eq(settingsStaged.userId, userId), eq(settingsStaged.key, key)));
}

export async function discardAllStaged(userId: number): Promise<void> {
  await db.delete(settingsStaged).where(eq(settingsStaged.userId, userId));
}

/** Raw rows, not `getSetting`: a parse and re-serialize could differ by key order alone. */
export async function storedValues(keys: string[]): Promise<Map<string, string>> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, keys));
  return new Map(rows.map((row) => [row.key, row.value]));
}

/** As it would be after applying this operator's staged set. */
export async function getStagedSetting<T>(userId: number, key: string): Promise<T | null> {
  const overlay = await stagedOverlay(userId);
  return withStagedReads(overlay, () => getSetting<T>(key));
}
