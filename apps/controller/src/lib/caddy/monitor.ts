/**
 * Re-applies config to a Caddy that restarted. Per agent, never via a "primary": a lying agent can
 * only re-apply its own config, once a minute. A restart is a fingerprint mismatch (`caddy/index.ts`);
 * ETags and empty-config checks miss it, since Caddy's default Caddyfile is non-empty.
 */

import type { ConnectedAgent } from "../agent/registry";
import { connectedAgents } from "../agent/registry";
import {
  applyCaddyConfig,
  applyCaddyConfigToAgent,
  getCaddyLiveConfigHash,
  getLastAppliedConfigHash,
} from "./index";

type CaddyMonitorState = {
  isHealthy: boolean;
  /** Fingerprint of the config this Caddy was last seen serving. */
  lastConfigId: string | null;
  lastCheckTime: number;
  consecutiveFailures: number;
  lastReapplyAt: number;
  reapplyPending: boolean;
};

const HEALTH_CHECK_INTERVAL = 10000;
const MAX_CONSECUTIVE_FAILURES = 3;
const REAPPLY_DELAY = 5000;
/** So a Caddy reporting an empty config forever stays cheap. */
const MIN_REAPPLY_INTERVAL = 60_000;

/** The Caddy reached with no agent attached: a development setup, or nothing paired yet. */
const DIRECT = "direct";

type Target = { key: string; agent: ConnectedAgent | null };

const states = new Map<string, CaddyMonitorState>();

let monitorInterval: NodeJS.Timeout | null = null;
let isMonitoring = false;

function targets(): Target[] {
  const agents = connectedAgents();
  if (agents.length === 0) return [{ key: DIRECT, agent: null }];
  return agents.map((agent) => ({ key: agent.agentId, agent }));
}

async function checkTarget(target: Target, now: number, reapplyDelayMs: number): Promise<void> {
  let state = states.get(target.key);
  if (!state) {
    state = {
      isHealthy: false,
      lastConfigId: null,
      lastCheckTime: 0,
      consecutiveFailures: 0,
      lastReapplyAt: 0,
      reapplyPending: false,
    };
    states.set(target.key, state);
  }
  state.lastCheckTime = now;
  const who = target.agent ? ` on ${target.agent.name}` : "";

  const currentConfigId = await getCaddyLiveConfigHash(target.agent?.agentId);

  if (currentConfigId === null) {
    state.consecutiveFailures++;

    if (state.isHealthy && state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.warn(
        `[CaddyMonitor] Caddy${who} appears to be down (${state.consecutiveFailures} consecutive failures)`,
      );
      state.isHealthy = false;
    }
    return;
  }

  state.consecutiveFailures = 0;
  state.isHealthy = true;

  // Nothing to compare until a load of ours lands - that is the first sighting below.
  const appliedConfigId = getLastAppliedConfigHash(target.agent?.agentId);
  const hasRestarted = appliedConfigId !== null && currentConfigId !== appliedConfigId;

  // Startup apply usually precedes any agent attaching, so a running Caddy may hold the previous
  // release's config. lastConfigId stays null until a re-apply lands, so it retries.
  const firstSighting = state.lastConfigId === null;
  if (!hasRestarted && !firstSighting) {
    state.lastConfigId = currentConfigId;
    return;
  }

  if (state.reapplyPending) return;
  // Both paths count toward the floor: a first sighting whose re-apply fails stays a first sighting.
  if (now - state.lastReapplyAt < MIN_REAPPLY_INTERVAL) return;
  state.lastReapplyAt = now;
  state.reapplyPending = true;
  console.log(
    hasRestarted
      ? `[CaddyMonitor] Caddy restart detected${who}; reapplying its configuration shortly`
      : `[CaddyMonitor] Monitoring Caddy${who}; reapplying its configuration`,
  );

  const pending = state;
  setTimeout(async () => {
    try {
      // Only this agent's own document, built with snippets this same agent adapted.
      if (target.agent) await applyCaddyConfigToAgent(target.agent);
      else await applyCaddyConfig();
      pending.lastConfigId = await getCaddyLiveConfigHash(target.agent?.agentId);
      // A first sighting that landed is not a restart, so it must not hold back the next real one.
      if (!hasRestarted) pending.lastReapplyAt = 0;
    } catch (error) {
      console.error(`[CaddyMonitor] Failed to reapply configuration${who}:`, error);
    } finally {
      pending.reapplyPending = false;
    }
  }, reapplyDelayMs);
}

/** Direct target only: an agent attaching later still needs its own first-sighting re-apply. */
export function noteStartupApply(now = Date.now()): void {
  states.set(DIRECT, {
    isHealthy: true,
    lastConfigId: "startup",
    lastCheckTime: now,
    consecutiveFailures: 0,
    lastReapplyAt: 0,
    reapplyPending: false,
  });
}

/**
 * Off is for a shared Caddy, where two monitors would fight. Read every pass so it applies without
 * a restart; imported lazily because tests mock the settings store after this module loads.
 */
async function monitorEnabled(): Promise<boolean> {
  const [registry, { getSetting }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);
  return getSetting(registry.caddyMonitorEnabled);
}

/** Exported so tests can drive it with no re-apply delay. */
export async function checkCaddyHealth(reapplyDelayMs = REAPPLY_DELAY): Promise<void> {
  if (!(await monitorEnabled())) return;
  const now = Date.now();
  const current = targets();
  const live = new Set(current.map((target) => target.key));
  for (const key of states.keys()) {
    if (!live.has(key)) states.delete(key);
  }
  await Promise.all(current.map((target) => checkTarget(target, now, reapplyDelayMs)));
}

export function startCaddyMonitoring(): void {
  if (isMonitoring) {
    console.log("[CaddyMonitor] Already monitoring");
    return;
  }

  console.log(
    `[CaddyMonitor] Starting Caddy health monitoring (interval: ${HEALTH_CHECK_INTERVAL}ms)`,
  );
  isMonitoring = true;

  checkCaddyHealth().catch((error) => {
    console.error("[CaddyMonitor] Initial health check failed:", error);
  });

  monitorInterval = setInterval(() => {
    checkCaddyHealth().catch((error) => {
      console.error("[CaddyMonitor] Health check failed:", error);
    });
  }, HEALTH_CHECK_INTERVAL);
}

export function stopCaddyMonitoring(): void {
  if (!isMonitoring) {
    return;
  }

  console.log("[CaddyMonitor] Stopping Caddy health monitoring");
  isMonitoring = false;

  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

/** Keyed by agentId. */
export function getMonitorState(): Record<string, Readonly<CaddyMonitorState>> {
  return Object.fromEntries([...states].map(([key, state]) => [key, { ...state }]));
}

/** Test seam: forget every Caddy's state. */
export function resetCaddyMonitor(): void {
  states.clear();
}
