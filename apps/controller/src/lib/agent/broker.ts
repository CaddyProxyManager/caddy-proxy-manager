/**
 * Reaches an agent whose stream another replica holds. `agent_connections` says who holds each,
 * and every replica mirrors it in memory, so the registry keeps answering synchronously. What has
 * to cross goes in a table - events in `agent_outbox`, results in `agent_command_results` - with
 * a NOTIFY to read it now and a heartbeat sync for a NOTIFY that went missing.
 */
import { randomUUID } from "node:crypto";
import type { AgentServerEvent, AgentStatus } from "@cpm/shared";
import { and, eq, gt, inArray, lt, ne, notInArray } from "drizzle-orm";
import { isClusterShared, onClusterMessage, onClusterSync, sendToCluster } from "../cluster/bus";
import { cluster, REPLICA_LIVE_MS } from "../cluster/state";
import db from "../db";
import {
  agentCommandResults,
  agentConnections,
  agentOutbox,
  controllerReplicas,
} from "../db/schema";
import {
  AgentNotConnectedError,
  type Connection,
  failWaiters,
  type RemoteConnection,
  registry,
  settleWaiter,
  type ForwardedResult,
} from "./registry-state";

/** An event or result whose replica never took it; by then its waiter has long timed out. */
const STALE_MS = 5 * 60_000;

type Hooks = {
  /** Drops this process's stream without touching another replica's row. */
  detachLocal: (agentId: string) => void;
  /** Re-checks this process's streams against the agents table. */
  reconcile: () => Promise<void>;
};

let hooks: Hooks = { detachLocal: () => {}, reconcile: async () => {} };

/** Called once by the registry, which owns what these do. */
export function bindRegistry(registryHooks: Hooks): void {
  hooks = registryHooks;
}

const me = () => cluster.replicaId;

type Row = typeof agentConnections.$inferSelect;

function parseStatus(raw: string | null): AgentStatus | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AgentStatus;
  } catch {
    return null;
  }
}

function toRemote(row: Row): RemoteConnection {
  return {
    agentId: row.agentId,
    name: row.name,
    agentRowId: row.agentRowId,
    credential: row.credential ?? undefined,
    replicaId: row.replicaId,
    connectedAt: row.connectedAt,
    status: parseStatus(row.status),
    lastSeenAt: row.lastSeenAt,
  };
}

/** The replica that issued a command, from its id: `<agentId>:<replicaId>:<uuid>`. */
export function originOf(commandId: string): string | null {
  const parts = commandId.split(":");
  return parts.length >= 3 ? parts[parts.length - 2] : null;
}

async function liveReplicaIds(now: number): Promise<Set<string>> {
  const rows = await db
    .select({ id: controllerReplicas.id })
    .from(controllerReplicas)
    .where(gt(controllerReplicas.heartbeatAt, now - REPLICA_LIVE_MS));
  const live = new Set(rows.map((row) => row.id));
  live.add(me());
  return live;
}

async function readRow(agentId: string): Promise<Row | undefined> {
  const [row] = await db
    .select()
    .from(agentConnections)
    .where(eq(agentConnections.agentId, agentId))
    .limit(1);
  return row;
}

function rowFor(connection: Connection, now: number) {
  return {
    agentId: connection.agentId,
    replicaId: me(),
    agentRowId: connection.agentRowId,
    name: connection.name,
    credential: connection.credential ?? null,
    connectedAt: connection.connectedAt,
    lastSeenAt: now,
    status: connection.status ? JSON.stringify(connection.status) : null,
  };
}

// ─── This replica's streams ──────────────────────────────────────────────────

/** Last writer wins; the replica whose stream lost hears of it and closes its own. */
export async function claimStream(connection: Connection, now = Date.now()): Promise<void> {
  if (!isClusterShared()) return;
  const row = rowFor(connection, now);
  await db
    .insert(agentConnections)
    .values(row)
    .onConflictDoUpdate({ target: agentConnections.agentId, set: row });
  registry.remote.delete(connection.agentId);
  sendToCluster("agent-attached", { agentId: connection.agentId });
}

/** Only this replica's row: a stream displaced by another replica's leaves that one standing. */
export async function releaseStream(agentId: string): Promise<void> {
  if (!isClusterShared()) return;
  const deleted = await db
    .delete(agentConnections)
    .where(and(eq(agentConnections.agentId, agentId), eq(agentConnections.replicaId, me())))
    .returning({ agentId: agentConnections.agentId });
  if (deleted.length > 0) sendToCluster("agent-detached", { agentId });
}

