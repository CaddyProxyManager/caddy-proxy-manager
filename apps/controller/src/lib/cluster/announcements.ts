/**
 * "This cache is stale" to every replica: NOTIFY for now, and a generation per name, re-read when
 * the listener reconnects and on each heartbeat, for a NOTIFY sent while it was away.
 */
// First: settings/resolve registers a handler while ../db may still be loading.
import { cluster } from "./state";
import type { SQL } from "bun";
import { sql } from "drizzle-orm";
import db from "../db";
import { postgresClient } from "../db/connection";
import { clusterGenerations } from "../db/schema";

const CHANNEL = "cpm_cluster";

type Announcement = { from: string; name: string; generation: number };

function runHandlers(name: string): void {
  for (const handler of cluster.handlers.get(name) ?? []) {
    try {
      handler();
    } catch (error) {
      console.error(`[cluster] could not drop "${name}":`, error);
    }
  }
}

/** The handler drops this process's copy only; announcing from it would echo round the cluster. */
export function onAnnouncement(name: string, handler: () => void): void {
  let handlers = cluster.handlers.get(name);
  if (!handlers) {
    handlers = new Set();
    cluster.handlers.set(name, handlers);
  }
  handlers.add(handler);
}

/** Drops this process's copy at once; the others follow as soon as they hear. */
export function announce(name: string): void {
  runHandlers(name);
  if (!cluster.started || !postgresClient) return;
  void publish(postgresClient, name).catch((error: unknown) => {
    console.error(`[cluster] could not announce "${name}"; other replicas keep their copy:`, error);
  });
}

async function publish(pg: SQL, name: string): Promise<void> {
  const [row] = await db
    .insert(clusterGenerations)
    .values({ name, generation: 1 })
    .onConflictDoUpdate({
      target: clusterGenerations.name,
      set: { generation: sql`${clusterGenerations.generation} + 1` },
    })
    .returning({ generation: clusterGenerations.generation });
  if (!row) return;
  cluster.generations.set(name, row.generation);
  const payload: Announcement = { from: cluster.replicaId, name, generation: row.generation };
  await pg.notify(CHANNEL, JSON.stringify(payload));
}

function receive(raw: string): void {
  let message: Partial<Announcement>;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (message.from === cluster.replicaId || typeof message.name !== "string") return;
  if (typeof message.generation === "number") {
    cluster.generations.set(message.name, message.generation);
  }
  runHandlers(message.name);
}

/** At start: what is announced from now on is news, what was before is already in the database. */
export async function listenForAnnouncements(pg: SQL): Promise<void> {
  const rows = await db.select().from(clusterGenerations);
  for (const row of rows) cluster.generations.set(row.name, row.generation);
  // Bun re-listens on its own after the connection drops, and calls back each time it has.
  await pg.listen(CHANNEL, receive, () => {
    void catchUpOnAnnouncements().catch((error: unknown) => {
      console.error("[cluster] could not catch up on announcements:", error);
    });
  });
}

export async function catchUpOnAnnouncements(): Promise<void> {
  const rows = await db.select().from(clusterGenerations);
  for (const row of rows) {
    if (cluster.generations.get(row.name) === row.generation) continue;
    cluster.generations.set(row.name, row.generation);
    runHandlers(row.name);
  }
}
