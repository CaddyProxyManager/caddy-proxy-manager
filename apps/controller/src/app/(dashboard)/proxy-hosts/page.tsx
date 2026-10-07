import ProxyHostsClient from "./ProxyHostsClient";
import { revisionForEditor } from "@/src/lib/host-history";
import { strictId } from "@/src/lib/http/strict-id";
import { HostTagSuggestions } from "@/components/proxy-hosts/HostTagsField";
import {
  listProxyHostsPaginated,
  countProxyHostsByState,
  getProxyHost,
  proxyHostFromRow,
  getProxyHostsByIds,
  listProxyHostDomainRefs,
  listProxyHostTags,
} from "@/src/lib/models/proxy-hosts";
import { isAnalyticsEnabled } from "@/src/lib/clickhouse/client";
import {
  getTrafficForList,
  listInsights,
  sortIdsByRequests,
  startListInsightInputs,
} from "@/src/lib/proxy-hosts/list-insights";
import { listCertificateSummaries } from "@/src/lib/models/certificates";
import { listAgentOptions } from "@/src/lib/agent/client";
import { agentIdsForHosts } from "@/src/lib/models/host-agents";
import {
  canCreate,
  canManage,
  canView,
  requireReach,
  visibleIdFilter,
  can,
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
    /** With `edit`: a revision of that host to load instead, for a rollback. */
    revision?: string;
  }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("proxyHosts") };
}

export default async function ProxyHostsPage({ searchParams }: PageProps) {
  // Operators see hosts per grant. Null from visibleIdFilter means admin, hence not `?? []`.
  const access = await requireReach("hosts:read");
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
    revision: revisionParam,
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
  const editId = Number.parseInt(editParam ?? "", 10);

  // Everything independent starts now; the insights' slow inputs (signals, the agents' certificate
  // inventory) run under their budgets alongside the list rather than after it.
  const insightInputs = analyticsOn ? startListInsightInputs() : undefined;
  insightInputs?.catch(() => {});
  const listed = () =>
    listProxyHostsPaginated(PER_PAGE, offset, search, sortBy, sortDir, visibleIds, enabled, tag);
  const pageByCreated = sortBy === "requests" ? null : listed();
  // Awaited below; this only keeps a failure while something else is awaited from going unhandled.
  pageByCreated?.catch(() => {});
  const trafficPromise = (async () => {
    const refs = analyticsOn ? await listProxyHostDomainRefs(search, visibleIds, enabled, tag) : [];
    const traffic = analyticsOn
      ? await getTrafficForList(refs)
      : { available: false, byHost: new Map<number, never>() };
    return { refs, traffic };
  })();
  const [{ refs, traffic }, counts, tags, certificates, agents] = await Promise.all([
    trafficPromise,
    // The header counts the whole visible, searched set, not this page; the tab's own count is
    // the total under its state filter.
    countProxyHostsByState(search, visibleIds, tag),
    listProxyHostTags(visibleIds),
    listCertificateSummaries(),
    listAgentOptions().catch(() => []),
  ]);
  const byRequests = sortBy === "requests" && traffic.available;
  const hosts = byRequests
    ? await getProxyHostsByIds(
        sortIdsByRequests(
          refs.map((ref) => ref.id),
          traffic.byHost,
          sortDir,
        ).slice(offset, offset + PER_PAGE),
      )
    : await (pageByCreated ?? listed());
  const total = enabled === undefined ? counts.total : enabled ? counts.enabled : counts.disabled;

  // The editor opened from a host's page, which may sit on another page of the list.
  const editHost = Number.isInteger(editId)
    ? (hosts.find((h) => h.id === editId) ??
      (canView(access, "proxyHost", editId) ? await getProxyHost(editId) : null))
    : null;
  const dialogHosts = editHost && !hosts.includes(editHost) ? [...hosts, editHost] : hosts;
  const managed = editHost && canManage(access, "proxyHost", editHost.id) ? editHost : null;
  const revisionId = strictId(revisionParam);
  const rollback =
    managed && revisionId !== undefined
      ? await revisionForEditor("http", managed.id, revisionId)
      : null;

  // Assignments for this page's hosts only, not the fleet. Insights are best-effort: unavailable
  // analytics drops the columns instead of failing the list.
  const [assignments, insights] = await Promise.all([
    agentIdsForHosts(
      "http",
      dialogHosts.map((host) => host.id),
    ).catch(() => new Map<number, number[]>()),
    listInsights({ pageHosts: hosts, traffic, certificates, inputs: insightInputs }).catch(
      () => ({ available: false }) as const,
    ),
  ]);
  const agentAssignments = Object.fromEntries(assignments);
  if (managed && rollback) agentAssignments[managed.id] = rollback.snapshot.agentIds;

  return (
    <HostTagSuggestions tags={tags}>
      <ProxyHostsClient
        hosts={hosts}
        certificates={certificates.map(toCertificatePickerOption)}
        pagination={{ total, page, perPage: PER_PAGE }}
        initialSearch={search ?? ""}
        tags={tags}
        activeTag={tag ?? null}
        activeState={stateParam === "enabled" || stateParam === "disabled" ? stateParam : "all"}
        initialSort={{
          sortBy: sortBy === "requests" && !byRequests ? "createdAt" : (sortBy ?? "createdAt"),
          sortDir,
        }}
        agents={agents}
        agentAssignments={agentAssignments}
        counts={counts}
        insights={insights}
        editTarget={
          managed && rollback
            ? { ...proxyHostFromRow(rollback.snapshot.row), id: managed.id }
            : managed
        }
        rollback={
          rollback && revisionId !== undefined ? { revisionId, missing: rollback.missing } : null
        }
        canCreate={canCreate(access, "proxyHost")}
        manageableIds={dialogHosts
          .filter((h) => canManage(access, "proxyHost", h.id))
          .map((h) => h.id)}
        canEditRawConfig={can(access, "settings:write")}
      />
    </HostTagSuggestions>
  );
}
