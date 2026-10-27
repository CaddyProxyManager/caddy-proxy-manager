import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ProxyHostTabScreen } from "@/src/components/proxy-hosts/detail/ProxyHostTabScreen";
import { logReadableAgents } from "@/src/lib/agent/client";
import { getLoggingSettings } from "@/src/lib/settings";
import LogsClient from "../../../logs/LogsClient";
import { loadHostTab } from "../host-tab";

type PageProps = { params: Promise<{ id: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("logs") };
}

/** The log viewer itself, showing only lines for the host's names. */
export default async function ProxyHostLogsPage({ params }: PageProps) {
  const { host, names, header, manages } = await loadHostTab((await params).id, "logs:read");
  const t = await getTranslations("proxyHosts.detail");
  return (
    <ProxyHostTabScreen uuid={host.uuid} header={header} active="logs" canManage={manages}>
      <LogsClient
        agents={logReadableAgents().map((a) => ({ ...a, canReadLogs: true }))}
        initialAgent={null}
        initialView="access"
        initialHost={null}
        accessLogEnabled={(await getLoggingSettings())?.enabled === true}
        lockedHosts={names}
        title={t("logsTitle", { name: host.name })}
      />
    </ProxyHostTabScreen>
  );
}
