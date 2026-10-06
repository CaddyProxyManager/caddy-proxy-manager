/**
 * SQLite runs one controller. Two processes on one file would each run the background jobs, and
 * nothing in the database tells them apart. The second is refused by an exclusive lock on a file
 * beside the database, which the OS drops with the process that held it, crash or not.
 */
import { Database } from "bun:sqlite";
import { target } from "./connection";

export class SqliteInUseError extends Error {
  constructor(path: string) {
    super(
      `Another controller is running on ${path}. SQLite runs one controller; move to PostgreSQL ` +
        "to run several.",
    );
    this.name = "SqliteInUseError";
  }
}

/** Held open for the life of the process; closing it is how a test lets go. */
export function lockDatabaseFile(path: string): Database {
  const lock = new Database(`${path}.controller-lock`, { create: true });
  try {
    lock.run("PRAGMA busy_timeout = 0");
    // Kept after the first write, until the connection closes; the open transaction holds it.
    lock.run("PRAGMA locking_mode = EXCLUSIVE");
    lock.run("BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    const code = (error as { code?: unknown }).code;
    if (code === "SQLITE_BUSY" || /locked/i.test(String(error))) throw new SqliteInUseError(path);
    throw error;
  }
  return lock;
}

// On globalThis: a dev program reload runs register() again in the same process.
const state = globalThis as typeof globalThis & { __cpmSqliteLock?: Database };

export function claimSqliteDatabase(): void {
  if (target.kind !== "sqlite" || target.path === ":memory:" || state.__cpmSqliteLock) return;
  state.__cpmSqliteLock = lockDatabaseFile(target.path);
}
