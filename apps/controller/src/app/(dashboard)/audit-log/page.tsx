import { requireCan } from "@/src/lib/users/permissions";
import AuditLogClient from "./AuditLogClient";
import { verifyAuditChainAction } from "./actions";
import {
  listAuditEvents,
  countAuditEvents,
  auditActivityByHour,
  auditActivitySummary,
  auditFilterOptions,
  type AuditEventFilter,
} from "@/src/lib/models/audit";
import { listUsers } from "@/src/lib/models/user";
import { strictId } from "@/src/lib/http/strict-id";
import { auditSummaryText } from "@/src/lib/audit/summary";
import { auditRevisionLinks } from "@/src/lib/host-history";
import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";

const PER_PAGE = 50;

interface PageProps {
  searchParams: Promise<{
    page?: string;
    search?: string;
    user?: string;
    resource?: string;
    action?: string;
  }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("auditLog") };
}

export default async function AuditLogPage({ searchParams }: PageProps) {
  await requireCan("audit:read");
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);
  const filter: AuditEventFilter = {
    search: params.search?.trim() || undefined,
    // "system" is the actor with no user row; anything else unparseable is no filter at all.
    userId: params.user === "system" ? null : strictId(params.user),
    entityType: params.resource?.trim() || undefined,
    action: params.action?.trim() || undefined,
  };
  const offset = (page - 1) * PER_PAGE;

  // The strip and the tiles describe the last 24 hours of the whole log, deliberately ignoring the
  // search: they are context for what you are about to read, not a summary of it.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();

  const [events, total, users, activity, summary, options] = await Promise.all([
    listAuditEvents(PER_PAGE, offset, filter),
    countAuditEvents(filter),
    listUsers(),
    auditActivityByHour(sinceIso).catch(() => []),
    auditActivitySummary(sinceIso).catch(() => ({ events: 0, actors: 0, entityTypes: 0 })),
    auditFilterOptions(),
  ]);

  // Fill the gaps the query leaves out, so the strip always has 24 bars and a quiet hour reads as
  // a quiet hour rather than as a missing one.
  const counts = new Map(activity.map((bucket) => [bucket.hour, bucket.count]));
  // The hour each bar starts at, on the reader's clock. The buckets are UTC hours, so in a zone
  // with a half-hour offset they read 14:30, 15:30 - still exactly when each one began.
  const format = await getFormatter();
  const buckets = Array.from({ length: 24 }, (_, index) => {
    const at = new Date(since.getTime() + index * 60 * 60 * 1000);
    const key = at.toISOString().slice(0, 13);
    return {
      label: format.dateTime(new Date(`${key}:00:00.000Z`), {
        hour: "numeric",
        minute: "2-digit",
      }),
      count: counts.get(key) ?? 0,
    };
  });

  const userMap = new Map(users.map((user) => [user.id, user]));
  const revisionLinks = await auditRevisionLinks(events).catch(() => new Map());
  const t = await getTranslations("auditLog");
  // The summaries' keys are composed at runtime, which the root translator is typed for.
  const tSummaries = await getTranslations();

  return (
    <AuditLogClient
      events={events.map((event) => ({
        id: event.id,
        createdAt: event.createdAt,
        changes: event.changes,
        revisionLink: revisionLinks.get(event.id) ?? null,
        action: event.action,
        entityType: event.entityType,
        summary:
          auditSummaryText(tSummaries, event) ??
          t("summaryFallback", { action: event.action, entityType: event.entityType }),
        user: event.userId
          ? (userMap.get(event.userId)?.name ??
            userMap.get(event.userId)?.email ??
            t("systemActor"))
          : t("systemActor"),
      }))}
      pagination={{ total, page, perPage: PER_PAGE }}
      filterOptions={{
        users: [
          { value: "system", label: t("systemActor") },
          ...users.map((user) => ({ value: String(user.id), label: user.name ?? user.email })),
        ],
        resources: options.entityTypes,
        actions: options.actions,
      }}
      activity={buckets}
      summary={summary}
      verifyChain={verifyAuditChainAction}
    />
  );
}
