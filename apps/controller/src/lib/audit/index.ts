import { runInTransaction, nowIso } from "../db";
import { type AuditRow, chainedAuditInsert } from "./chain";
import type { AuditChange } from "./changes";

export type AuditEventParams = {
  userId?: number | null;
  action: string;
  entityType: string;
  entityId?: number | null;
  summary?: string | null;
  data?: unknown;
  /** Field-level before and after, secrets masked; stored as `data.changes`. */
  changes?: AuditChange[] | null;
};

function eventData(params: AuditEventParams): string | null {
  const changes = params.changes && params.changes.length > 0 ? params.changes : null;
  if (!changes) return params.data ? JSON.stringify(params.data) : null;
  const base =
    params.data && typeof params.data === "object" && !Array.isArray(params.data)
      ? params.data
      : params.data
        ? { value: params.data }
        : {};
  return JSON.stringify({ ...base, changes });
}

/** The row itself, for a caller inserting it inside its own transaction with chainedAuditInsert. */
export function auditEventRow(params: AuditEventParams): AuditRow {
  return {
    userId: params.userId ?? null,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId ?? null,
    summary: params.summary ?? null,
    data: eventData(params),
    createdAt: nowIso(),
  };
}

/** Inserts already-built rows as one chained write. */
export async function insertAuditRows(rows: AuditRow[]): Promise<void> {
  await runInTransaction((tx) => [chainedAuditInsert(tx, rows)]);
}

/** Await this, or the request can finish before the row lands. */
export async function logAuditEvent(params: AuditEventParams): Promise<void> {
  try {
    await insertAuditRows([auditEventRow(params)]);
  } catch (error) {
    // Never break the main flow over an audit row.
    console.error("Failed to log audit event:", error);
  }
}

export { chainedAuditInsert } from "./chain";
