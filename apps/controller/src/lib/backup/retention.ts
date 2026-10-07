/**
 * Which old backups a schedule may delete. Only its own: files named as a run names them, directly
 * under its prefix. Anything else in the bucket, a nested folder included, is never touched.
 */
import type { BackupStore, StoredObject } from "./storage";

const BACKUP_NAME = /^cpm-backup-[A-Za-z0-9._-]+\.cpmbak$/;
const STAMP = /^cpm-backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/;

export type RetentionPolicy = { keepLast: number | null; keepDays: number | null };

/** `cpm-backup-2026-10-06-02-00-00.cpmbak`, the slot in UTC; `-manual` marks a run on request. */
export function backupObjectName(slot: number, manual = false): string {
  const stamp = new Date(slot).toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `cpm-backup-${stamp}${manual ? "-manual" : ""}.cpmbak`;
}

/** A run's own backups under `prefix`: the name it would have written, one level deep. */
export function isScheduleBackup(key: string, prefix: string): boolean {
  if (!key.startsWith(prefix)) return false;
  return BACKUP_NAME.test(key.slice(prefix.length));
}

/** When a backup was made: the stamp in its name, else when the store last saw it written. */
export function backupTime(object: StoredObject, prefix: string): number {
  const match = STAMP.exec(object.key.slice(prefix.length));
  if (match) {
    const [, y, mo, d, h, mi, s] = match;
    return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  }
  return object.lastModified ? Date.parse(object.lastModified) : 0;
}

/**
 * The keys to delete: kept if among the newest `keepLast` or younger than `keepDays`, whichever
 * keeps more. With neither set, nothing goes.
 */
export function expiredBackups(
  objects: readonly StoredObject[],
  prefix: string,
  policy: RetentionPolicy,
  now = Date.now(),
): string[] {
  if (policy.keepLast === null && policy.keepDays === null) return [];
  const own = objects
    .filter((object) => isScheduleBackup(object.key, prefix))
    .map((object) => ({ key: object.key, at: backupTime(object, prefix) }))
    .sort((a, b) => b.at - a.at || b.key.localeCompare(a.key));
  const cutoff = policy.keepDays === null ? null : now - policy.keepDays * 86_400_000;
  return own
    .filter((object, index) => {
      if (policy.keepLast !== null && index < policy.keepLast) return false;
      if (cutoff !== null && object.at >= cutoff) return false;
      return true;
    })
    .map((object) => object.key);
}

export async function applyRetention(
  store: BackupStore,
  prefix: string,
  policy: RetentionPolicy,
  now = Date.now(),
): Promise<string[]> {
  if (policy.keepLast === null && policy.keepDays === null) return [];
  const expired = expiredBackups(await store.list(prefix), prefix, policy, now);
  for (const key of expired) await store.delete(key);
  return expired;
}
