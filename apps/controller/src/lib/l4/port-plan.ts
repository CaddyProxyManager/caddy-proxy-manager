/**
 * What enabled L4 hosts may claim between them. Hosts share a listener only on the exact same
 * listen string (`buildL4Servers` groups on it), so two different strings over one port make Caddy
 * fail to bind - and a failed load takes every host down with it, HTTP included.
 */

import { eq } from "drizzle-orm";
import db from "../db";
import { l4ProxyHosts } from "../db/schema";
import { type HostPortRange, splitHostPortRange } from "../caddy/utils";
import { domainError } from "../errors/domain-error";
import { listHostAssignments } from "../models/host-agents";

/** Caddy opens a listener per port and Docker a proxy process per port and address family. */
export const MAX_L4_PORTS_PER_HOST = 1000;
/** Keeps an agent's status report, which lists every published port, well inside its limits. */
export const MAX_L4_PORTS_PER_AGENT = 2000;

export type L4PortClaim = {
  /** Null for a host not created yet. */
  id: number | null;
  protocol: string;
  listenAddress: string;
  /** Empty means every agent. */
  agentIds: number[];
};

const WILDCARD_HOSTS = new Set(["", "0.0.0.0", "::"]);

function hostsOverlap(a: string, b: string): boolean {
  if (WILDCARD_HOSTS.has(a) || WILDCARD_HOSTS.has(b)) return true;
  return a.toLowerCase() === b.toLowerCase();
}

/** Pinned to disjoint agents, two hosts never meet on one Caddy. */
function shareAnAgent(a: number[], b: number[]): boolean {
  return a.length === 0 || b.length === 0 || a.some((id) => b.includes(id));
}

function firstSharedPort(a: HostPortRange, b: HostPortRange): number | null {
  const start = Math.max(a.start, b.start);
  return start <= Math.min(a.end, b.end) ? start : null;
}

type Parsed = L4PortClaim & { range: HostPortRange };

function parseClaims(claims: L4PortClaim[]): Parsed[] {
  return claims.flatMap((claim) => {
    const range = splitHostPortRange(claim.listenAddress);
    return range ? [{ ...claim, listenAddress: claim.listenAddress.trim(), range }] : [];
  });
}

/**
 * `changed` against each other and against `others`, the enabled hosts left as they are. Only
 * conflicts involving a changed host are refused, so an older clash never blocks unrelated saves.
 */
export function checkL4PortPlan(changed: L4PortClaim[], others: L4PortClaim[]): void {
  const mine = parseClaims(changed);
  const rest = parseClaims(others);

  mine.forEach((host, index) => {
    for (const other of [...mine.slice(index + 1), ...rest]) {
      if (host.protocol !== other.protocol || host.listenAddress === other.listenAddress) continue;
      if (!hostsOverlap(host.range.host, other.range.host)) continue;
      if (!shareAnAgent(host.agentIds, other.agentIds)) continue;
      const port = firstSharedPort(host.range, other.range);
      if (port !== null) throw domainError("l4ListenPortInUse", { port }, { status: 400 });
    }
  });

  // One bucket per pinned agent, plus one for an agent with no pins, which serves only the
  // unpinned hosts. Only the buckets a changed host lands in are checked.
  const all = [...mine, ...rest];
  const buckets = new Set<number | null>([null]);
  for (const host of all) for (const id of host.agentIds) buckets.add(id);
  for (const bucket of buckets) {
    const served = (host: Parsed) =>
      host.agentIds.length === 0 || (bucket !== null && host.agentIds.includes(bucket));
    if (!mine.some(served)) continue;
    const ports = new Set<string>();
    for (const host of all.filter(served)) {
      for (let port = host.range.start; port <= host.range.end; port++) {
        ports.add(`${host.protocol}/${port}`);
      }
    }
    if (ports.size > MAX_L4_PORTS_PER_AGENT) {
      throw domainError("l4AgentPortLimit", { max: MAX_L4_PORTS_PER_AGENT }, { status: 400 });
    }
  }
}

/** For hosts about to be enabled, or enabled ones whose port, protocol or agents change. */
export async function assertL4PortPlan(changed: L4PortClaim[]): Promise<void> {
  if (changed.length === 0) return;
  const changedIds = new Set(changed.flatMap((claim) => (claim.id === null ? [] : [claim.id])));
  const [rows, assignments] = await Promise.all([
    db
      .select({
        id: l4ProxyHosts.id,
        protocol: l4ProxyHosts.protocol,
        listenAddress: l4ProxyHosts.listenAddress,
      })
      .from(l4ProxyHosts)
      .where(eq(l4ProxyHosts.enabled, true)),
    listHostAssignments("l4"),
  ]);
  const others = rows
    .filter((row) => !changedIds.has(row.id))
    .map((row) => ({ ...row, agentIds: assignments.get(row.id) ?? [] }));
  checkL4PortPlan(changed, others);
}
