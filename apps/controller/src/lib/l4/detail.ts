/** Everything an L4 host's page shows, gathered on the server. */

import { splitHostPortRange } from "../caddy/utils";
import type { L4ProxyHost } from "../models/l4-proxy-hosts";
import { HOST_AUDIT_LIMIT, type HostAuditEntry } from "../proxy-hosts/detail-types";
import { type Access, can } from "../users/permissions";
import { type L4HostDetail, type L4HostTraffic, l4HealthChecksOf } from "./detail-types";
import { l4SectionSummaries } from "./section-summary";

export * from "./detail-types";

/** The last day, by port: best-effort, so a ClickHouse outage reads as nothing recorded. */
export async function getL4HostTraffic(
  host: Pick<L4ProxyHost, "id" | "protocol" | "listenAddress">,
  now = Date.now(),
): Promise<L4HostTraffic> {
  const [{ isAnalyticsEnabled }, { queryL4Traffic }, { getLoggingSettings }, { listL4ProxyHosts }] =
    await Promise.all([
      import("../clickhouse/client"),
      import("../clickhouse/l4-traffic"),
      import("../settings"),
      import("../models/l4-proxy-hosts"),
    ]);
  const range = splitHostPortRange(host.listenAddress);
  try {
    const [analytics, logging] = await Promise.all([isAnalyticsEnabled(), getLoggingSettings()]);
    if (!range || !analytics || logging?.l4Connections !== true) return { state: "off" };
    const ports = { protocol: host.protocol, start: range.start, end: range.end };
    const to = Math.floor(now / 1000);
    const [report, others] = await Promise.all([
      queryL4Traffic({ from: to - 86400, to }, ports),
      listL4ProxyHosts(),
    ]);
    const sharedWith = others.filter((other) => {
      if (other.id === host.id || !other.enabled || other.protocol !== host.protocol) return false;
      const theirs = splitHostPortRange(other.listenAddress);
      return theirs !== null && theirs.start <= range.end && range.start <= theirs.end;
    }).length;
    return { state: "on", report, sharedWith };
  } catch (error) {
    console.warn("[l4] could not read a host's connections:", error);
    return { state: "off" };
  }
}

export async function getL4HostDetail(
  host: L4ProxyHost,
  access: Access,
): Promise<L4HostDetail & { audit: HostAuditEntry[] }> {
  const [
    { listL4AccessListOptions },
    { agentIdsForHost },
    { listAgentOptions },
    { getCrowdSecSettings },
    { listAuditEvents },
  ] = await Promise.all([
    import("../models/access-lists"),
    import("../models/host-agents"),
    import("../agent/client"),
    import("../settings"),
    import("../models/audit"),
  ]);

  const [accessLists, agentIds, agents, crowdsec, audit, traffic] = await Promise.all([
    listL4AccessListOptions().catch(() => []),
    agentIdsForHost("l4", host.id).catch(() => [] as number[]),
    listAgentOptions().catch(() => []),
    getCrowdSecSettings().catch(() => null),
    can(access, "audit:read")
      ? listAuditEvents(HOST_AUDIT_LIMIT, 0, { entityType: "l4_proxy_host", entityId: host.id })
      : Promise.resolve([]),
    getL4HostTraffic(host),
  ]);
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));

  return {
    host,
    sections: l4SectionSummaries(host, {
      accessListName: accessLists.find((list) => list.id === host.accessListId)?.name ?? null,
      agentNames: agentIds.map((id) => agentNames.get(id) ?? `#${id}`),
      crowdsecActive: crowdsec?.enabled ?? false,
    }),
    healthChecks: l4HealthChecksOf(host),
    traffic,
    audit: audit.map((event) => ({
      id: event.id,
      userId: event.userId,
      action: event.action,
      entityType: event.entityType,
      summary: event.summary,
      createdAt: event.createdAt,
    })),
  };
}
