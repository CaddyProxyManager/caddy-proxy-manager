/**
 * Computed, not stored: each part already has a source of truth, and rebuilding on every push is
 * what makes "reconnect and re-send everything" a correct recovery path.
 */

import type { AgentDesiredState } from "@cpm/shared";
import { desiredManagedServices } from "./managed-services";
import { currentFleetConfig } from "./fleet-config";
import { getRequiredL4Ports } from "../l4-ports";
import { getCaddyBuildDiff } from "../caddy-build";
import { isSetupCompleted } from "../setup";
import { broadcastDesiredState } from "./registry";

/** `agentRowId` scopes ports and modules to one agent; omitted gives the fleet-wide answer. */
export async function buildDesiredState(agentRowId?: number): Promise<AgentDesiredState> {
  const [l4Ports, buildDiff, services, fleetConfig, setupDone] = await Promise.all([
    getRequiredL4Ports(agentRowId),
    getCaddyBuildDiff(agentRowId),
    desiredManagedServices(agentRowId),
    currentFleetConfig(),
    isSetupCompleted(),
  ]);

  return {
    l4Ports,
    caddyModules: buildDiff.desiredSpecs,
    services,
    fleetConfig,
    // Before setup there is nothing to serve, and a default page on 80/443 is worse than silence.
    caddyEnabled: setupDone,
  };
}

/**
 * Fire-and-forget: a proxy host save must not fail because one agent's stream just dropped, as it
 * gets the full state on reconnect. Computed and caught per agent for the same reason.
 */
export async function pushDesiredState(): Promise<void> {
  await broadcastDesiredState(async (agent) => {
    try {
      return await buildDesiredState(agent.agentRowId);
    } catch (error) {
      // The agent chose its own name, so it must not become part of the format string.
      console.warn("[cpm] could not build desired state for agent:", agent.name, error);
      return null;
    }
  });
}
