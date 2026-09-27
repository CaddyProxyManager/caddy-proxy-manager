/** Desired state: sent on attach and on every change, so no agent sits on stale settings. */

import type { FleetConfig } from "@cpm/shared";
import { isAnalyticsEnabled } from "../clickhouse/client";
import { geoipFleetConfig } from "./geoip";
import { pushDesiredState } from "./desired-state";

export async function currentFleetConfig(): Promise<FleetConfig> {
  const [analytics, geoip] = await Promise.all([isAnalyticsEnabled(), geoipFleetConfig()]);
  // Agents relay analytics rather than writing to ClickHouse, so no credential goes out here.
  return { clickhouse: null, analytics, geoip };
}

/**
 * Just a desired-state push, kept by name for its dozen callers. Never throws: a detached agent
 * gets the whole state on reconnect.
 */
export async function pushFleetConfig(): Promise<void> {
  await pushDesiredState();
}