/**
 * Whichever replica the status mutation reached: the row is the one copy all of them read, and
 * the previous status is read from it rather than a mirror that may be a moment behind.
 */
export async function storeStatus(
  agentId: string,
  status: AgentStatus,
  now = Date.now(),
): Promise<{ previous: AgentStatus | null } | null> {
  if (!isClusterShared()) return null;
  const row = await readRow(agentId);
  if (!row) return null;
  await db
    .update(agentConnections)
    .set({ status: JSON.stringify(status), lastSeenAt: now })
    .where(eq(agentConnections.agentId, agentId));
  const remote = registry.remote.get(agentId);
  if (remote) {
    remote.status = status;
    remote.lastSeenAt = now;
  }
  sendToCluster("agent-status", { agentId });
  return { previous: parseStatus(row.status) };
}

/** Whether a stream for it is open anywhere, asking the database when the mirror does not know. */
export async function isHeldAnywhere(agentId: string, now = Date.now()): Promise<boolean> {
  if (registry.connections.has(agentId) || registry.remote.has(agentId)) return true;
  if (!isClusterShared()) return false;
  const row = await readRow(agentId);
  if (!row || row.replicaId === me()) return false;
  if (!(await liveReplicaIds(now)).has(row.replicaId)) return false;
  registry.remote.set(agentId, toRemote(row));
  return true;
}

// ─── Across ──────────────────────────────────────────────────────────────────

/** To the replica holding the stream; it sends it down as if it had built it. */
export async function forwardEvent(
  remote: RemoteConnection,
  event: AgentServerEvent,
  now = Date.now(),
): Promise<void> {
  await db.insert(agentOutbox).values({
    id: randomUUID(),
    replicaId: remote.replicaId,
    agentId: remote.agentId,
    event: JSON.stringify(event),
    createdAt: now,
  });
  sendToCluster("agent-outbox", undefined, remote.replicaId);
}

/** A result the agent sent here, for the replica waiting on it. */
export async function forwardResult(
  origin: string,
  result: ForwardedResult,
  now = Date.now(),
): Promise<void> {
  await db
    .insert(agentCommandResults)
    .values({
      commandId: result.id,
      replicaId: origin,
      result: JSON.stringify(result),
      createdAt: now,
    })
    .onConflictDoNothing();
  sendToCluster("agent-result", undefined, origin);
}

export function requestDetach(remote: RemoteConnection): void {
  sendToCluster("agent-detach", { agentId: remote.agentId }, remote.replicaId);
}

/** After the agents table changed under every replica's streams, not just this one's. */
export function requestReconcile(): void {
  sendToCluster("agents-reconcile");
}

async function drainOutbox(): Promise<void> {
  const rows = await db.delete(agentOutbox).where(eq(agentOutbox.replicaId, me())).returning({
    agentId: agentOutbox.agentId,
    event: agentOutbox.event,
    createdAt: agentOutbox.createdAt,
  });
  rows.sort((a, b) => a.createdAt - b.createdAt);
  for (const row of rows) {
    let event: AgentServerEvent;
    try {
      event = JSON.parse(row.event) as AgentServerEvent;
    } catch {
      continue;
    }
    const connection = registry.connections.get(row.agentId);
    if (connection?.send(event)) continue;
    if (event.type !== "command") continue;
    // Moved or gone since it was routed here: the issuer hears so now, not at its timeout.
    const answer: ForwardedResult = { id: event.command.id, notConnected: true };
    const origin = originOf(event.command.id);
    if (!origin || origin === me()) settleWaiter(row.agentId, answer);
    else await forwardResult(origin, answer);
  }
}

async function drainResults(): Promise<void> {
  const rows = await db
    .delete(agentCommandResults)
    .where(eq(agentCommandResults.replicaId, me()))
    .returning({ result: agentCommandResults.result });
  for (const row of rows) {
    let result: ForwardedResult;
    try {
      result = JSON.parse(row.result) as ForwardedResult;
    } catch {
      continue;
    }
    const agentId = result.id.split(":")[0];
    settleWaiter(agentId, result);
  }
}

