/** Desired state: sent on attach and on every change, so no agent sits on stale settings. */

import { type FleetConfig, LIVE_ANALYTICS_INTERVAL_SECONDS } from "@cpm/shared";
import { isAnalyticsEnabled } from "../clickhouse/client";
import { offlineModeEnabled } from "../offline";
import { caddyBuildTimeout } from "../settings/registry";
import { getSetting } from "../settings/resolve";
import { geoipFleetConfig } from "./geoip";
import { pushDesiredState } from "./desired-state";

export async function currentFleetConfig(): Promise<FleetConfig> {
  // Imported here: lib/settings reaches most of the app, and a test mocking ClickHouse with it.
  const [{ upstreamErrorsWanted }, { getLoggingSettings }] = await Promise.all([
    import("../notifications/upstream-errors"),
    import("../settings"),
  ]);
  const [analytics, geoip, upstreamErrors, offline, buildTimeout, logging] = await Promise.all([
    isAnalyticsEnabled(),
    geoipFleetConfig(),
    upstreamErrorsWanted().catch(() => false),
    offlineModeEnabled(),
    getSetting(caddyBuildTimeout),
    getLoggingSettings().catch(() => null),
  ]);
  // Agents relay analytics rather than writing to ClickHouse, so no credential goes out here.
  return {
    clickhouse: null,
    analytics,
    geoip,
    upstreamErrors,
    // Stored in the analytics tables, so without them there is nowhere to send a row.
    l4Connections: analytics && logging?.l4Connections === true,
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
