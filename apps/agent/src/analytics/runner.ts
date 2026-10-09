/**
 * Starts and stops the log parsers from the controller's pushed flags, so a deployment that never
 * enables analytics or the upstream error notification never opens a log file. The access log
 * serves both; the WAF log only analytics.
 */

import {
  DEFAULT_ANALYTICS_INTERVAL_SECONDS,
  type FleetConfig,
  MAX_ANALYTICS_INTERVAL_SECONDS,
  MIN_ANALYTICS_INTERVAL_SECONDS,
} from "@cpm/shared";
import type { AgentStore } from "../db";
import { ControllerClient } from "../controller-client";
import {
  type AnalyticsSink,
  analyticsEnabled,
  configureAnalytics,
  upstreamErrorsEnabled,
} from "./relay";
import { geoipControllerUrl, syncGeoipDatabases } from "./geoip";
import {
  initLogParser,
  parseNewLogEntries,
  stopLogParser,
  bindStore as bindTrafficStore,
} from "./log-parser";
import {
  initWafLogParser,
  parseNewWafLogEntries,
  stopWafLogParser,
  bindStore as bindWafStore,
} from "./waf-log-parser";

/** Applied by the next `applyFleetConfig`; a restart of the timers keeps their parsers' offsets. */
let parseIntervalMs = DEFAULT_ANALYTICS_INTERVAL_SECONDS * 1000;

/** Clamped: a pushed value this agent cannot honour falls back to the slow, safe cadence. */
export function parseIntervalFor(seconds: unknown): number {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return DEFAULT_ANALYTICS_INTERVAL_SECONDS * 1000;
  }
  const clamped = Math.min(
    MAX_ANALYTICS_INTERVAL_SECONDS,
    Math.max(MIN_ANALYTICS_INTERVAL_SECONDS, seconds),
  );
  return Math.round(clamped * 1000);
}

let accessTimer: NodeJS.Timeout | null = null;
let wafTimer: NodeJS.Timeout | null = null;

/** MaxMind publishes a couple of times a week. */
const GEOIP_REFRESH_MS = 24 * 60 * 60_000;

let geoipTimer: NodeJS.Timeout | null = null;

/**
 * Idempotent: pushed on every startup and settings change, and a repeat must not restart a working
 * parser. `controllerId` picks the secret the GeoIP fetch and relay are signed with.
 */
export async function applyFleetConfig(
  store: AgentStore,
  config: FleetConfig,
  controllerId: string,
): Promise<void> {
  bindTrafficStore(store);
  bindWafStore(store);

  const analytics = config.analytics === true;
  const upstreamErrors = config.upstreamErrors === true;
  configureAnalytics(analytics || upstreamErrors ? analyticsSink(store, controllerId) : null, {
    analytics,
    upstreamErrors,
  });
  parseIntervalMs = parseIntervalFor(config.analyticsIntervalSeconds);
  await syncParsers(analyticsEnabled() || upstreamErrorsEnabled(), analyticsEnabled());

  scheduleGeoipSync(store, config, controllerId);
}

/** The agent beside the controller fetches too: Caddy reads the agent's copy. */
function scheduleGeoipSync(store: AgentStore, config: FleetConfig, controllerId: string): void {
  if (geoipTimer) {
    clearInterval(geoipTimer);
    geoipTimer = null;
  }
  const geoip = config.geoip;
  if (!geoip || geoip.editions.length === 0) return;

  const secret = store.findController(controllerId)?.secret;
  if (!secret) return;
  const agentId = store.agentId();
  const controllerUrl = geoipControllerUrl(store.pairedControllerUrl(), geoip.url);

  const run = () => {
    void syncGeoipDatabases(store, controllerUrl, geoip.editions, agentId, secret).catch(
      (error: unknown) => {
        console.warn("[geoip] sync failed:", error);
      },
    );
  };
  run();
  geoipTimer = setInterval(run, GEOIP_REFRESH_MS);
  geoipTimer.unref();
}

function analyticsSink(store: AgentStore, controllerId: string): AnalyticsSink | null {
  const secret = store.findController(controllerId)?.secret;
  const url = store.pairedControllerUrl();
  if (!secret || !url) return null;
  return { client: new ControllerClient(url, store.agentId()), secret };
}

/**
 * A parse that throws must not kill its interval and silently stop the parser, and one slower than
 * the interval is waited for rather than overlapped, which would read the same offset twice.
 */
function parseEvery(label: string, parse: () => Promise<void>): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void parse()
      .catch((error: unknown) => {
        console.error(`[analytics] ${label} log parse failed:`, error);
      })
      .finally(() => {
        running = false;
      });
  }, parseIntervalMs);
}

/** The interval the running timers were made with, to notice a pushed change. */
let timersMs = 0;

async function syncParsers(access: boolean, waf: boolean): Promise<void> {
  if (timersMs !== parseIntervalMs && (accessTimer || wafTimer)) {
    // Same parsers and offsets, a new cadence.
    if (accessTimer) clearInterval(accessTimer);
    if (wafTimer) clearInterval(wafTimer);
    accessTimer = accessTimer ? parseEvery("access", parseNewLogEntries) : null;
    wafTimer = wafTimer ? parseEvery("WAF", parseNewWafLogEntries) : null;
    console.log(`[analytics] parsing every ${parseIntervalMs / 1000}s`);
  }
  timersMs = parseIntervalMs;
  if (access && !accessTimer) {
    await initLogParser();
    accessTimer = parseEvery("access", parseNewLogEntries);
    console.log("[analytics] access log parser started");
  } else if (!access && accessTimer) {
    clearInterval(accessTimer);
    accessTimer = null;
    stopLogParser();
    console.log("[analytics] access log parser stopped");
  }
  if (waf && !wafTimer) {
    await initWafLogParser();
    wafTimer = parseEvery("WAF", parseNewWafLogEntries);
    console.log("[analytics] WAF log parser started");
  } else if (!waf && wafTimer) {
    clearInterval(wafTimer);
    wafTimer = null;
    stopWafLogParser();
    console.log("[analytics] WAF log parser stopped");
  }
}

export async function stop(): Promise<void> {
  if (geoipTimer) {
    clearInterval(geoipTimer);
    geoipTimer = null;
  }
  await syncParsers(false, false);
  configureAnalytics(null);
}

/** At startup, so a restarted agent keeps writing analytics before the controller notices. */
export async function resumeFleetConfig(store: AgentStore): Promise<void> {
  const stored = store.fleetConfig();
  if (!stored) return;
  // An agent polls exactly one controller.
  const controller = store.listControllers()[0];
  if (!controller) return;
  await applyFleetConfig(store, stored, controller.controllerId);
}
