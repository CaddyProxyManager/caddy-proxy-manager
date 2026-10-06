/**
 * Serializes startup across replicas: migrations and the passes that rewrite rows would otherwise
 * run twice at once. A PostgreSQL advisory lock on a connection of its own, so a replica that dies
 * holding it frees it with the connection. SQLite has one process, so nothing to wait for.
 */
import { postgresClient } from "./connection";

/** `CPM`, then which lock; lib/cluster takes the leader's under the same namespace. */
export const ADVISORY_NAMESPACE = 0x43504d;
const STARTUP_LOCK = 1;

const state = globalThis as typeof globalThis & { __cpmStartupLockHeld?: boolean };

/**
 * Resolves once held, to the release. Reentrant within the process: the passes import modules
 * whose top level takes it too, and a second session waiting on the first would deadlock.
 */
export async function acquireStartupLock(): Promise<() => Promise<void>> {
  if (!postgresClient || state.__cpmStartupLockHeld) return async () => {};
  const connection = await postgresClient.reserve();
  try {
    await connection`select pg_advisory_lock(${ADVISORY_NAMESPACE}, ${STARTUP_LOCK})`;
  } catch (error) {
    connection.release();
    throw error;
  }
  state.__cpmStartupLockHeld = true;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    state.__cpmStartupLockHeld = false;
    try {
      await connection`select pg_advisory_unlock(${ADVISORY_NAMESPACE}, ${STARTUP_LOCK})`;
    } catch {
      // A closed connection already let go of it.
    } finally {
      connection.release();
    }
  };
}
