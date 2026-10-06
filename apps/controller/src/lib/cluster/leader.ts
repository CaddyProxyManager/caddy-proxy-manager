/**
 * One replica runs the background jobs: whoever holds a PostgreSQL advisory lock on a reserved
 * connection. The lock dies with that connection, so a crashed leader frees it for the next try
 * without a lease to wait out. Under SQLite there is only this process, which always leads.
 */
import type { ReservedSQL } from "bun";
import { postgresClient } from "../db/connection";
import { ADVISORY_NAMESPACE } from "../db/startup-lock";
import { cluster, type LeaderJob } from "./state";

const LEADER_LOCK = 2;

const global = globalThis as typeof globalThis & { __cpmLeaderConnection?: ReservedSQL | null };

function startJob(job: LeaderJob): void {
  try {
    job.start();
  } catch (error) {
    console.error(`[cluster] could not start ${job.name}:`, error);
  }
}

function stopJob(job: LeaderJob): void {
  try {
    job.stop();
  } catch (error) {
    console.error(`[cluster] could not stop ${job.name}:`, error);
  }
}

/** Started now when this replica leads, else when it takes over. */
export function runAsLeader(job: LeaderJob): void {
  const existing = cluster.jobs.findIndex((other) => other.name === job.name);
  if (existing !== -1) {
    if (cluster.leader) stopJob(cluster.jobs[existing]);
    cluster.jobs.splice(existing, 1);
  }
  cluster.jobs.push(job);
  if (cluster.leader) startJob(job);
}

export function isLeader(): boolean {
  return cluster.leader;
}

function lead(leader: boolean): void {
  if (cluster.leader === leader) return;
  cluster.leader = leader;
  for (const job of cluster.jobs) (leader ? startJob : stopJob)(job);
  if (postgresClient) {
    console.log(
      leader
        ? "This replica now runs the background jobs"
        : "This replica no longer runs the background jobs",
    );
  }
}

function dropConnection(): void {
  const connection = global.__cpmLeaderConnection;
  global.__cpmLeaderConnection = null;
  try {
    connection?.release();
  } catch {
    // Already closed.
  }
}

/** A heartbeat: take the lock if free, or check the connection holding it is still alive. */
export async function contendForLeadership(): Promise<void> {
  if (!postgresClient) {
    lead(true);
    return;
  }
  if (cluster.leader) {
    try {
      const connection = global.__cpmLeaderConnection;
      if (!connection) throw new Error("no connection holds the lock");
      await connection`select 1`;
    } catch {
      // Stopped first: by now another replica may hold the lock.
      lead(false);
      dropConnection();
    }
    return;
  }
  try {
    const connection = await postgresClient.reserve();
    global.__cpmLeaderConnection = connection;
    const [row] =
      await connection`select pg_try_advisory_lock(${ADVISORY_NAMESPACE}, ${LEADER_LOCK}) as held`;
    if (row?.held === true) lead(true);
    else dropConnection();
  } catch (error) {
    dropConnection();
    console.error("[cluster] could not contend for the background jobs:", error);
  }
}

export async function resignLeadership(): Promise<void> {
  const connection = global.__cpmLeaderConnection;
  lead(false);
  if (!connection) return;
  try {
    await connection`select pg_advisory_unlock(${ADVISORY_NAMESPACE}, ${LEADER_LOCK})`;
  } catch {
    // A closed connection already let go of it.
  }
  dropConnection();
}