/**
 * The heartbeat: re-claim this replica's streams if their rows went missing, close any another
 * live replica has since taken, drop rows of replicas gone quiet, reload the mirror and drain.
 */
export async function syncAgentConnections(now = Date.now()): Promise<void> {
  if (!isClusterShared()) return;
  const live = await liveReplicaIds(now);
  const local = [...registry.connections.values()];
  if (local.length > 0) {
    const rows = await db
      .select()
      .from(agentConnections)
      .where(
        inArray(
          agentConnections.agentId,
          local.map((connection) => connection.agentId),
        ),
      );
    const byAgent = new Map(rows.map((row) => [row.agentId, row]));
    for (const connection of local) {
      const row = byAgent.get(connection.agentId);
      // Only a newer stream displaces ours: an older row is the one ours replaced, its claim
      // not yet overwritten by ours.
      const newer = row !== undefined && row.connectedAt > connection.connectedAt;
      if (row && row.replicaId !== me() && live.has(row.replicaId) && newer) {
        hooks.detachLocal(connection.agentId);
      } else if (!row || row.replicaId !== me()) {
        await claimStream(connection, now);
      }
    }
  }

  await db.delete(agentConnections).where(notInArray(agentConnections.replicaId, [...live]));
  // Ours with no stream behind it: one that hung up before its claim was written.
  const held = [...registry.connections.keys()];
  await db
    .delete(agentConnections)
    .where(
      and(
        eq(agentConnections.replicaId, me()),
        held.length > 0 ? notInArray(agentConnections.agentId, held) : undefined,
      ),
    );
  const rows = await db.select().from(agentConnections).where(ne(agentConnections.replicaId, me()));
  registry.remote.clear();
  for (const row of rows) registry.remote.set(row.agentId, toRemote(row));

  await drainOutbox();
  await drainResults();
  await Promise.all([
    db.delete(agentOutbox).where(lt(agentOutbox.createdAt, now - STALE_MS)),
    db.delete(agentCommandResults).where(lt(agentCommandResults.createdAt, now - STALE_MS)),
  ]);
}

// ─── Messages ────────────────────────────────────────────────────────────────

function agentIdOf(data: unknown): string | null {
  const agentId = (data as { agentId?: unknown } | undefined)?.agentId;
  return typeof agentId === "string" ? agentId : null;
}

async function refresh(agentId: string): Promise<void> {
  const row = await readRow(agentId);
  if (!row) {
    registry.remote.delete(agentId);
    return;
  }
  if (row.replicaId === me()) return;
  // Another replica now holds it: a stream here is the one it displaced.
  if (registry.connections.has(agentId)) hooks.detachLocal(agentId);
  registry.remote.set(agentId, toRemote(row));
}

function quietly(what: string, work: () => Promise<void>): void {
  void work().catch((error: unknown) => console.error(`[agent] could not ${what}:`, error));
}

onClusterMessage("agent-attached", (data) => {
  const agentId = agentIdOf(data);
  if (agentId) quietly("follow an agent's stream", () => refresh(agentId));
});

onClusterMessage("agent-detached", (data, from) => {
  const agentId = agentIdOf(data);
  if (!agentId) return;
  if (registry.remote.get(agentId)?.replicaId === from) registry.remote.delete(agentId);
  // Those sent down that replica's stream will not be answered now; one reattached here may be.
  failWaiters(agentId, from, new AgentNotConnectedError("That agent disconnected."));
});

onClusterMessage("agent-status", (data) => {
  const agentId = agentIdOf(data);
  if (!agentId) return;
  quietly("read an agent's status", async () => {
    const row = await readRow(agentId);
    if (!row) return;
    const connection = registry.connections.get(agentId);
    if (connection) {
      connection.status = parseStatus(row.status);
      connection.lastSeenAt = row.lastSeenAt;
    } else if (row.replicaId !== me()) {
      registry.remote.set(agentId, toRemote(row));
    }
  });
});

onClusterMessage("agent-outbox", () => quietly("deliver forwarded events", drainOutbox));
onClusterMessage("agent-result", () => quietly("take forwarded results", drainResults));
onClusterMessage("agent-detach", (data) => {
  const agentId = agentIdOf(data);
  if (agentId) hooks.detachLocal(agentId);
});
onClusterMessage("agents-reconcile", () =>
  quietly("reconcile agent streams", () => hooks.reconcile()),
);
onClusterSync(() => syncAgentConnections());
