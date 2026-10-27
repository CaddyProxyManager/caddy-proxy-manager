import { inArray } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import db from "../db";
import { users } from "../db/schema";
import type { HostAuditEntry, HostAuditRow } from "../proxy-hosts/detail-types";
import { auditSummaryText } from "./summary";

/** A host overview's recent changes, named and worded as the audit log page does. */
export async function hostAuditRows(audit: HostAuditEntry[]): Promise<HostAuditRow[]> {
  // Summaries are stored in English and translated on the way out.
  const tSummaries = await getTranslations();
  const tAuditLog = await getTranslations("auditLog");
  const actorIds = [...new Set(audit.flatMap((e) => (e.userId === null ? [] : [e.userId])))];
  const actors =
    actorIds.length === 0
      ? []
      : await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(inArray(users.id, actorIds));
  const actorNames = new Map(actors.map((a) => [a.id, a.name ?? a.email]));
  return audit.map((event) => ({
    id: event.id,
    action: event.action,
    summary:
      auditSummaryText(tSummaries, event) ??
      tAuditLog("summaryFallback", { action: event.action, entityType: event.entityType }),
    actor: event.userId === null ? null : (actorNames.get(event.userId) ?? null),
    createdAt: event.createdAt,
  }));
}
