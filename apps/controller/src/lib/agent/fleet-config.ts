/** Desired state: sent on attach and on every change, so no agent sits on stale settings. */

import type { FleetConfig } from "@cpm/shared";
import { isAnalyticsEnabled } from "../clickhouse/client";
import { geoipFleetConfig } from "./geoip";
import { pushDesiredState } from "./desired-state";

export async function currentFleetConfig(): Promise<FleetConfig> {
  const { upstreamErrorsWanted } = await import("../notifications/upstream-errors");
  const [analytics, geoip, upstreamErrors] = await Promise.all([
    isAnalyticsEnabled(),
    geoipFleetConfig(),
    upstreamErrorsWanted().catch(() => false),
  ]);
  // Agents relay analytics rather than writing to ClickHouse, so no credential goes out here.
  return { clickhouse: null, analytics, geoip, upstreamErrors };
}

/**
 * Just a desired-state push, kept by name for its dozen callers. Never throws: a detached agent
 * gets the whole state on reconnect.
 */
export async function pushFleetConfig(): Promise<void> {
  await pushDesiredState();
}
