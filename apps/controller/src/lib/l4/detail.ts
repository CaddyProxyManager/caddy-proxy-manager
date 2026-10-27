/** Everything an L4 host's page shows, gathered on the server. */

import type { L4ProxyHost } from "../models/l4-proxy-hosts";
import { HOST_AUDIT_LIMIT, type HostAuditEntry } from "../proxy-hosts/detail-types";
import { type Access, can } from "../users/permissions";
import { type L4HostDetail, l4HealthChecksOf } from "./detail-types";
import { l4SectionSummaries } from "./section-summary";

export * from "./detail-types";

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

  const [accessLists, agentIds, agents, crowdsec, audit] = await Promise.all([
    listL4AccessListOptions().catch(() => []),
    agentIdsForHost("l4", host.id).catch(() => [] as number[]),
    listAgentOptions().catch(() => []),
    getCrowdSecSettings().catch(() => null),
    can(access, "audit:read")
      ? listAuditEvents(HOST_AUDIT_LIMIT, 0, { entityType: "l4_proxy_host", entityId: host.id })
      : Promise.resolve([]),
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
