/**
 * Matching Caddy's `/reverse_proxy/upstreams` answers to one host's upstreams. Pure, so the docs
 * site can render it and the tests need no agent; `upstream-health.ts` does the asking.
 */

import type { ProxyHost } from "../models/proxy-hosts";

export type UpstreamHealthState = "healthy" | "failing" | "unchecked" | "unreported" | "unknown";

/** One entry of Caddy's answer. */
export type CaddyUpstreamStatus = { address: string; requests: number; fails: number };

/** `entries` null is an agent that is offline or did not answer: unknown, never failing. */
export type AgentUpstreams = {
  agentId: number | null;
  name: string | null;
  entries: CaddyUpstreamStatus[] | null;
};

export type UpstreamAgentHealth = {
  agentId: number | null;
  name: string | null;
  state: UpstreamHealthState;
  fails: number;
  requests: number;
};

export type UpstreamHealth = {
  upstream: string;
  /** The addresses Caddy dials for it; more than one when DNS pinning expands a name. */
  dials: string[];
  state: UpstreamHealthState;
  /** The most any agent reports. */
  fails: number;
  /** At or past the passive check's max fails on some agent, so Caddy skips it there. */
  outOfRotation: boolean;
  requests: number;
  agents: UpstreamAgentHealth[];
};

export type HostUpstreamHealth = {
  hostId: number;
  /** False when the host configures no health checks, so Caddy counts no failures. */
  healthChecks: boolean;
  maxFails: number;
  checkedAt: string;
  agents: { agentId: number | null; name: string | null; reachable: boolean }[];
  upstreams: UpstreamHealth[];
};

/** Caddy's answer, keeping only well-formed entries: an agent's reply is not trusted for shape. */
export function decodeCaddyUpstreams(text: string): CaddyUpstreamStatus[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const entries: CaddyUpstreamStatus[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const { address, num_requests: requests, fails } = item as Record<string, unknown>;
    if (typeof address !== "string") continue;
    entries.push({
      address,
      requests: typeof requests === "number" && requests > 0 ? requests : 0,
      fails: typeof fails === "number" && fails > 0 ? fails : 0,
    });
  }
  return entries;
}

/** Health checks as the config build emits them: only with load balancing on. */
export function hostHealthChecks(host: Pick<ProxyHost, "loadBalancer">): {
  enabled: boolean;
  maxFails: number;
} {
  const lb = host.loadBalancer?.enabled ? host.loadBalancer : null;
  const passive = lb?.passiveHealthCheck?.enabled ? lb.passiveHealthCheck : null;
  return {
    enabled: Boolean(lb?.activeHealthCheck?.enabled || passive),
    // Caddy's default; a stored 0 would mean the first failure takes it out, as 1 does.
    maxFails: Math.max(passive?.maxFails ?? 1, 1),
  };
}

const PRECEDENCE: UpstreamHealthState[] = ["failing", "healthy", "unchecked", "unreported"];

/** The fleet's answer for one upstream: any failing agent wins, and silence is only unknown. */
function mergeStates(states: UpstreamHealthState[]): UpstreamHealthState {
  return PRECEDENCE.find((state) => states.includes(state)) ?? "unknown";
}

/** Pure, so the matching and merging are tested without agents. */
export function summarizeUpstreamHealth(options: {
  hostId: number;
  upstreams: { upstream: string; dials: string[] }[];
  healthChecks: boolean;
  maxFails: number;
  answers: AgentUpstreams[];
  checkedAt?: string;
}): HostUpstreamHealth {
  const { healthChecks, maxFails, answers } = options;
  const upstreams = options.upstreams.map(({ upstream, dials }): UpstreamHealth => {
    const agents = answers.map((answer): UpstreamAgentHealth => {
      const base = { agentId: answer.agentId, name: answer.name };
      if (answer.entries === null) return { ...base, state: "unknown", fails: 0, requests: 0 };
      const matches = answer.entries.filter((entry) => dials.includes(entry.address));
      if (matches.length === 0) return { ...base, state: "unreported", fails: 0, requests: 0 };
      const fails = Math.max(...matches.map((entry) => entry.fails));
      const requests = matches.reduce((sum, entry) => sum + entry.requests, 0);
      const state = !healthChecks ? "unchecked" : fails > 0 ? "failing" : "healthy";
      return { ...base, state, fails, requests };
    });
    const fails = Math.max(0, ...agents.map((agent) => agent.fails));
    return {
      upstream,
      dials,
      state: mergeStates(agents.map((agent) => agent.state)),
      fails: healthChecks ? fails : 0,
      outOfRotation: healthChecks && fails >= maxFails,
      requests: agents.reduce((sum, agent) => sum + agent.requests, 0),
      agents,
    };
  });
  return {
    hostId: options.hostId,
    healthChecks,
    maxFails,
    checkedAt: options.checkedAt ?? new Date().toISOString(),
    agents: answers.map((answer) => ({
      agentId: answer.agentId,
      name: answer.name,
      reachable: answer.entries !== null,
    })),
    upstreams,
  };
}
