/**
 * Everything the host page shows, gathered on the server. Traffic is best-effort: with analytics
 * off (or ClickHouse down) it is null and the page keeps to the host's configuration.
 */

import { collectAttention } from "../attention";
import { type Access, can } from "../users/permissions";
import type { ProxyHost } from "../models/proxy-hosts";
import type { HostTrafficReport } from "../clickhouse/host-traffic";
import { HOST_AUDIT_LIMIT, healthChecksOf, type ProxyHostDetail } from "./detail-types";
import { hostProtections } from "./protections";
import { sectionSummaries } from "./section-summary";
import { hostStatus, hostTrafficNames, problemsFromAttention } from "./traffic-status";

export * from "./detail-types";

export async function getHostTrafficReport(
  host: Pick<ProxyHost, "domains">,
  now = Date.now(),
): Promise<HostTrafficReport | null> {
  const [{ isAnalyticsEnabled }, { queryHostTraffic }] = await Promise.all([
    import("../clickhouse/client"),
    import("../clickhouse/host-traffic"),
  ]);
  try {
    if (!(await isAnalyticsEnabled())) return null;
    const to = Math.floor(now / 1000);
    return await queryHostTraffic({ from: to - 86400, to }, hostTrafficNames(host.domains));
  } catch (error) {
    console.warn("[proxy-hosts] could not read a host's traffic:", error);
    return null;
  }
}

export async function getProxyHostDetail(
  host: ProxyHost,
  access: Access,
  now = Date.now(),
): Promise<ProxyHostDetail> {
  const [
    { listCertificateSummaries },
    { listAccessLists },
    { agentIdsForHost },
    { listAgentOptions },
    { getCrowdSecSettings },
    expiry,
    { listAuditEvents },
  ] = await Promise.all([
    import("../models/certificates"),
    import("../models/access-lists"),
    import("../models/host-agents"),
    import("../agent/client"),
    import("../settings"),
    import("../certificates/expiry"),
    import("../models/audit"),
  ]);

  const [attention, traffic, certificates, accessLists, agentIds, agents, crowdsec, audit, days] =
    await Promise.all([
      collectAttention(access, { proxyHostId: host.id, now }),
      getHostTrafficReport(host, now),
      listCertificateSummaries(),
      listAccessLists().catch(() => []),
      agentIdsForHost("http", host.id).catch(() => [] as number[]),
      listAgentOptions().catch(() => []),
      getCrowdSecSettings().catch(() => null),
      can(access, "audit:read")
        ? listAuditEvents(HOST_AUDIT_LIMIT, 0, { entityType: "proxy_host", entityId: host.id })
        : Promise.resolve([]),
      expiry.certificateTroubleDays().catch(() => expiry.DEFAULT_TROUBLE_DAYS),
    ]);

  const imported = new Map(
    certificates.flatMap((c) => {
      const found = expiry.importedExpiry(c);
      return found ? [[c.id, found] as const] : [];
    }),
  );
  const managed = host.certificateId === null ? await expiry.managedCertificates(2000) : null;
  const found = expiry.hostCertificate(host, imported, managed, days, now);
  const ownCertificate = certificates.find((c) => c.id === host.certificateId) ?? null;
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));

  return {
    host,
    status: hostStatus(host, problemsFromAttention(attention.items)),
    attention,
    traffic,
    certificate: found
      ? {
          name: found.expiry.name,
          managed: found.expiry.managed,
          notAfter: found.expiry.notAfter,
          daysLeft: found.daysLeft,
          stage: found.stage,
        }
      : null,
    protections: hostProtections(host, crowdsec?.enabled ?? false),
    sections: sectionSummaries(host, {
      certificateName: ownCertificate?.name ?? null,
      accessListName: accessLists.find((list) => list.id === host.accessListId)?.name ?? null,
      agentNames: agentIds.map((id) => agentNames.get(id) ?? `#${id}`),
      crowdsecActive: crowdsec?.enabled ?? false,
    }),
    healthChecks: healthChecksOf(host),
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
