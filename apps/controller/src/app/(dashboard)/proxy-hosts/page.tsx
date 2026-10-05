import ProxyHostsClient from "./ProxyHostsClient";
import {
  listProxyHostsPaginated,
  countProxyHosts,
  countProxyHostsByState,
  getProxyHost,
  getProxyHostsByIds,
  listProxyHostDomainRefs,
  listProxyHostTags,
} from "@/src/lib/models/proxy-hosts";
import { isAnalyticsEnabled } from "@/src/lib/clickhouse/client";
import {
  getTrafficForList,
  listInsights,
  sortIdsByRequests,
} from "@/src/lib/proxy-hosts/list-insights";
import { listCertificates } from "@/src/lib/models/certificates";
import { listCaCertificates } from "@/src/lib/models/ca-certificates";
import { listAccessLists } from "@/src/lib/models/access-lists";
import {
  getAuthentikSettings,
  getForwardAuthSettings,
  getGeneralSettings,
  getTailscaleSettings,
} from "@/src/lib/settings";
import { listMtlsRoles } from "@/src/lib/models/mtls-roles";
import { listIssuedClientCertificates } from "@/src/lib/models/issued-client-certificates";
import { listUsers } from "@/src/lib/models/user";
import { listGroups } from "@/src/lib/models/groups";
import { listWafPresets, toWafPresetOption } from "@/src/lib/models/waf-presets";
import { WafPresetOptionsProvider } from "@/src/components/proxy-hosts/waf/WafPresetOptions";
import { listCrsPlugins, toCrsPluginOption } from "@/src/lib/models/crs-plugins";
import { getForwardAuthAccessForHost } from "@/src/lib/models/forward-auth";
import { listAgentOptions } from "@/src/lib/agent/client";
import { agentIdsForHosts } from "@/src/lib/models/host-agents";
import {
  canCreate,
  canManage,
  canView,
  requireAccess,
  visibleIdFilter,
} from "@/src/lib/users/permissions";
import type { Metadata } from "next";
import { toCertificatePickerOption } from "@/src/lib/certificates/api";
import { getTranslations } from "next-intl/server";

const PER_PAGE = 25;

interface PageProps {
  searchParams: Promise<{
    page?: string;
    search?: string;
    sortBy?: string;
    sortDir?: string;
    state?: string;
    tag?: string;
    /** A host to open the editor on, from its page's section links. */
    edit?: string;
  }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("proxyHosts") };
}

