import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { listAgentOptions } from "@/src/lib/agent/client";
import { agentIdsForHosts } from "@/src/lib/models/host-agents";
import { getProxyHost, resolveProxyHostId } from "@/src/lib/models/proxy-hosts";
import { loadForwardAuthAccess, loadHostEditorOptions } from "@/src/lib/proxy-hosts/editor-options";
import { loadProxyHostHeader } from "@/src/lib/proxy-hosts/header";
import { can, canManage, requireReach } from "@/src/lib/users/permissions";
import { ProxyHostEditScreen } from "./ProxyHostEditScreen";

type LayoutProps = { params: Promise<{ id: string }>; children: ReactNode };

/**
 * The editor, in a layout so it outlives each section's page: switching sections, or the refresh a
 * save brings, would otherwise remount the form and drop what was typed.
 */
export default async function ProxyHostEditLayout({ params, children }: LayoutProps) {
  const { id: raw } = await params;
  const id = await resolveProxyHostId(raw);
  if (id === null) notFound();
  const access = await requireReach("hosts:read");
  if (!canManage(access, "proxyHost", id)) notFound();
  const host = await getProxyHost(id);
  if (!host) notFound();

  // A host without CPM forward auth has no grants to read, and saving writes none over them.
  const [header, options, forwardAuthAccess, agents, assignments] = await Promise.all([
    loadProxyHostHeader(host, access),
    loadHostEditorOptions(),
    host.cpmForwardAuth?.enabled ? loadForwardAuthAccess(id) : null,
    listAgentOptions().catch(() => []),
    agentIdsForHosts("http", [id]).catch(() => new Map<number, number[]>()),
  ]);

  return (
    <ProxyHostEditScreen
      header={header}
      host={host}
      options={options}
      forwardAuthAccess={forwardAuthAccess}
      agents={agents}
      assignedAgentIds={assignments.get(id) ?? []}
      canEditRawConfig={can(access, "settings:write")}
    >
      {children}
    </ProxyHostEditScreen>
  );
}
