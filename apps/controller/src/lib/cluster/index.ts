/**
 * Several controllers on one PostgreSQL database. Each registers and beats a heartbeat, one leads
 * and runs the background jobs, and a write that leaves a cache stale is announced to the rest.
 * Agent streams are routed between them by lib/agent/broker.ts. Under SQLite all of it is local.
 */
import { postgresClient } from "../db/connection";
import { catchUpOnAnnouncements, listenForAnnouncements } from "./announcements";
import { listenForMessages, runSyncHooks, stopListening } from "./bus";
import { contendForLeadership, resignLeadership } from "./leader";
import { deregisterReplica, replicaHeartbeat } from "./replicas";
import { cluster, HEARTBEAT_MS } from "./state";

export { announce, onAnnouncement } from "./announcements";
export { isClusterShared, onClusterMessage, onClusterSync, sendToCluster } from "./bus";
export { isLeader, runAsLeader } from "./leader";
export {
  keyFingerprint,
  liveReplicas,
  otherReplicasLive,
  registerReplica,
  ReplicaKeyMismatchError,
} from "./replicas";

export function replicaId(): string {
  return cluster.replicaId;
}

async function beat(): Promise<void> {
  const results = await Promise.allSettled([
    replicaHeartbeat(),
    postgresClient ? catchUpOnAnnouncements() : Promise.resolve(),
    contendForLeadership(),
    postgresClient ? runSyncHooks() : Promise.resolve(),
  ]);
  for (const result of results) {
    if (result.status === "rejected") console.error("[cluster] heartbeat failed:", result.reason);
  }
}

/** After `registerReplica`, once startup has registered the leader's jobs. Idempotent. */
export async function startCluster(): Promise<void> {
  if (cluster.started) return;
  cluster.started = true;
  if (postgresClient) {
    try {
      await listenForAnnouncements(postgresClient);
      await listenForMessages(postgresClient);
    } catch (error) {
      // The heartbeat still catches up, a beat late.
      console.error("[cluster] could not listen to the other replicas:", error);
    }
  }
  await beat();
  if (!postgresClient) return;
  cluster.heartbeat = setInterval(() => void beat(), HEARTBEAT_MS);
  cluster.heartbeat.unref();
}

export async function stopCluster(): Promise<void> {
  if (cluster.heartbeat) clearInterval(cluster.heartbeat);
  cluster.heartbeat = null;
  cluster.started = false;
  await stopListening();
  await resignLeadership();
  await deregisterReplica().catch((error: unknown) => {
    console.error("[cluster] could not deregister this replica:", error);
  });
}