export default async function ProxyHostsPage({ searchParams }: PageProps) {
  // Operators see hosts per grant. Null from visibleIdFilter means admin, hence not `?? []`.
  const access = await requireAccess();
  const visible = visibleIdFilter(access, "proxyHost");
  const visibleIds = visible === null ? null : [...visible];
  const {
    page: pageParam,
    search: searchParam,
    sortBy: sortByParam,
    sortDir: sortDirParam,
    state: stateParam,
    tag: tagParam,
    edit: editParam,
  } = await searchParams;
  const tag = tagParam?.trim().toLowerCase() || undefined;
  // Filtered in the query: client-side, "Disabled 2" shows nothing when both sit on a later page.
  const enabled = stateParam === "enabled" ? true : stateParam === "disabled" ? false : undefined;
  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const search = searchParam?.trim() || undefined;
  const offset = (page - 1) * PER_PAGE;
  const sortDir = sortDirParam === "asc" || sortDirParam === "desc" ? sortDirParam : "desc";
  // Busiest first when there is traffic to sort by. Not a column, so sorted here over the whole
  // filtered set and paged after.
  const analyticsOn = await isAnalyticsEnabled().catch(() => false);
  const sortBy = sortByParam || (analyticsOn ? "requests" : undefined);
  const refs = analyticsOn ? await listProxyHostDomainRefs(search, visibleIds, enabled, tag) : [];
  const traffic = analyticsOn
    ? await getTrafficForList(refs)
    : { available: false, byHost: new Map<number, never>() };
  const byRequests = sortBy === "requests" && traffic.available;
  const editId = Number.parseInt(editParam ?? "", 10);

  // The header counts the whole visible, searched set, not this page.
  const [
    hosts,
    total,
    counts,
    tags,
    certificates,
    caCertificates,
    accessLists,
    authentikDefaults,
    forwardAuthDefaults,
    tailscaleSettings,
    generalSettings,
    agents,
    // Safe to fail before the RBAC migration has run.
    mtlsRoles,
    issuedClientCerts,
    allUsers,
    allGroups,
    wafPresets,
    crsPlugins,
  ] = await Promise.all([
    byRequests
      ? getProxyHostsByIds(
          sortIdsByRequests(
            refs.map((ref) => ref.id),
            traffic.byHost,
            sortDir,
          ).slice(offset, offset + PER_PAGE),
        )
      : listProxyHostsPaginated(
          PER_PAGE,
          offset,
          search,
          sortBy,
          sortDir,
          visibleIds,
          enabled,
          tag,
        ),
    countProxyHosts(search, visibleIds, enabled, tag),
    countProxyHostsByState(search, visibleIds, tag),
    listProxyHostTags(visibleIds),
    listCertificates(),
    listCaCertificates(),
    listAccessLists(),
    getAuthentikSettings(),
    getForwardAuthSettings(),
    getTailscaleSettings(),
    getGeneralSettings(),
    listAgentOptions().catch(() => []),
    listMtlsRoles().catch(() => []),
    listIssuedClientCertificates().catch(() => []),
    listUsers().catch(() => []),
    listGroups().catch(() => []),
    listWafPresets(),
    listCrsPlugins(),
  ]);

  // The editor opened from a host's page, which may sit on another page of the list.
  const editHost = Number.isInteger(editId)
    ? (hosts.find((h) => h.id === editId) ??
      (canView(access, "proxyHost", editId) ? await getProxyHost(editId) : null))
    : null;
  const dialogHosts = editHost && !hosts.includes(editHost) ? [...hosts, editHost] : hosts;

  // Assignments for this page's hosts only, not the fleet. Insights are best-effort: unavailable
  // analytics drops the columns instead of failing the list.
  const faHosts = dialogHosts.filter((h) => h.cpmForwardAuth?.enabled);
  const [assignments, insights, faAccessEntries] = await Promise.all([
    agentIdsForHosts(
      "http",
      dialogHosts.map((host) => host.id),
    ).catch(() => new Map<number, number[]>()),
    listInsights({ pageHosts: hosts, traffic, certificates }).catch(
      () => ({ available: false }) as const,
    ),
    Promise.all(faHosts.map((h) => getForwardAuthAccessForHost(h.id).catch(() => []))),
  ]);
  const agentAssignments = Object.fromEntries(assignments);
  const forwardAuthAccessMap: Record<number, { userIds: number[]; groupIds: number[] }> = {};
  faHosts.forEach((h, i) => {
    const entries = faAccessEntries[i];
    forwardAuthAccessMap[h.id] = {
      userIds: entries.filter((e) => e.userId !== null).map((e) => e.userId!),
      groupIds: entries.filter((e) => e.groupId !== null).map((e) => e.groupId!),
    };
  });

  const forwardAuthUsers = allUsers.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
  }));
  const forwardAuthGroups = allGroups.map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    member_count: g.members.length,
  }));

  return (
    <WafPresetOptionsProvider
      presets={wafPresets.map(toWafPresetOption)}
      plugins={crsPlugins.map(toCrsPluginOption)}
    >
      <ProxyHostsClient
        hosts={hosts}
        certificates={certificates.map(toCertificatePickerOption)}
        caCertificates={caCertificates}
        accessLists={accessLists}
        authentikDefaults={authentikDefaults}
        forwardAuthDefaults={forwardAuthDefaults}
        // Empty before setup has run: the field just starts blank.
        defaultDomain={generalSettings?.defaultDomain ?? ""}
        // Never the key itself. Never null: unsaved settings mean off with no key, exactly when
        // the warnings matter, and null cannot tell "off" from "not known".
        tailscaleDefaults={{
          enabled: tailscaleSettings?.enabled ?? false,
          hasAuthKey: (tailscaleSettings?.authKey ?? "").trim().length > 0,
          defaultNode: tailscaleSettings?.defaultNode ?? "",
        }}
        pagination={{ total, page, perPage: PER_PAGE }}
        initialSearch={search ?? ""}
        tags={tags}
        activeTag={tag ?? null}
        activeState={stateParam === "enabled" || stateParam === "disabled" ? stateParam : "all"}
        initialSort={{
          sortBy: sortBy === "requests" && !byRequests ? "createdAt" : (sortBy ?? "createdAt"),
          sortDir,
        }}
        mtlsRoles={mtlsRoles}
        issuedClientCerts={issuedClientCerts}
        forwardAuthUsers={forwardAuthUsers}
        forwardAuthGroups={forwardAuthGroups}
        forwardAuthAccessMap={forwardAuthAccessMap}
        agents={agents}
        agentAssignments={agentAssignments}
        counts={counts}
        insights={insights}
        editTarget={editHost && canManage(access, "proxyHost", editHost.id) ? editHost : null}
        canCreate={canCreate(access)}
        manageableIds={dialogHosts
          .filter((h) => canManage(access, "proxyHost", h.id))
          .map((h) => h.id)}
        canEditRawConfig={access.isAdmin}
      />
    </WafPresetOptionsProvider>
  );
}
