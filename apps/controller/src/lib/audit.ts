import db, { nowIso } from "./db";
import { auditEvents } from "./db/schema";

/** Await this, or the request can finish before the row lands. */
export async function logAuditEvent(params: {
  userId?: number | null;
  action: string;
  entityType: string;
  entityId?: number | null;
  summary?: string | null;
  data?: unknown;
}): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      userId: params.userId ?? null,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId ?? null,
      summary: params.summary ?? null,
      data: params.data ? JSON.stringify(params.data) : null,
      createdAt: nowIso(),
    });
  } catch (error) {
    // Never break the main flow over an audit row.
    console.error("Failed to log audit event:", error);
  }
}
