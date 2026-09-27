/**
 * Keeps one rule in one place: **a host with no assignments is served by every agent**, so
 * upgrades change nothing and no host is silently served nowhere. Assignments name `agents.id`,
 * not the self-asserted `agentId`.
 */

import { and, eq, inArray } from "drizzle-orm";
import db, { nowIso } from "../db";
import { l4ProxyHostAgents, proxyHostAgents } from "../db/schema";

export type HostKind = "http" | "l4";

const TABLES = {
  http: { table: proxyHostAgents, hostColumn: proxyHostAgents.proxyHostId },
  l4: { table: l4ProxyHostAgents, hostColumn: l4ProxyHostAgents.l4ProxyHostId },
} as const;

/** Absent means every agent; read it only through {@link servedByAgent}. */
export type HostAssignments = Map<number, number[]>;

export async function listHostAssignments(kind: HostKind): Promise<HostAssignments> {
  const { table, hostColumn } = TABLES[kind];
  const rows = await db.select({ hostId: hostColumn, agentId: table.agentId }).from(table);

  const assignments: HostAssignments = new Map();
  for (const row of rows) {
    const bucket = assignments.get(row.hostId) ?? [];
    bucket.push(row.agentId);
    assignments.set(row.hostId, bucket);
  }
  for (const bucket of assignments.values()) bucket.sort((a, b) => a - b);
  return assignments;
}

/** A `null` agent is the fleet-wide document, which includes every host. */
export function servedByAgent(
  assignments: HostAssignments,
  hostId: number,
  agentRowId: number | null,
): boolean {
  if (agentRowId === null) return true;
  const assigned = assignments.get(hostId);
  if (!assigned || assigned.length === 0) return true;
  return assigned.includes(agentRowId);
}

/** Empty means every agent. */
export async function agentIdsForHost(kind: HostKind, hostId: number): Promise<number[]> {
  const { table, hostColumn } = TABLES[kind];
  const rows = await db
    .select({ agentId: table.agentId })
    .from(table)
    .where(eq(hostColumn, hostId));
  return rows.map((row) => row.agentId).sort((a, b) => a - b);
}

/** One query rather than one per row on a list page. */
export async function agentIdsForHosts(
  kind: HostKind,
  hostIds: number[],
): Promise<HostAssignments> {
  if (hostIds.length === 0) return new Map();
  const { table, hostColumn } = TABLES[kind];
  const rows = await db
    .select({ hostId: hostColumn, agentId: table.agentId })
    .from(table)
    .where(inArray(hostColumn, hostIds));

  const assignments: HostAssignments = new Map();
  for (const row of rows) {
    const bucket = assignments.get(row.hostId) ?? [];
    bucket.push(row.agentId);
    assignments.set(row.hostId, bucket);
  }
  for (const bucket of assignments.values()) bucket.sort((a, b) => a - b);
  return assignments;
}

/**
 * Diffed, not delete-then-insert: a reader between the two would see "unassigned", i.e. every
 * agent - a brief fleet-wide exposure of a host being narrowed.
 */
export async function setHostAgents(
  kind: HostKind,
  hostId: number,
  agentRowIds: number[],
): Promise<void> {
  const { table, hostColumn } = TABLES[kind];
  const wanted = [...new Set(agentRowIds.filter((id) => Number.isInteger(id) && id > 0))];
  const current = await agentIdsForHost(kind, hostId);

  const removed = current.filter((id) => !wanted.includes(id));
  const added = wanted.filter((id) => !current.includes(id));

  if (removed.length > 0) {
    await db.delete(table).where(and(eq(hostColumn, hostId), inArray(table.agentId, removed)));
  }
  if (added.length > 0) {
    const now = nowIso();
    await db
      .insert(table)
      .values(
        added.map((agentId) =>
          kind === "http"
            ? { proxyHostId: hostId, agentId, createdAt: now }
            : { l4ProxyHostId: hostId, agentId, createdAt: now },
        ) as never,
      );
  }
}

/** Unparseable means empty ("every agent"), as absent does, so older clients keep working. */
export function parseAgentIds(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const ids: number[] = [];
  for (const entry of raw) {
    const id = typeof entry === "number" ? entry : Number.parseInt(String(entry).trim(), 10);
    if (Number.isInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids.sort((a, b) => a - b);
}
