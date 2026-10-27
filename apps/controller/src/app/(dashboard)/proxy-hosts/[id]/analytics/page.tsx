import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ProxyHostTabScreen } from "@/src/components/proxy-hosts/detail/ProxyHostTabScreen";
import AnalyticsClient from "../../../analytics/AnalyticsClient";
import { loadHostTab } from "../host-tab";

type PageProps = { params: Promise<{ id: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("analytics") };
}

/** The Analytics page itself, scoped to the host's names. */
export default async function ProxyHostAnalyticsPage({ params }: PageProps) {
  const { host, names, header, manages } = await loadHostTab((await params).id, "analytics:read");
  const t = await getTranslations("proxyHosts.detail");
  return (
    <ProxyHostTabScreen uuid={host.uuid} header={header} active="analytics" canManage={manages}>
      <AnalyticsClient lockedHosts={names} title={t("analyticsTitle", { name: host.name })} />
    </ProxyHostTabScreen>
  );
}
