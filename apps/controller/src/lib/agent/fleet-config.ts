/** Desired state: sent on attach and on every change, so no agent sits on stale settings. */

import { type FleetConfig, LIVE_ANALYTICS_INTERVAL_SECONDS } from "@cpm/shared";
import { isAnalyticsEnabled } from "../clickhouse/client";
import { offlineModeEnabled } from "../offline";
import { caddyBuildTimeout } from "../settings/registry";
import { getSetting } from "../settings/resolve";
import { geoipFleetConfig } from "./geoip";
import { pushDesiredState } from "./desired-state";

export async function currentFleetConfig(): Promise<FleetConfig> {
  const { upstreamErrorsWanted } = await import("../notifications/upstream-errors");
  const [analytics, geoip, upstreamErrors, offline, buildTimeout] = await Promise.all([
    isAnalyticsEnabled(),
    geoipFleetConfig(),
    upstreamErrorsWanted().catch(() => false),
    offlineModeEnabled(),
    getSetting(caddyBuildTimeout),
  ]);
  // Agents relay analytics rather than writing to ClickHouse, so no credential goes out here.
  return {
    clickhouse: null,
    analytics,
    geoip,
    upstreamErrors,
    offline,
    analyticsIntervalSeconds: LIVE_ANALYTICS_INTERVAL_SECONDS,
    caddyBuildTimeoutSeconds: buildTimeout,
  };
}

/**
 * Just a desired-state push, kept by name for its dozen callers. Never throws: a detached agent
 * gets the whole state on reconnect.
 */
export async function pushFleetConfig(): Promise<void> {
  await pushDesiredState();
}
