import L4ProxyHostsClient from "./L4ProxyHostsClient";
import {
  listL4ProxyHostsPaginated,
  countL4ProxyHosts,
  countL4ProxyHostsByProtocol,
} from "@/src/lib/models/l4-proxy-hosts";
import type { L4Protocol } from "@/src/lib/models/l4-proxy-hosts";
import { listAgentOptions } from "@/src/lib/agent/client";
import { listL4AccessListOptions } from "@/src/lib/models/access-lists";
import { agentIdsForHosts } from "@/src/lib/models/host-agents";
import { canCreate, canManage, requireAccess, visibleIdFilter } from "@/src/lib/permissions";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

const PER_PAGE = 25;

interface PageProps {
  searchParams: Promise<{
    page?: string;
    search?: string;
    sortBy?: string;
    sortDir?: string;
    protocol?: string;
  }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("l4ProxyHosts") };
}

export default async function L4ProxyHostsPage({ searchParams }: PageProps) {
  const access = await requireAccess();
  const visible = visibleIdFilter(access, "l4ProxyHost");
  const visibleIds = visible === null ? null : [...visible];
  const {
    page: pageParam,
    search: searchParam,
    sortBy: sortByParam,
    sortDir: sortDirParam,
    protocol: protocolParam,
  } = await searchParams;
  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const search = searchParam?.trim() || undefined;
  const offset = (page - 1) * PER_PAGE;
  const sortBy = sortByParam || undefined;
  const sortDir = sortDirParam === "asc" || sortDirParam === "desc" ? sortDirParam : "desc";

  // In the query: a client-side tab shows nothing when every UDP host sits on a later page.
  const protocol: L4Protocol | undefined =
    protocolParam === "tcp" || protocolParam === "udp" ? protocolParam : undefined;

  const [hosts, total, counts, agents, accessLists] = await Promise.all([
    listL4ProxyHostsPaginated(PER_PAGE, offset, search, sortBy, sortDir, visibleIds, protocol),
    countL4ProxyHosts(search, visibleIds, protocol),
    countL4ProxyHostsByProtocol(search, visibleIds),
    listAgentOptions().catch(() => []),
    listL4AccessListOptions(),
  ]);

  // Only the hosts on this page - the map is for the edit dialog.
  const assignments = await agentIdsForHosts(
    "l4",
    hosts.map((host) => host.id),
  ).catch(() => new Map<number, number[]>());

  return (
    <L4ProxyHostsClient
      hosts={hosts}
      pagination={{ total, page, perPage: PER_PAGE }}
      counts={counts}
      activeProtocol={protocol ?? "all"}
      initialSearch={search ?? ""}
      initialSort={{ sortBy: sortBy ?? "createdAt", sortDir }}
      agents={agents}
      accessLists={accessLists}
      agentAssignments={Object.fromEntries(assignments)}
      canCreate={canCreate(access)}
      manageableIds={hosts.filter((h) => canManage(access, "l4ProxyHost", h.id)).map((h) => h.id)}
    />
  );
}
