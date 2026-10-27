import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { L4HostDetailView } from "@/src/components/l4-proxy-hosts/L4HostDetailView";
import { hostAuditRows } from "@/src/lib/audit/host-audit-rows";
import { getL4HostDetail } from "@/src/lib/l4/detail";
import { getL4ProxyHost, resolveL4ProxyHostId } from "@/src/lib/models/l4-proxy-hosts";
import { requestMemo } from "@/src/lib/request-memo";
import { can, canManage, canView, requireReach } from "@/src/lib/users/permissions";

type PageProps = { params: Promise<{ id: string }> };

/** Once for the metadata and the page both. */
async function viewableHost(raw: string) {
  const id = await resolveL4ProxyHostId(raw);
  if (id === null) return null;
  return requestMemo(`l4-proxy-host-view:${id}`, async () => {
    const access = await requireReach("hosts:read");
    if (!canView(access, "l4ProxyHost", id)) return null;
    const host = await getL4ProxyHost(id);
    return host ? { access, host } : null;
  });
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = await getTranslations("nav");
  const found = await viewableHost((await params).id).catch(() => null);
  return { title: found ? found.host.name : t("l4ProxyHosts") };
}

export default async function L4ProxyHostDetailPage({ params }: PageProps) {
  const found = await viewableHost((await params).id);
  if (!found) notFound();
  const { access, host } = found;
  const { audit, ...detail } = await getL4HostDetail(host, access);
  return (
    <L4HostDetailView
      detail={detail}
      canManage={canManage(access, "l4ProxyHost", host.id)}
      auditRows={can(access, "audit:read") ? await hostAuditRows(audit) : null}
    />
  );
}
