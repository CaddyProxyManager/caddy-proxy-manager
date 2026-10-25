import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { listAgentOptions } from "@/src/lib/agent/client";
import { dynamicDnsProviderOptions } from "@/src/lib/dns/dynamic-dns";
import { listL4AccessListOptions } from "@/src/lib/models/access-lists";
import { agentIdsForHosts } from "@/src/lib/models/host-agents";
import { getL4ProxyHost, resolveL4ProxyHostId } from "@/src/lib/models/l4-proxy-hosts";
import { getDnsProviderSettings } from "@/src/lib/settings";
import { canManage, requireReach } from "@/src/lib/users/permissions";
import { L4ProxyHostEditScreen } from "./L4ProxyHostEditScreen";

type LayoutProps = { params: Promise<{ id: string }>; children: ReactNode };

/** The editor, in a layout so it outlives each section's page, as the proxy host's does. */
export default async function L4ProxyHostEditLayout({ params, children }: LayoutProps) {
  const { id: raw } = await params;
  const id = await resolveL4ProxyHostId(raw);
  if (id === null) notFound();
  const access = await requireReach("hosts:read");
  if (!canManage(access, "l4ProxyHost", id)) notFound();
  const host = await getL4ProxyHost(id);
  if (!host) notFound();

  const [agents, accessLists, dnsProviders, assignments] = await Promise.all([
    listAgentOptions().catch(() => []),
    listL4AccessListOptions(),
    getDnsProviderSettings(),
    agentIdsForHosts("l4", [id]).catch(() => new Map<number, number[]>()),
  ]);
  const tNav = await getTranslations("nav");

  return (
    <L4ProxyHostEditScreen
      name={host.name}
      listLabel={tNav("l4ProxyHosts")}
      host={host}
      agents={agents}
      accessLists={accessLists}
      dynamicDnsProviders={dynamicDnsProviderOptions(dnsProviders)}
      assignedAgentIds={assignments.get(id) ?? []}
    >
      {children}
    </L4ProxyHostEditScreen>
  );
}
