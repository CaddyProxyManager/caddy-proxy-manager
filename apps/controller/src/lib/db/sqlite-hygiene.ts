/**
 * What a SQLite file leaks that PostgreSQL keeps behind its server: the file itself, readable by
 * whoever the umask let in, and the old bytes of deleted or replaced rows, left in free pages.
 */
import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, statSync } from "node:fs";

/**
 * Drops world access from the database and its journals: it holds password hashes, session tokens
 * and encrypted secrets. Group bits stay, since the agent reads this volume through the group. A
 * no-op on Windows, where chmod only toggles read-only.
 */
export function restrictDatabaseFileModes(path: string): void {
  if (path === ":memory:") return;
  for (const file of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
    try {
      if (!existsSync(file)) continue;
      const mode = statSync(file).mode & 0o7777;
      if (mode & 0o007) chmodSync(file, mode & ~0o007);
    } catch (error) {
      console.warn(
        `Could not restrict permissions on ${file}:`,
        (error as NodeJS.ErrnoException).code ?? error,
      );
    }
  }
}

/** PRAGMA user_version once vacuumed with secure_delete on. Nothing else here uses user_version. */
const VACUUMED_VERSION = 1;

/**
 * VACUUM rebuilds the file without what secure_delete cannot reach: content deleted or replaced
 * before it was on. Once per database, and again whenever `force` says a startup pass rewrote
 * secrets. Returns whether it ran; a failure (it needs room for a copy) leaves the file as it was.
 */
export function vacuumDeletedContent(database: Database, force = false): boolean {
  try {
    const row = database.query("PRAGMA user_version").get() as { user_version?: number } | null;
    const version = row?.user_version ?? 0;
    if (!force && version >= VACUUMED_VERSION) return false;
    database.run("VACUUM");
    if (version < VACUUMED_VERSION) database.run(`PRAGMA user_version = ${VACUUMED_VERSION}`);
    // Until checkpointed, the WAL still holds pages VACUUM replaced.
    database.run("PRAGMA wal_checkpoint(TRUNCATE)");
    return true;
  } catch (error) {
    console.error(
      "Failed to VACUUM the database; deleted content may remain in its free pages:",
      error,
    );
    return false;
  }
}
