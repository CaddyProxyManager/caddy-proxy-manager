/**
 * Writing revisions. The snapshot is read inside the write's own transaction, after it (before it,
 * for a delete), so history holds exactly what was stored and rolls back with a failed write.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { type AuditEventParams, auditEventRow } from "../audit";
import { chainedAuditSteps } from "../audit/chain";
import { currentApprovalStamp } from "../audit/context";
import { nowIso, runInTransaction } from "../db";
import { type Step, readingStep } from "../db/reading-step";
import {
  hostRevisions,
  l4ProxyHostAgents,
  l4ProxyHosts,
  proxyHostAgents,
  proxyHosts,
  users,
} from "../db/schema";
import type { HostKind, HostRevisionDetail, HostRevisionOperation } from "./types";

// biome-ignore lint/suspicious/noExplicitAny: `tx` is the per-dialect transaction handle
type Tx = any;

export const HOST_TABLES = {
  http: { table: proxyHosts, agents: proxyHostAgents, hostColumn: proxyHostAgents.proxyHostId },
  l4: {
    table: l4ProxyHosts,
    agents: l4ProxyHostAgents,
    hostColumn: l4ProxyHostAgents.l4ProxyHostId,
  },
} as const;

export type HostSnapshot = { row: Record<string, unknown>; agentIds: number[] };

export type RevisionWrite = {
  kind: HostKind;
  hostId: number;
  operation: HostRevisionOperation;
  detail?: HostRevisionDetail | null;
  userId: number | null;
};

export type HostWriteOptions = {
  /** The revision a rollback loaded into the editor; the save is recorded as rolling back to it. */
  rollbackFrom?: number;
};

export function updateOperation(
  options: HostWriteOptions,
): Pick<RevisionWrite, "operation" | "detail"> {
  return options.rollbackFrom !== undefined
    ? { operation: "rollback", detail: { revision: options.rollbackFrom } }
    : { operation: "update" };
}

/** The revision, then the audit event naming it, so neither can exist without the other. */
export function* auditedRevision(
  tx: Tx,
  revision: RevisionWrite,
  audit: AuditEventParams,
): Generator<Step, number, unknown[]> {
  const revisionId = yield* recordHostRevision(tx, revision);
  yield* chainedAuditSteps(tx, [auditEventRow(withRevisionId(audit, revisionId))]);
  return revisionId;
}

export function withRevisionId(audit: AuditEventParams, revisionId: number): AuditEventParams {
  const data =
    audit.data && typeof audit.data === "object" && !Array.isArray(audit.data) ? audit.data : {};
  return { ...audit, data: { ...data, revisionId } };
}

/** The host as this transaction sees it; null if it has no such row. */
export function* readSnapshot(
  tx: Tx,
  kind: HostKind,
  hostId: number,
): Generator<Step, HostSnapshot | null, unknown[]> {
  const { table, agents, hostColumn } = HOST_TABLES[kind];
  const [row] = (yield { all: tx.select().from(table).where(eq(table.id, hostId)) }) as Record<
    string,
    unknown
  >[];
  if (!row) return null;
  const pins = (yield {
    all: tx
      .select({ agentId: agents.agentId })
      .from(agents)
      .where(eq(hostColumn, hostId))
      .orderBy(asc(agents.agentId)),
  }) as { agentId: number }[];
  return { row, agentIds: pins.map((pin) => pin.agentId) };
}

/** With the change request that approved it, when a write runs as one. */
function revisionDetail(detail: HostRevisionDetail | null): string | null {
  const stamp = currentApprovalStamp();
  const changeRequest = stamp && "changeRequest" in stamp ? stamp.changeRequest : undefined;
  if (changeRequest === undefined) return detail ? JSON.stringify(detail) : null;
  return JSON.stringify({ ...detail, changeRequest });
}

/** Yields its statements inside the caller's reading step; returns the new revision's id. */
export function* recordHostRevision(
  tx: Tx,
  write: RevisionWrite,
): Generator<Step, number, unknown[]> {
  const snapshot = yield* readSnapshot(tx, write.kind, write.hostId);
  if (!snapshot) throw new Error(`No ${write.kind} host ${write.hostId} to record a revision of`);
  let userName: string | null = null;
  if (write.userId !== null) {
    const [user] = (yield {
      all: tx
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, write.userId)),
    }) as { name: string | null; email: string }[];
    userName = user ? (user.name ?? user.email) : null;
  }
  const [inserted] = (yield {
    all: tx
      .insert(hostRevisions)
      .values({
        hostKind: write.kind,
        hostId: write.hostId,
        operation: write.operation,
        detail: revisionDetail(write.detail ?? null),
        snapshot: JSON.stringify(snapshot),
        userId: write.userId,
        userName,
        createdAt: nowIso(),
      })
      .returning({ id: hostRevisions.id }),
  }) as { id: number }[];
  return inserted.id;
}

/** Runs `build` as one transaction and hands back what it returned. */
export async function runHostWrite<T>(
  build: (tx: Tx) => Generator<Step, T, unknown[]>,
): Promise<T> {
  let result: T | undefined;
  await runInTransaction((tx) => [
    readingStep(function* () {
      result = yield* build(tx);
    }),
  ]);
  return result as T;
}

/** As `setHostAgents`, inside a transaction: diffed, never cleared and refilled. */
export function* setHostAgentsSteps(
  tx: Tx,
  kind: HostKind,
  hostId: number,
  agentRowIds: readonly number[],
): Generator<Step, void, unknown[]> {
  const { agents, hostColumn } = HOST_TABLES[kind];
  const wanted = [...new Set(agentRowIds.filter((id) => Number.isInteger(id) && id > 0))];
  const current = (
    (yield {
      all: tx.select({ agentId: agents.agentId }).from(agents).where(eq(hostColumn, hostId)),
    }) as {
      agentId: number;
    }[]
  ).map((row) => row.agentId);
  const removed = current.filter((id) => !wanted.includes(id));
  if (removed.length > 0) {
    yield {
      run: tx.delete(agents).where(and(eq(hostColumn, hostId), inArray(agents.agentId, removed))),
    };
  }
  const added = wanted.filter((id) => !current.includes(id));
  if (added.length > 0) {
    const now = nowIso();
    yield {
      run: tx
        .insert(agents)
        .values(
          added.map((agentId) =>
            kind === "http"
              ? { proxyHostId: hostId, agentId, createdAt: now }
              : { l4ProxyHostId: hostId, agentId, createdAt: now },
          ),
        ),
    };
  }
}
