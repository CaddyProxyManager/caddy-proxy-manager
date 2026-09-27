/**
 * An in-controller agent for demo mode, speaking the real protocol so every agent-status page has
 * something to show. Operations only wait and report success; admin calls hit an in-memory Caddy.
 */
import {
  AGENT_STATUS_HEARTBEAT_MS,
  type AgentCommand,
  type AgentDesiredState,
  type AgentStatus,
  type ManagedServiceName,
  SHIPPED_CADDY_MODULES,
} from "@cpm/shared";
import { buildDesiredState } from "../agent/desired-state";
import { attach, detach, recordStatus, settleResults } from "../agent/registry";
import {
  findAgentRowByAgentId,
  getControllerId,
  insertPairedAgent,
  recordAgentContact,
} from "../models/agents";
import { controllerDisplayName } from "../agent/controller-name";
import { createSimulatedCaddy } from "./simulated-caddy";

/** Hex like a real agentId, and recognisable in a database dump. */
export const DEMO_AGENT_ID = "de300000000000000000000000000000";
const DEMO_AGENT_NAME = "Demo agent";

/** A real rebuild takes minutes; a demo should not. */
export type SimulationDelays = { ports: number; build: number; services: number };
const DEFAULT_DELAYS: SimulationDelays = { ports: 1_500, build: 6_000, services: 3_000 };

export type SimulatedAgent = { agentId: string; agentRowId: number; stop: () => void };

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

const sameServices = (
  a: Record<ManagedServiceName, boolean>,
  b: Record<ManagedServiceName, boolean> | null,
) => b !== null && Object.entries(a).every(([name, on]) => b[name as ManagedServiceName] === on);

/**
 * Null when an operator disabled its row. Unpaired, it stays gone until the next start re-creates
 * it, as someone exploring the demo would expect.
 */
export async function startSimulatedAgent(
  delays: SimulationDelays = DEFAULT_DELAYS,
): Promise<SimulatedAgent | null> {
  const row =
    (await findAgentRowByAgentId(DEMO_AGENT_ID)) ??
    // Never used: nothing signs requests for an agent that is not on a network.
    (await insertPairedAgent({
      name: DEMO_AGENT_NAME,
      agentId: DEMO_AGENT_ID,
      secret: crypto.randomUUID(),
    })) ??
    (await findAgentRowByAgentId(DEMO_AGENT_ID));
  if (!row?.enabled) return null;

  const caddy = createSimulatedCaddy();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const now = () => new Date().toISOString();

  const status: AgentStatus = {
    agentId: DEMO_AGENT_ID,
    version: "demo",
    mode: "standalone",
    composeProject: "demo",
    l4Ports: { applied: [], status: { state: "idle" } },
    caddyBuild: { applied: null, status: { state: "idle" } },
    services: { applied: null, status: { state: "idle" } },
    analytics: { enabled: false, accessLogPresent: false },
  };

  const report = () => recordStatus(DEMO_AGENT_ID, structuredClone(status));

  const later = (ms: number, finish: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      finish();
      report();
    }, ms);
    timers.add(timer);
  };

  // A newer desired state supersedes the one still "running".
  const running: Partial<Record<keyof SimulationDelays, object>> = {};
  const start = (op: keyof SimulationDelays, finish: () => void) => {
    const token = {};
    running[op] = token;
    later(delays[op], () => {
      if (running[op] !== token) return;
      running[op] = undefined;
      finish();
    });
  };
  // Already applied, as when a change is reverted mid-"build": nothing to run.
  const settle = (op: keyof SimulationDelays, current: { state: string }) => {
    if (running[op] === undefined) return;
    running[op] = undefined;
    Object.assign(current, { state: "applied", appliedAt: now() });
  };

  function reconcile(state: AgentDesiredState): void {
    if (!sameList(state.l4Ports, status.l4Ports.applied)) {
      status.l4Ports.status = { state: "applying", triggeredAt: now() };
      start("ports", () => {
        status.l4Ports = {
          applied: [...state.l4Ports],
          status: { state: "applied", appliedAt: now() },
        };
      });
    } else settle("ports", status.l4Ports.status);

    const appliedModules = status.caddyBuild.applied ?? [...SHIPPED_CADDY_MODULES];
    if (!sameList(state.caddyModules, appliedModules)) {
      status.caddyBuild.status = { state: "building", triggeredAt: now() };
      start("build", () => {
        status.caddyBuild = {
          applied: [...state.caddyModules],
          status: { state: "applied", appliedAt: now() },
        };
      });
    } else settle("build", status.caddyBuild.status);

    if (!sameServices(state.services.services, status.services.applied)) {
      status.services.status = { state: "applying", triggeredAt: now() };
      start("services", () => {
        status.services = {
          applied: { ...state.services.services },
          status: { state: "applied", appliedAt: now() },
        };
      });
    } else settle("services", status.services.status);

    // A real host with analytics on has an access log; saying otherwise would show a warning.
    status.analytics = {
      enabled: state.fleetConfig.analytics,
      accessLogPresent: state.fleetConfig.analytics,
    };
    report();
  }

  function execute(command: AgentCommand): void {
    // Never sent, as this agent lists no capabilities; accepted anyway, like the in-memory Caddy.
    const answer = (text: string, status = 200) => ({ status, text, headers: {} });
    let response: ReturnType<typeof answer>;
    switch (command.kind) {
      case "caddy-validate":
        response = answer("Valid configuration");
        break;
      case "log-read":
        response = answer(JSON.stringify({ lines: [], cursor: null, missing: true }));
        break;
      case "certificate-list":
        response = answer("[]");
        break;
      case "certificate-read":
        response = answer("", 404);
        break;
      case "caddy-image-load":
        response = answer("");
        break;
      default:
        response = caddy(command.request);
    }
    settleResults(DEMO_AGENT_ID, [{ id: command.id, ok: true, response }]);
  }

  const controllerName = await controllerDisplayName();
  const { events } = attach({
    agentId: DEMO_AGENT_ID,
    agentRowId: row.id,
    name: row.name,
    controllerId: await getControllerId(),
    controllerName,
    initialState: await buildDesiredState(row.id),
  });

  const heartbeat = setInterval(() => {
    report();
    void recordAgentContact(row.id, { ok: true });
  }, AGENT_STATUS_HEARTBEAT_MS);

  const quiesce = () => {
    clearInterval(heartbeat);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  const stop = () => {
    quiesce();
    detach(DEMO_AGENT_ID);
  };

  void (async () => {
    for await (const event of events) {
      switch (event.type) {
        case "hello":
          report();
          await recordAgentContact(row.id, { ok: true });
          break;
        case "desired-state":
          reconcile(event.state);
          break;
        case "command":
          execute(event.command);
          break;
        case "restart":
          // A real agent restarts Caddy and exits; there is neither here.
          console.log(`[demo] agent restart requested: ${event.reason}`);
          break;
      }
    }
  })()
    .catch((error: unknown) => console.warn("[demo] simulated agent stopped:", error))
    // By an unpair or a newer attach. Not detach: after the latter, that is someone else's.
    .finally(quiesce);

  return { agentId: DEMO_AGENT_ID, agentRowId: row.id, stop };
}
