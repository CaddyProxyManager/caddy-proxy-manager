/**
 * Starts and stops the log parsers from the controller's pushed `analytics` flag, so a deployment
 * that never enables analytics never opens a log file.
 */

import type { FleetConfig } from "@cpm/shared";
import type { AgentStore } from "../db";
import { ControllerClient } from "../controller-client";
import { type AnalyticsSink, analyticsEnabled, configureAnalytics } from "./relay";
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

let timers: NodeJS.Timeout[] = [];
let running = false;

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

  configureAnalytics(config.analytics === true ? analyticsSink(store, controllerId) : null);

  if (analyticsEnabled() && !running) await start();
  else if (!analyticsEnabled() && running) await stop();

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

async function start(): Promise<void> {
  running = true;
  await initLogParser();
  await initWafLogParser();

  // A parse that throws must not kill the interval and silently stop analytics.
  timers = [
    setInterval(() => {
      void parseNewLogEntries().catch((error: unknown) => {
        console.error("[analytics] access log parse failed:", error);
      });
    }, PARSE_INTERVAL_MS),
    setInterval(() => {
      void parseNewWafLogEntries().catch((error: unknown) => {
        console.error("[analytics] WAF log parse failed:", error);
      });
    }, PARSE_INTERVAL_MS),
  ];
  console.log("[analytics] log parsers started");
}

export async function stop(): Promise<void> {
  running = false;
  if (geoipTimer) {
    clearInterval(geoipTimer);
    geoipTimer = null;
  }
  for (const timer of timers) clearInterval(timer);
  timers = [];
  stopLogParser();
  stopWafLogParser();
  configureAnalytics(null);
  console.log("[analytics] log parsers stopped");
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
