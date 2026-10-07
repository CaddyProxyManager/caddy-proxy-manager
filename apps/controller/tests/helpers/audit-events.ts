import { asc, gt, max } from 'drizzle-orm';
import * as schema from '../../src/lib/db/schema';
import type { TestDb } from './db';

export type LoggedAuditEvent = {
  userId: number | null;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string | null;
  /** What the event recorded besides its diff and revision. */
  data?: Record<string, unknown>;
  changes?: unknown[];
  revisionId?: number;
};

/**
 * Host writes chain their audit event inside the write's transaction rather than through
 * `logAuditEvent`, so these read the table: everything after the last `clear()`, oldest first.
 */
export function auditEvents(current: () => TestDb) {
  let after = 0;
  return {
    reset() {
      after = 0;
    },
    async clear() {
      const [row] = await current()
        .select({ id: max(schema.auditEvents.id) })
        .from(schema.auditEvents);
      after = Number(row?.id ?? 0);
    },
    async list(): Promise<LoggedAuditEvent[]> {
      const rows = await current()
        .select()
        .from(schema.auditEvents)
        .where(gt(schema.auditEvents.id, after))
        .orderBy(asc(schema.auditEvents.seq));
      return rows.map((row) => {
        const { changes, revisionId, ...data } = row.data ? JSON.parse(row.data) : {};
        return {
          userId: row.userId,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          summary: row.summary,
          ...(Object.keys(data).length > 0 ? { data } : {}),
          ...(changes ? { changes } : {}),
          ...(revisionId !== undefined ? { revisionId } : {}),
        };
      });
    },
  };
}
