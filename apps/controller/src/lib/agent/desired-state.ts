/**
 * Computed, not stored: each part already has a source of truth, and rebuilding on every push is
 * what makes "reconnect and re-send everything" a correct recovery path.
 */

import { type AgentDesiredState, expandL4PortMappings } from "@cpm/shared";
import { desiredManagedServices } from "./managed-services";
import { currentFleetConfig } from "./fleet-config";
import { getRequiredL4Ports } from "../l4/ports";
import { getCaddyBuildDiff } from "../caddy/image-build";
import { isSetupCompleted } from "../setup";
import { broadcastDesiredState, connectedAgents, sendDesiredState } from "./registry";
import { certificateFileSources } from "./certificate-file-sources";

/** Those that change what this module sends, so a newly learned one means a re-send. */
export const DESIRED_STATE_CAPABILITIES = ["certificate-files", "l4-port-ranges"] as const;

/** `agentRowId` scopes ports and modules to one agent; omitted gives the fleet-wide answer. */
export async function buildDesiredState(agentRowId?: number): Promise<AgentDesiredState> {
  const capabilities =
    agentRowId === undefined
      ? []
      : (connectedAgents().find((agent) => agent.agentRowId === agentRowId)?.status?.capabilities ??
        []);
  // Never to an agent that has not listed the capability: it would not know the field.
  const readsFiles = capabilities.includes("certificate-files");
  // An older agent's pattern refuses a range, and with it the whole port list. Before its first
  // status nothing is known, so it gets single ports too; the agent compares them as a set.
  const takesRanges = capabilities.includes("l4-port-ranges");
  const [l4Ports, buildDiff, services, fleetConfig, setupDone, certificateFiles] =
    await Promise.all([
      getRequiredL4Ports(agentRowId),
      getCaddyBuildDiff(agentRowId),
      desiredManagedServices(agentRowId),
      currentFleetConfig(),
      isSetupCompleted(),
      readsFiles && agentRowId !== undefined ? certificateFileSources(agentRowId) : null,
    ]);

  return {
    l4Ports: takesRanges ? l4Ports : expandL4PortMappings(l4Ports),
    caddyModules: buildDiff.desiredSpecs,
    services,
    fleetConfig,
    // Before setup there is nothing to serve, and a default page on 80/443 is worse than silence.
    caddyEnabled: setupDone,
    ...(certificateFiles === null ? {} : { certificateFiles }),
  };
}

/** For a change of one agent's capabilities: its first status can arrive after its first state. */
export async function pushDesiredStateTo(agent: { agentId: string; agentRowId: number }) {
  try {
    sendDesiredState(agent.agentId, await buildDesiredState(agent.agentRowId));
  } catch (error) {
    console.warn("[cpm] could not build desired state for agent:", agent.agentId, error);
  }
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
