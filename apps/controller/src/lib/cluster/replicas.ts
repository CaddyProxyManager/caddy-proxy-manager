/**
 * The running controllers, by heartbeat. A replica joining with a different SESSION_SECRET would
 * re-encrypt every stored secret and re-key the audit chain under the others, so it is refused.
 */
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { and, eq, gt, lt, ne } from "drizzle-orm";
import db from "../db";
import { postgresClient } from "../db/connection";
import { controllerReplicas } from "../db/schema";
import { derivePurposeKey } from "../secrets/derived-key";
import { cluster, REPLICA_LIVE_MS } from "./state";

/** Long past live, so a row only goes once nobody could mistake it for a running replica. */
const FORGET_AFTER_MS = 60 * 60_000;

export function keyFingerprint(): string {
  return createHash("sha256")
    .update(derivePurposeKey("cluster-fingerprint:v1"))
    .digest("hex")
    .slice(0, 16);
}

export class ReplicaKeyMismatchError extends Error {
  constructor(peers: number) {
    super(
      `${peers} running controller replica(s) use a different SESSION_SECRET. Every replica must ` +
        "share one; to rotate it, stop them all and start them again with the new secret.",
    );
    this.name = "ReplicaKeyMismatchError";
  }
}

export type LiveReplica = { id: string; hostname: string; startedAt: number; heartbeatAt: number };

export async function liveReplicas(now = Date.now()): Promise<LiveReplica[]> {
  return db
    .select({
      id: controllerReplicas.id,
      hostname: controllerReplicas.hostname,
      startedAt: controllerReplicas.startedAt,
      heartbeatAt: controllerReplicas.heartbeatAt,
    })
    .from(controllerReplicas)
    .where(gt(controllerReplicas.heartbeatAt, now - REPLICA_LIVE_MS));
}

/** Under the startup lock, so two replicas starting together cannot both miss each other. */
export async function registerReplica(now = Date.now()): Promise<void> {
  if (!postgresClient) return;
  const fingerprint = keyFingerprint();
  const peers = await db
    .select({ keyFingerprint: controllerReplicas.keyFingerprint })
    .from(controllerReplicas)
    .where(
      and(
        ne(controllerReplicas.id, cluster.replicaId),
        gt(controllerReplicas.heartbeatAt, now - REPLICA_LIVE_MS),
      ),
    );
  const mismatched = peers.filter((peer) => peer.keyFingerprint !== fingerprint).length;
  if (mismatched > 0) throw new ReplicaKeyMismatchError(mismatched);
  if (peers.length > 0) console.log(`Joining ${peers.length} running controller replica(s)`);
  cluster.peers = peers.length;

  const row = {
    id: cluster.replicaId,
    hostname: hostname(),
    keyFingerprint: fingerprint,
    startedAt: now,
    heartbeatAt: now,
  };
  await db
    .insert(controllerReplicas)
    .values(row)
    .onConflictDoUpdate({ target: controllerReplicas.id, set: { heartbeatAt: now } });
}

export async function replicaHeartbeat(now = Date.now()): Promise<void> {
  if (!postgresClient) return;
  const touched = await db
    .update(controllerReplicas)
    .set({ heartbeatAt: now })
    .where(eq(controllerReplicas.id, cluster.replicaId))
    .returning({ id: controllerReplicas.id });
  // Pruned while this process stalled: back in, without the check it passed at startup.
  if (touched.length === 0) {
    await db.insert(controllerReplicas).values({
      id: cluster.replicaId,
      hostname: hostname(),
      keyFingerprint: keyFingerprint(),
      startedAt: now,
      heartbeatAt: now,
    });
  }
  await db
    .delete(controllerReplicas)
    .where(lt(controllerReplicas.heartbeatAt, now - FORGET_AFTER_MS));
  cluster.peers = (await liveReplicas(now)).filter(
    (replica) => replica.id !== cluster.replicaId,
  ).length;
}

/**
 * From the last heartbeat, so a few seconds behind. Gates what only a lone controller may do, such
 * as configuring Caddy directly when no agent is connected.
 */
export function otherReplicasLive(): boolean {
  return postgresClient !== null && cluster.started && cluster.peers > 0;
}

export async function deregisterReplica(): Promise<void> {
  if (!postgresClient) return;
  await db.delete(controllerReplicas).where(eq(controllerReplicas.id, cluster.replicaId));
}
