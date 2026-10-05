/**
 * Live upstream health, read from each serving agent's Caddy (`/reverse_proxy/upstreams`) and
 * matched to one host's upstreams. Caddy's pool is keyed by dial address and shared by every host
 * dialling it, and it counts only passive-check failures: an active probe's verdict is not exposed.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { connectedAgents } from "../agent/registry";
import { caddyAdminRequest } from "../caddy/admin";
import { formatDialAddress, parseUpstreamTarget } from "../caddy/utils";
import { domainError } from "../errors/domain-error";
import { listAgents } from "../models/agents";
import { agentIdsForHost } from "../models/host-agents";
import { getProxyHost } from "../models/proxy-hosts";
import {
  type AgentUpstreams,
  type CaddyUpstreamStatus,
  type HostUpstreamHealth,
  decodeCaddyUpstreams,
  hostHealthChecks,
  summarizeUpstreamHealth,
} from "./upstream-health-summary";

export type * from "./upstream-health-summary";

const ADMIN_TIMEOUT_MS = 5000;
const LOOKUP_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function readUpstreams(agentId: string | undefined): Promise<CaddyUpstreamStatus[] | null> {
  try {
    // Raced as well: the agent transport drops `timeoutMs` and waits out the command timeout.
    const response = await withTimeout(
      caddyAdminRequest({
        path: "/reverse_proxy/upstreams",
        method: "GET",
        timeoutMs: ADMIN_TIMEOUT_MS,
        agentId,
      }),
      ADMIN_TIMEOUT_MS,
    );
    return response.status === 200 ? decodeCaddyUpstreams(response.text) : null;
  } catch {
    return null;
  }
}

export type HostnameLookup = (hostname: string) => Promise<string[]>;

const systemLookup: HostnameLookup = async (hostname) =>
  (await withTimeout(lookup(hostname, { all: true }), LOOKUP_TIMEOUT_MS)).map(
    (entry) => entry.address,
  );

/**
 * The dial Caddy is given, or, when no agent reports that, what a name resolves to here: DNS
 * pinning hands Caddy addresses at build time. A failed lookup only costs the extra candidates.
 */
async function candidateDials(
  upstream: string,
  reported: Set<string>,
  resolve: HostnameLookup,
): Promise<string[]> {
  const target = parseUpstreamTarget(upstream);
  if (reported.has(target.dial)) return [target.dial];
  if (!target.host || !target.port || isIP(target.host) !== 0) return [target.dial];
  const addresses = await resolve(target.host).catch(() => [] as string[]);
  return [
    target.dial,
    ...addresses.map((address) => formatDialAddress(address, target.port as string)),
  ];
}

/**
 * Every agent serving the host is asked: the ones it is pinned to, or the whole fleet. With no
 * agent paired at all, the unpinned request reaches a Caddy run without one.
 */
export async function getProxyHostUpstreamHealth(
  hostId: number,
  deps: { lookup?: HostnameLookup } = {},
): Promise<HostUpstreamHealth> {
  const host = await getProxyHost(hostId);
  if (!host) throw domainError("proxyHostNotFound", {}, { status: 404 });

  const [paired, pinned] = await Promise.all([listAgents(), agentIdsForHost("http", hostId)]);
  const serving = paired.filter(
    (agent) => agent.enabled && (pinned.length === 0 || pinned.includes(agent.id)),
  );
  const live = new Set(connectedAgents().map((agent) => agent.agentId));

  const answers: AgentUpstreams[] =
    paired.length === 0
      ? [{ agentId: null, name: null, entries: await readUpstreams(undefined) }]
      : await Promise.all(
          serving.map(async (agent) => ({
            agentId: agent.id,
            name: agent.name,
            entries: live.has(agent.agentId) ? await readUpstreams(agent.agentId) : null,
          })),
        );
  const reported = new Set(answers.flatMap((answer) => answer.entries ?? []).map((e) => e.address));
  const dials = await Promise.all(
    host.upstreams.map((u) => candidateDials(u, reported, deps.lookup ?? systemLookup)),
  );

  const checks = hostHealthChecks(host);
  return summarizeUpstreamHealth({
    hostId,
    upstreams: host.upstreams.map((upstream, index) => ({ upstream, dials: dials[index] })),
    healthChecks: checks.enabled,
    maxFails: checks.maxFails,
    answers,
  });
}
