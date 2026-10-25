/** The record sets proxy hosts and L4 hosts ask for, beside the ones in Settings. */

import { listAgents } from "../models/agents";
import { listHostAssignments } from "../models/host-agents";
import { listL4ProxyHosts } from "../models/l4-proxy-hosts";
import { listProxyHosts } from "../models/proxy-hosts";
import { getDnsProviderSettings, getDynamicDnsSettings } from "../settings";
import { bundledAgentId } from "../agent/bootstrap";
import {
  type DynamicDnsRecordSet,
  type DynamicDnsSettings,
  type HostDynamicDnsConfig,
  hostRecordNames,
  isDynamicDnsHostname,
} from "./dynamic-dns";

type HostSource = {
  enabled: boolean;
  config: HostDynamicDnsConfig | null;
  hostnames: string[];
  agentRowIds: number[];
};

/**
 * One agent per host, or two would flip the records between their addresses: the bundled agent
 * unless the host is pinned elsewhere, then the first agent it is pinned to.
 */
function hostAgent(
  agentRowIds: readonly number[],
  agentIdByRow: ReadonlyMap<number, string>,
  bundled: string | null,
): string | null {
  if (agentRowIds.length === 0) return null;
  const pinned = agentRowIds.flatMap((row) => agentIdByRow.get(row) ?? []);
  if (bundled && pinned.includes(bundled)) return null;
  return pinned[0] ?? null;
}

export async function hostDynamicDnsRecordSets(): Promise<DynamicDnsRecordSet[]> {
  const [httpHosts, l4Hosts, httpAssignments, l4Assignments, agents, bundled, dnsProviders] =
    await Promise.all([
      listProxyHosts(),
      listL4ProxyHosts(),
      listHostAssignments("http"),
      listHostAssignments("l4"),
      listAgents(),
      bundledAgentId(),
      getDnsProviderSettings(),
    ]);
  const agentIdByRow = new Map(agents.map((agent) => [agent.id, agent.agentId]));

  const sources: HostSource[] = [
    ...httpHosts.map((host) => ({
      enabled: host.enabled,
      config: host.dynamicDns,
      hostnames: host.domains.filter(isDynamicDnsHostname),
      agentRowIds: httpAssignments.get(host.id) ?? [],
    })),
    ...l4Hosts.map((host) => ({
      enabled: host.enabled,
      config: host.dynamicDns,
      hostnames: host.dynamicDns?.hostnames ?? [],
      agentRowIds: l4Assignments.get(host.id) ?? [],
    })),
  ];

  const sets: DynamicDnsRecordSet[] = [];
  for (const { enabled, config, hostnames, agentRowIds } of sources) {
    if (!enabled || !config?.enabled || !config.zone || hostnames.length === 0) continue;
    const provider = config.provider ?? dnsProviders?.default;
    if (!provider) continue;
    try {
      sets.push({
        provider,
        zone: config.zone,
        names: hostRecordNames(hostnames, config.zone),
        agentId: hostAgent(agentRowIds, agentIdByRow, bundled),
      });
    } catch {
      // A domain edited out of the zone since: skipped rather than failing every host's config.
    }
  }
  return sets;
}

/** The settings' own sets while switched on, plus every host's. */
export async function effectiveDynamicDnsSettings(
  settings?: DynamicDnsSettings,
): Promise<DynamicDnsSettings> {
  const [global, hostSets] = await Promise.all([
    settings ?? getDynamicDnsSettings(),
    hostDynamicDnsRecordSets(),
  ]);
  const recordSets = [...(global.enabled ? global.recordSets : []), ...hostSets];
  return { ...global, enabled: recordSets.length > 0, recordSets };
}

/** Whether anything wants the Dynamic DNS module, in Settings or on a host. */
export async function dynamicDnsInUse(): Promise<boolean> {
  return (await effectiveDynamicDnsSettings()).enabled;
}
