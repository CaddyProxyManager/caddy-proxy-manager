/**
 * Published ports are fixed at container creation, so an L4 host's port cannot go over the Caddy
 * admin API: the controller works out what the enabled hosts need and the agent recreates Caddy.
 */

import { type L4PortsStatus, sameL4PortSet } from "@cpm/shared";
import { eq } from "drizzle-orm";
import db from "../db";
import { isReservedL4ListenAddress, reservedL4Port, splitHostPortRange } from "../caddy/utils";
import { getMetricsSettings } from "../settings";
import { l4ProxyHosts } from "../db/schema";
import { listHostAssignments, servedByAgent } from "../models/host-agents";
import { isAgentAvailable, requestL4Ports, tryGetAgentStatus } from "../agent/client";

export type { L4PortsStatus };
export { isAgentAvailable };

export type L4PortsDiff = {
  currentPorts: string[];
  requiredPorts: string[];
  needsApply: boolean;
};

/** Per agent when given: a host pinned elsewhere must not make this one recreate its Caddy. */
export async function getRequiredL4Ports(agentRowId?: number): Promise<string[]> {
  const allHosts = await db
    .select({
      id: l4ProxyHosts.id,
      listenAddress: l4ProxyHosts.listenAddress,
      protocol: l4ProxyHosts.protocol,
    })
    .from(l4ProxyHosts)
    .where(eq(l4ProxyHosts.enabled, true));

  const hosts =
    agentRowId === undefined
      ? allHosts
      : await (async () => {
          const assignments = await listHostAssignments("l4");
          return allHosts.filter((host) => servedByAgent(assignments, host.id, agentRowId));
        })();

  const metrics = await getMetricsSettings();
  const metricsPort = metrics?.enabled ? (metrics.port ?? 9090) : null;
  const ports = { tcp: new Set<number>(), udp: new Set<number>() };
  for (const host of hosts) {
    // Not a trailing-colon match: an unbracketed IPv6 literal ends in something that looks like a
    // port, and publishing that number would open a port nobody asked for.
    const parsed = splitHostPortRange(host.listenAddress);
    if (!parsed) continue;
    // validateL4Input refuses these; a row that predates the check must still not publish one.
    // buildL4Servers leaves the same rows out of the document.
    if (isReservedL4ListenAddress(host.listenAddress, metricsPort)) {
      console.warn(
        `Not publishing reserved port ${reservedL4Port(parsed, metricsPort)} for L4 proxy host ${host.id}; change its listen address.`,
      );
      continue;
    }
    // Docker publishes a port on every address family the network has; the listen address's own
    // host part is Caddy's business, inside the container.
    const set = host.protocol === "udp" ? ports.udp : ports.tcp;
    for (let port = parsed.start; port <= parsed.end; port++) set.add(port);
  }

  // Merged into runs: two hosts on overlapping ranges must not publish a port twice.
  return [...portRuns(ports.tcp, ""), ...portRuns(ports.udp, "/udp")].sort();
}

function portRuns(ports: Set<number>, suffix: string): string[] {
  const sorted = [...ports].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    const span = sorted[i] === sorted[j] ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`;
    runs.push(`${span}:${span}${suffix}`);
    i = j + 1;
  }
  return runs;
}

/**
 * Empty without an agent, so every enabled host shows as needing an apply - honest, since nothing
 * can be published without one.
 */
export async function getAppliedL4Ports(): Promise<string[]> {
  const status = await tryGetAgentStatus();
  return status?.l4Ports.applied ?? [];
}

/** Whether the current L4 proxy host config differs from what is published. */
export async function getL4PortsDiff(): Promise<L4PortsDiff> {
  const [requiredPorts, currentPorts] = await Promise.all([
    getRequiredL4Ports(),
    getAppliedL4Ports(),
  ]);
  return {
    currentPorts,
    requiredPorts,
    // An older agent reports ranges port by port.
    needsApply: !sameL4PortSet(requiredPorts, currentPorts),
  };
}

/**
 * Returns once the agent accepts the work, not when the container is back: holding the request
 * through a recreate would time out the browser. Poll the returned status.
 */
export async function applyL4Ports(): Promise<L4PortsStatus> {
  return requestL4Ports(await getRequiredL4Ports());
}

/** The agent's last word on the port apply. */
export async function getL4PortsStatus(): Promise<L4PortsStatus> {
  const status = await tryGetAgentStatus();
  return status?.l4Ports.status ?? { state: "idle" };
}
