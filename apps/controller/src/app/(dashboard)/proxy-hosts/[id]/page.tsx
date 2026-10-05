import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { inArray } from "drizzle-orm";
import db from "@/src/lib/db";
import { users } from "@/src/lib/db/schema";
import { auditSummaryText } from "@/src/lib/audit/summary";
import { DEFAULT_EXPLORE_STATE, serializeExploreState } from "@/src/lib/analytics/explore-state";
import { getProxyHost } from "@/src/lib/models/proxy-hosts";
import { getProxyHostDetail } from "@/src/lib/proxy-hosts/detail";
import { hostTrafficNames } from "@/src/lib/proxy-hosts/traffic-status";
import { canManage, canView, requireAccess } from "@/src/lib/users/permissions";
import { ProxyHostDetailView } from "@/src/components/proxy-hosts/detail/ProxyHostDetailView";
import { requestMemo } from "@/src/lib/request-memo";

type PageProps = { params: Promise<{ id: string }> };

/** Digits only, so `12abc` is not host 12. */
function parseId(raw: string): number | null {
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

/** Once for the metadata and the page both. */
async function viewableHost(raw: string) {
  const id = parseId(raw);
  if (id === null) return null;
  return requestMemo(`proxy-host-view:${id}`, async () => {
    const access = await requireAccess();
    if (!canView(access, "proxyHost", id)) return null;
    const host = await getProxyHost(id);
    return host ? { access, host } : null;
  });
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = await getTranslations("nav");
  const found = await viewableHost((await params).id).catch(() => null);
  return { title: found ? found.host.name : t("proxyHosts") };
}

export default async function ProxyHostDetailPage({ params }: PageProps) {
  const found = await viewableHost((await params).id);
  if (!found) notFound();
  const { access, host } = found;
  const { audit, ...detail } = await getProxyHostDetail(host, access);

  // See the audit log page: summaries are stored in English and translated on the way out.
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

  const primaryName = hostTrafficNames(host.domains)[0];
  const analyticsHref =
    access.isAdmin && detail.traffic && primaryName
      ? `/analytics?${serializeExploreState({
          ...DEFAULT_EXPLORE_STATE,
          filters: [{ field: "host", op: "is", value: primaryName }],
        }).toString()}`
      : null;

  return (
    <ProxyHostDetailView
      detail={detail}
      canManage={canManage(access, "proxyHost", host.id)}
      analyticsHref={analyticsHref}
      logsHref={
        access.isAdmin && primaryName
          ? `/logs?source=access&host=${encodeURIComponent(primaryName)}`
          : null
      }
      auditRows={
        access.isAdmin
          ? audit.map((event) => ({
              id: event.id,
              action: event.action,
              summary:
                auditSummaryText(tSummaries, event) ??
                tAuditLog("summaryFallback", {
                  action: event.action,
                  entityType: event.entityType,
                }),
              actor: event.userId === null ? null : (actorNames.get(event.userId) ?? null),
              createdAt: event.createdAt,
            }))
          : null
      }
    />
  );
}
