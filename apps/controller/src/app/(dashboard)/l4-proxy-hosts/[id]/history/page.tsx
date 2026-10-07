import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { HostHistoryScreen } from "@/src/components/host-history/HostHistoryScreen";
import { loadHostHistory } from "@/src/lib/host-history/page";
import { getL4ProxyHost } from "@/src/lib/models/l4-proxy-hosts";
import { l4ProxyHostHistoryHref } from "@/src/lib/l4/editor-sections";
import { canManage, requireReach, can } from "@/src/lib/users/permissions";
import { restoreL4ProxyHostAction } from "../../actions";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function parseId(raw: string): number | null {
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings");
  return { title: t("history.navLabel") };
}

/** Managers of a live host, and administrators of a deleted one: its grants went with it. */
export default async function L4ProxyHostHistoryPage({ params, searchParams }: PageProps) {
  const id = parseId((await params).id);
  if (id === null) notFound();
  const access = await requireReach("hosts:read");
  const host = await getL4ProxyHost(id);
  if (host ? !canManage(access, "l4ProxyHost", id) : !can(access, "hosts:write")) notFound();
  const data = await loadHostHistory("l4", id, await searchParams);
  if (!host && data.latest === 0) notFound();
  const tNav = await getTranslations("nav");

  return (
    <HostHistoryScreen
      name={host?.name ?? data.name ?? `#${id}`}
      listHref="/l4-proxy-hosts"
      listLabel={tNav("l4ProxyHosts")}
      overviewHref={null}
      historyHref={l4ProxyHostHistoryHref(id)}
      view={{
        live: host !== null,
        revisions: data.revisions,
        page: data.page,
        perPage: data.perPage,
        total: data.total,
        ids: data.ids,
        latest: data.latest,
        selection: data.selection,
        comparison: data.comparison,
        showConfig: data.showConfig,
        rollbackHref: host ? `/l4-proxy-hosts?edit=${id}&revision=` : null,
        restore:
          !host && can(access, "hosts:write")
            ? {
                missing: data.missing,
                name: data.name ?? `#${id}`,
                action: restoreL4ProxyHostAction,
              }
            : null,
      }}
    />
  );
}
