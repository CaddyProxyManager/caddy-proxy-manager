import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { hostAuditRows } from "@/src/lib/audit/host-audit-rows";
import { getProxyHost, resolveProxyHostId } from "@/src/lib/models/proxy-hosts";
import { getProxyHostDetail } from "@/src/lib/proxy-hosts/detail";
import { proxyHostHistoryHref } from "@/src/lib/proxy-hosts/editor-sections";
import { proxyHostHeaderLinks } from "@/src/lib/proxy-hosts/header";
import { canManage, canView, requireReach, can } from "@/src/lib/users/permissions";
import { ProxyHostDetailView } from "@/src/components/proxy-hosts/detail/ProxyHostDetailView";
import { WafOverridePanel } from "@/src/components/proxy-hosts/waf/WafOverridePanel";
import { headers } from "next/headers";
import { getClientIp } from "@/src/lib/http/client-ip";
import { getWafOverride } from "@/src/lib/models/waf-overrides";
import { getWafSettings } from "@/src/lib/settings";
import { resolveEffectiveWaf } from "@/src/lib/waf/caddy";
import { isLoopbackIp } from "@/src/lib/waf/override";
import { requestMemo } from "@/src/lib/request-memo";

type PageProps = { params: Promise<{ id: string }> };

/** A loopback address is the proxy's or the machine's, never the tester's: ask instead. */
function usableAddress(ip: string | null): string | null {
  return ip && !isLoopbackIp(ip) ? ip : null;
}

/** Once for the metadata and the page both. */
async function viewableHost(raw: string) {
  const id = await resolveProxyHostId(raw);
  if (id === null) return null;
  return requestMemo(`proxy-host-view:${id}`, async () => {
    const access = await requireReach("hosts:read");
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

  const { analyticsHref, logsHref } = proxyHostHeaderLinks(access, host, detail.traffic !== null);

  // Offered where it can do something: a manager, and a WAF that blocks. The panel itself says
  // why a start is refused (analytics off, say), so nothing else is checked here.
  const manages = canManage(access, "proxyHost", host.id);
  const effectiveWaf = manages ? resolveEffectiveWaf(await getWafSettings(), host.waf) : null;
  const wafOverride =
    effectiveWaf?.enabled && effectiveWaf.mode === "On" ? (
      <WafOverridePanel
        hostId={host.id}
        hostName={host.name}
        initialSession={await getWafOverride(host.id)}
        detectedIp={usableAddress(await getClientIp(await headers()))}
        canApply={can(access, "security:write")}
      />
    ) : null;

  return (
    <ProxyHostDetailView
      detail={detail}
      canManage={manages}
      wafOverride={wafOverride}
      historyHref={manages ? proxyHostHistoryHref(host.uuid) : null}
      analyticsHref={analyticsHref}
      logsHref={logsHref}
      auditRows={can(access, "audit:read") ? await hostAuditRows(audit) : null}
    />
  );
}
