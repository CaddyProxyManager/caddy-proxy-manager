/**
 * Starting and stopping the optional ClickHouse and CrowdSec containers from the Settings page,
 * through the agent's `docker compose --profile <name>`. Credentials travel with the request so
 * they live in the database, not a host `.env` the controller cannot read. Only the bundled agent
 * is asked: every other agent relays its events to the controller's ClickHouse, and bounces
 * against an external CrowdSec or none.
 */

import type { ManagedServiceName, ManagedServicesRequest, ManagedServicesState } from "@cpm/shared";
import { findAgentRowByAgentId } from "../models/agents";
import { isAnalyticsEnabled } from "../clickhouse/client";
import { wantsManagedCrowdSec } from "../caddy/crowdsec";
import { decryptSecret } from "../secrets";
import { bundledAgentId } from "./bootstrap";
import { pushDesiredState } from "./desired-state";
import { connectedAgents } from "./registry";

/**
 * Whether this agent runs the controller's services. With no bundled agent recorded, every agent
 * is asked rather than a deployment losing its ClickHouse.
 */
export async function runsControllerServices(agentRowId: number): Promise<boolean> {
  const bundled = await bundledAgentId();
  const row = bundled ? await findAgentRowByAgentId(bundled) : null;
  return row === null || row.id === agentRowId;
}

/**
 * What the optional services should be, from the settings alone. `agentRowId` scopes it to one
 * agent; omitted, it answers for the agent that runs them.
 */
export async function desiredManagedServices(agentRowId?: number): Promise<ManagedServicesRequest> {
  if (agentRowId !== undefined && !(await runsControllerServices(agentRowId))) {
    return { services: { clickhouse: false, crowdsec: false }, env: {} };
  }

  const [registry, { getSetting }, { getCrowdSecSettings }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
    import("../settings"),
  ]);

  const [analytics, user, password, database, crowdsec] = await Promise.all([
    isAnalyticsEnabled(),
    getSetting(registry.clickhouseUser),
    getSetting(registry.clickhousePassword),
    getSetting(registry.clickhouseDb),
    getCrowdSecSettings(),
  ]);

  return {
    services: { clickhouse: analytics, crowdsec: wantsManagedCrowdSec(crowdsec) },
    env: {
      CLICKHOUSE_USER: user,
      CLICKHOUSE_PASSWORD: password,
      CLICKHOUSE_DB: database,
      // Sent while off too, so a stop interpolates the file as the last start did.
      ...(crowdsec.managedApiKey
        ? {
            CROWDSEC_BOUNCER_KEY: decryptSecret(crowdsec.managedApiKey, "CrowdSec bouncer key"),
          }
        : {}),
      CROWDSEC_DISABLE_ONLINE_API: crowdsec.onlineApi ? "false" : "true",
    },
  };
}

/** One managed service as the agent running it last reported; null with no such agent connected. */
export type ManagedServiceView = {
  agent: string;
  running: boolean;
  state: ManagedServicesState;
  /** The agent's own words, in English like the rest of its status. */
  message: string | null;
};

export async function managedServiceView(
  name: ManagedServiceName,
): Promise<ManagedServiceView | null> {
  for (const agent of connectedAgents()) {
    if (!agent.status || !(await runsControllerServices(agent.agentRowId))) continue;
    const { applied, status } = agent.status.services;
    return {
      agent: agent.name,
      running: applied?.[name] === true,
      state: status.state,
      message: status.error ?? status.message ?? null,
    };
  }
  return null;
}

/**
 * Ask every agent to reconcile its optional services; they travel as desired state with the
 * ports and modules. Never throws: an unattached agent gets the whole state when it reconnects.
 */
export async function applyManagedServices(): Promise<void> {
  await pushDesiredState();
}
