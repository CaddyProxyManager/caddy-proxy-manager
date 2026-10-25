import { redirect } from "next/navigation";
import L4ProxyHostsClient from "./L4ProxyHostsClient";
import { HostTagSuggestions } from "@/components/proxy-hosts/HostTagsField";
import {
  listL4ProxyHostsPaginated,
  countL4ProxyHosts,
  countL4ProxyHostsByProtocol,
  listL4ProxyHostTags,
} from "@/src/lib/models/l4-proxy-hosts";
import { l4EditorSectionHref } from "@/src/lib/l4/editor-sections";
import type { L4Protocol } from "@/src/lib/models/l4-proxy-hosts";
import { listAgentOptions } from "@/src/lib/agent/client";
import { listL4AccessListOptions } from "@/src/lib/models/access-lists";
import { getDnsProviderSettings, getHostDefaults } from "@/src/lib/settings";
import { dynamicDnsProviderOptions } from "@/src/lib/dns/dynamic-dns";
import { canCreate, canManage, requireReach, visibleIdFilter } from "@/src/lib/users/permissions";
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
    tag?: string;
    /** The editor was a dialog here; old links to it go to the host's edit page. */
    edit?: string;
    revision?: string;
  }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("l4ProxyHosts") };
}

export default async function L4ProxyHostsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  // The hash, naming a section, is kept by the browser across the redirect.
  if (params.edit) {
    const revision = params.revision ? `?revision=${encodeURIComponent(params.revision)}` : "";
    redirect(`${l4EditorSectionHref(encodeURIComponent(params.edit))}${revision}`);
  }
  const access = await requireReach("hosts:read");
  const visible = visibleIdFilter(access, "l4ProxyHost");
  const visibleIds = visible === null ? null : [...visible];
  const {
    page: pageParam,
    search: searchParam,
    sortBy: sortByParam,
    sortDir: sortDirParam,
    protocol: protocolParam,
    tag: tagParam,
  } = params;
  const tag = tagParam?.trim().toLowerCase() || undefined;
  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const search = searchParam?.trim() || undefined;
  const offset = (page - 1) * PER_PAGE;
  const sortBy = sortByParam || undefined;
  const sortDir = sortDirParam === "asc" || sortDirParam === "desc" ? sortDirParam : "desc";

  // In the query: a client-side tab shows nothing when every UDP host sits on a later page.
  const protocol: L4Protocol | undefined =
    protocolParam === "tcp" || protocolParam === "udp" ? protocolParam : undefined;

  const [hosts, total, counts, tags, agents, accessLists, hostDefaults, dnsProviders] =
    await Promise.all([
      listL4ProxyHostsPaginated(
        PER_PAGE,
        offset,
        search,
        sortBy,
        sortDir,
        visibleIds,
        protocol,
        tag,
      ),
      countL4ProxyHosts(search, visibleIds, protocol, tag),
      countL4ProxyHostsByProtocol(search, visibleIds, tag),
      listL4ProxyHostTags(visibleIds),
      listAgentOptions().catch(() => []),
      listL4AccessListOptions(),
      getHostDefaults(),
      getDnsProviderSettings(),
    ]);

  return (
    <HostTagSuggestions tags={tags}>
      <L4ProxyHostsClient
        hosts={hosts}
        pagination={{ total, page, perPage: PER_PAGE }}
        counts={counts}
        activeProtocol={protocol ?? "all"}
        initialSearch={search ?? ""}
        tags={tags}
        activeTag={tag ?? null}
        initialSort={{ sortBy: sortBy ?? "createdAt", sortDir }}
        agents={agents}
        accessLists={accessLists}
        hostDefaults={hostDefaults.l4ProxyHost}
        dynamicDnsProviders={dynamicDnsProviderOptions(dnsProviders)}
        canCreate={canCreate(access, "l4ProxyHost")}
        manageableIds={hosts.filter((h) => canManage(access, "l4ProxyHost", h.id)).map((h) => h.id)}
      />
    </HostTagSuggestions>
  );
}
