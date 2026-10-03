/**
 * What config may emit follows the modules an agent's Caddy carries, so a change is re-applied at
 * once rather than at the next save. An external-mode image load waits on exactly this: it narrows
 * the set and holds the recreate until a config without the dropped modules arrives. A port change
 * is re-applied too, for the Caddy it recreated.
 */

import { type AgentStatus, SHIPPED_CADDY_MODULES } from "@cpm/shared";
import { applyCaddyConfigToAgent } from "../caddy";
import { connectedAgents } from "./registry";

function moduleKey(status: AgentStatus): string {
  // Null is the shipped image, so a first rebuild to the same set is no change.
  return [...(status.caddyBuild.applied ?? SHIPPED_CADDY_MODULES)].sort().join("\n");
}

/** False for a first report: the monitor's first-sighting apply covers a newly connected agent. */
export function modulesChanged(previous: AgentStatus | null, next: AgentStatus): boolean {
  return previous !== null && moduleKey(previous) !== moduleKey(next);
}

/**
 * A port change recreates Caddy, which resumes from its autosave: a config sent while the old
 * container was stopping never reached it, and would otherwise wait for the monitor's next pass.
 */
export function portsReapplied(previous: AgentStatus | null, next: AgentStatus): boolean {
  const applied = next.l4Ports.status;
  return (
    previous !== null &&
    applied?.state === "applied" &&
    applied.appliedAt !== undefined &&
    applied.appliedAt !== previous.l4Ports.status?.appliedAt
  );
}

export function reapplyAfterRecreate(agentId: string): void {
  const agent = connectedAgents().find((candidate) => candidate.agentId === agentId);
  if (!agent) return;
  void applyCaddyConfigToAgent(agent).catch((error: unknown) => {
    console.error(`[agent] could not re-apply ${agent.name}'s config to its new Caddy:`, error);
  });
}
