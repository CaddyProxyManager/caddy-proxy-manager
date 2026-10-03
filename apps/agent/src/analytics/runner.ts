/**
 * Starts and stops the log parsers from the controller's pushed flags, so a deployment that never
 * enables analytics or the upstream error notification never opens a log file. The access log
 * serves both; the WAF log only analytics.
 */

import type { FleetConfig } from "@cpm/shared";
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

const PARSE_INTERVAL_MS = 30_000;

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

/** A parse that throws must not kill its interval and silently stop the parser. */
async function syncParsers(access: boolean, waf: boolean): Promise<void> {
  if (access && !accessTimer) {
    await initLogParser();
    accessTimer = setInterval(() => {
      void parseNewLogEntries().catch((error: unknown) => {
        console.error("[analytics] access log parse failed:", error);
      });
    }, PARSE_INTERVAL_MS);
    console.log("[analytics] access log parser started");
  } else if (!access && accessTimer) {
    clearInterval(accessTimer);
    accessTimer = null;
    stopLogParser();
    console.log("[analytics] access log parser stopped");
  }
  if (waf && !wafTimer) {
    await initWafLogParser();
    wafTimer = setInterval(() => {
      void parseNewWafLogEntries().catch((error: unknown) => {
        console.error("[analytics] WAF log parse failed:", error);
      });
    }, PARSE_INTERVAL_MS);
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
