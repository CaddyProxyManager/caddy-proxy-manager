/**
 * Agent notifications: one gone longer than the threshold, and what an agent reports failing on
 * its own host. The registry is per process, so "gone" is timed from when this process first saw
 * it gone; after a restart every agent gets the whole threshold to reconnect.
 */

import type { AgentOperationStatus, AgentStatus } from "@cpm/shared";
import { isConnected } from "../agent/registry";
import { listAgents } from "../models/agents";
import type { AgentProblem, NotificationEvent } from "./events";
import { openProblemKeys, raiseProblem, resolveProblem } from "./index";

const OFFLINE = "agent-offline:";
const offlineSince = new Map<string, number>();

/** Test seam. */
export function resetAgentWatchForTests(): void {
  offlineSince.clear();
}

/** A tick: raise what has been gone long enough, and close what is back or no longer paired. */
export async function watchAgents(now: number): Promise<void> {
  const [registry, { getSetting }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);
  const minutes = await getSetting(registry.notifyAgentOfflineMinutes);
  const [agents, open] = await Promise.all([listAgents(), openProblemKeys(OFFLINE)]);
  const openKeys = new Set(open);
  const paired = new Set<string>();

  for (const agent of agents) {
    const key = `${OFFLINE}${agent.agentId}`;
    paired.add(key);
    // Never connected, or switched off on purpose: nothing was lost.
    const watched = agent.enabled && agent.lastSeenAt !== null;
    if (!watched || isConnected(agent.agentId)) {
      offlineSince.delete(agent.agentId);
      if (openKeys.has(key)) {
        await resolveProblem(key, watched ? { kind: "agentOnline", agent: agent.name } : null, now);
      }
      continue;
    }
    const since = offlineSince.get(agent.agentId) ?? now;
    offlineSince.set(agent.agentId, since);
    if (!openKeys.has(key) && now - since >= minutes * 60_000) {
      await raiseProblem(key, { kind: "agentOffline", agent: agent.name, minutes }, now);
    }
  }
  for (const key of openKeys) if (!paired.has(key)) await resolveProblem(key, null, now);
  for (const agentId of offlineSince.keys()) {
    if (!paired.has(`${OFFLINE}${agentId}`)) offlineSince.delete(agentId);
  }
}

/** Longer is the agent's own words, which reach an email. */
const MAX_DETAIL = 300;

function operation(status: AgentOperationStatus<string>): { state: string; detail: string | null } {
  const detail = (status.error ?? status.message ?? "").trim();
  return { state: status.state, detail: detail ? detail.slice(0, MAX_DETAIL) : null };
}

function problems(
  status: AgentStatus | null,
): Map<AgentProblem, { state: string; detail: string | null }> {
  const found = new Map<AgentProblem, { state: string; detail: string | null }>();
  if (!status) return found;
  found.set("caddyBuild", operation(status.caddyBuild.status));
  found.set("services", operation(status.services.status));
  found.set("l4Ports", operation(status.l4Ports.status));
  if (status.logAccess) {
    const paths = [...new Set(status.logAccess.problems.map((problem) => problem.path))];
    found.set("logAccess", {
      state: paths.length > 0 ? "failed" : "applied",
      detail: paths.length > 0 ? paths.join(", ").slice(0, MAX_DETAIL) : null,
    });
  }
  return found;
}

/**
 * From the status mutation: a failed operation is raised, an applied one resolves it. Only what
 * changed since the last report, which is null after a reconnect, so a restart re-reads it all.
 */
export async function reportAgentStatus(
  agent: { agentId: string; name: string },
  previous: AgentStatus | null,
  status: AgentStatus,
  now = Date.now(),
): Promise<void> {
  const before = problems(previous);
  for (const [problem, { state, detail }] of problems(status)) {
    const prior = before.get(problem);
    if (prior && prior.state === state && prior.detail === detail) continue;
    const key = `agent-problem:${agent.agentId}:${problem}`;
    if (state === "failed") {
      const event: NotificationEvent = { kind: "agentProblem", agent: agent.name, problem, detail };
      await raiseProblem(key, event, now);
    } else if (state === "applied") {
      await resolveProblem(key, { kind: "agentProblemResolved", agent: agent.name, problem }, now);
    }
  }
}
