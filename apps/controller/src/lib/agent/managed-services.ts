/**
 * Starting and stopping the optional ClickHouse container from the Settings page, through the
 * agent's `docker compose --profile clickhouse`. Credentials travel with the request so they
 * live in the database, not a host `.env` the controller cannot read. Only the bundled agent is
 * asked: every other agent relays its events to the controller's ClickHouse.
 */

import type { ManagedServicesRequest } from "@cpm/shared";
import { findAgentRowByAgentId } from "../models/agents";
import { isAnalyticsEnabled } from "../clickhouse/client";
import { bundledAgentId } from "./bootstrap";
import { pushDesiredState } from "./desired-state";

/**
 * Whether this agent runs the controller's services. With no bundled agent recorded, every agent
 * is asked rather than a deployment losing its ClickHouse.
 */
async function runsControllerServices(agentRowId: number): Promise<boolean> {
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
    return { services: { clickhouse: false }, env: {} };
  }

  const [registry, { getSetting }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);

  const [analytics, user, password, database] = await Promise.all([
    isAnalyticsEnabled(),
    getSetting(registry.clickhouseUser),
    getSetting(registry.clickhousePassword),
    getSetting(registry.clickhouseDb),
  ]);

  return {
    services: { clickhouse: analytics },
    env: {
      CLICKHOUSE_USER: user,
      CLICKHOUSE_PASSWORD: password,
      CLICKHOUSE_DB: database,
    },
  };
}

/**
 * Ask every agent to reconcile its optional services; they travel as desired state with the
 * ports and modules. Never throws: an unattached agent gets the whole state when it reconnects.
 */
export async function applyManagedServices(): Promise<void> {
  await pushDesiredState();
}
