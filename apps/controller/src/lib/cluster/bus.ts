/**
 * Small messages between replicas, over one NOTIFY channel; `to` names one replica, or none for
 * all. NOTIFY caps a payload at 8000 bytes, so anything bigger goes in a table and this carries a
 * nudge to read it. Delivery is at most once: a receiver that might miss one syncs on a heartbeat.
 */
import { cluster, type MessageHandler } from "./state";
import type { SQL } from "bun";
import { postgresClient } from "../db/connection";

const CHANNEL = "cpm_bus";

type Message = { from: string; to?: string; type: string; data?: unknown };

/** True when other replicas may exist: PostgreSQL, and the cluster started. */
export function isClusterShared(): boolean {
  return cluster.started && postgresClient !== null;
}

export function onClusterMessage(type: string, handler: MessageHandler): void {
  let handlers = cluster.messageHandlers.get(type);
  if (!handlers) {
    handlers = new Set();
    cluster.messageHandlers.set(type, handlers);
  }
  handlers.add(handler);
}

/** Fire-and-forget; nothing happens until the cluster is shared. */
export function sendToCluster(type: string, data?: unknown, to?: string): void {
  if (!isClusterShared() || !postgresClient) return;
  const message: Message = { from: cluster.replicaId, type, ...(to ? { to } : {}), data };
  void postgresClient.notify(CHANNEL, JSON.stringify(message)).catch((error: unknown) => {
    console.error(`[cluster] could not send "${type}":`, error);
  });
}

/** A heartbeat's work for one module; runs on each beat and after the listener reconnects. */
export function onClusterSync(hook: () => Promise<void>): void {
  cluster.syncHooks.add(hook);
}

export async function runSyncHooks(): Promise<void> {
  const results = await Promise.allSettled([...cluster.syncHooks].map((hook) => hook()));
  for (const result of results) {
    if (result.status === "rejected") console.error("[cluster] sync failed:", result.reason);
  }
}

function receive(raw: string): void {
  let message: Partial<Message>;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof message.type !== "string" || typeof message.from !== "string") return;
  if (message.from === cluster.replicaId) return;
  if (message.to !== undefined && message.to !== cluster.replicaId) return;
  for (const handler of cluster.messageHandlers.get(message.type) ?? []) {
    try {
      handler(message.data, message.from);
    } catch (error) {
      console.error(`[cluster] could not handle "${message.type}":`, error);
    }
  }
}

export async function listenForMessages(pg: SQL): Promise<void> {
  let first = true;
  const subscription = await pg.listen(CHANNEL, receive, () => {
    // The first call is the subscription itself; later ones follow a reconnect.
    if (first) {
      first = false;
      return;
    }
    void runSyncHooks();
  });
  cluster.subscriptions.push(subscription);
}

/** Concurrently: the last one closes the connection, which settles an UNLISTEN still waiting. */
export async function stopListening(): Promise<void> {
  const held = cluster.subscriptions.splice(0);
  await Promise.allSettled(held.map((subscription) => subscription.unlisten()));
}
