/** Attaches to the registry as a real agent does: no transport to simulate, only the protocol. */

import { randomBytes } from 'node:crypto';
import type {
  AgentCapability,
  AgentCommand,
  AgentDesiredState,
  AgentStatus,
  CaddyBuildStatus,
  L4PortsStatus,
  ManagedServiceName,
  ManagedServicesStatus,
} from '@cpm/shared';

const { attach, detach, recordStatus, settleResults, resetRegistry } = await import(
  '../../src/lib/agent/registry'
);

export type AgentRequestLog = {
  kind: 'hello' | 'desired-state' | 'command' | 'restart';
  state?: AgentDesiredState;
  command?: AgentCommand;
  reason?: string;
};

export type FakeAgent = {
  agentId: string;
  name: string;
  /** Oldest first. */
  requests: AgentRequestLog[];
  /** Null before the first frame. */
  desired: AgentDesiredState | null;
  state: {
    appliedPorts: string[];
    appliedModules: string[] | null;
    l4Status: L4PortsStatus;
    buildStatus: CaddyBuildStatus;
    /** What this agent's Caddy answers a dispatched admin command with. */
    caddyAdmin: { status: number; text: string };
    analytics: { enabled: boolean; accessLogPresent: boolean };
    appliedServices: Record<ManagedServiceName, boolean> | null;
    servicesStatus: ManagedServicesStatus;
  };
  /** Re-report status from `state`. */
  report: () => void;
  /** Finish the last port apply, as the real agent does once Caddy is up. */
  completeL4Ports: () => void;
  /** Finish the last rebuild, as once Caddy is healthy. */
  completeBuild: () => void;
  stop: () => Promise<void>;
};

function defaultState(overrides: Partial<FakeAgent['state']>): FakeAgent['state'] {
  return {
    appliedPorts: [],
    appliedModules: null,
    l4Status: { state: 'idle' },
    buildStatus: { state: 'idle' },
    caddyAdmin: { status: 200, text: '{}' },
    analytics: { enabled: false, accessLogPresent: false },
    appliedServices: null,
    servicesStatus: { state: 'idle' },
    ...overrides,
  };
}

export type FakeAgentOptions = {
  /** The `agents` row it authenticated as; 1 unless a test needs several. */
  agentRowId?: number;
  capabilities?: AgentCapability[];
  /** Answers a command itself; undefined falls back to `state.caddyAdmin`. */
  answer?: (command: AgentCommand) => { status: number; text: string } | undefined;
};

/** Drains the stream in the background; commands are answered at once from `state.caddyAdmin`. */
export async function startFakeAgent(
  overrides: Partial<FakeAgent['state']> = {},
  options: FakeAgentOptions = {},
): Promise<FakeAgent> {
  const agentId = randomBytes(16).toString('hex');
  const name = 'fake-agent';
  const raw = defaultState(overrides);
  const requests: AgentRequestLog[] = [];

  /** Mutating `state` re-reports; status is pushed, so an assignment would otherwise go unread. */
  const state = new Proxy(raw, {
    set(target, key, value) {
      Reflect.set(target, key, value);
      recordStatus(agentId, buildStatus());
      return true;
    },
  });

  const agent: FakeAgent = {
    agentId,
    name,
    requests,
    desired: null,
    state,
    report: () => recordStatus(agentId, buildStatus()),
    completeL4Ports: () => {
      state.appliedPorts = agent.desired?.l4Ports ?? [];
      state.l4Status = { state: 'applied', appliedAt: new Date().toISOString() };
    },
    completeBuild: () => {
      state.appliedModules = agent.desired?.caddyModules ?? [];
      state.buildStatus = { state: 'applied', appliedAt: new Date().toISOString() };
    },
    stop: async () => {
      reading = false;
      detach(agentId);
    },
  };

  // The raw object: this runs inside the proxy's own setter.
  function buildStatus(): AgentStatus {
    return {
      agentId,
      version: 'test',
      mode: 'standalone',
      composeProject: 'cpm-test',
      l4Ports: { applied: raw.appliedPorts, status: raw.l4Status },
      caddyBuild: { applied: raw.appliedModules, status: raw.buildStatus },
      services: { applied: raw.appliedServices, status: raw.servicesStatus },
      analytics: raw.analytics,
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    };
  }

  const { events } = attach({
    agentId,
    agentRowId: options.agentRowId ?? 1,
    name,
    controllerId: 'test-controller',
    controllerName: 'Test',
    initialState: {
      l4Ports: [],
      caddyModules: [],
      services: { services: { clickhouse: false }, env: {} },
      fleetConfig: { clickhouse: null, analytics: false, geoip: null },
      caddyEnabled: true,
    },
  });

  // Events, not SSE bytes: the framing belongs to the GraphQL server.
  let reading = true;
  void (async () => {
    for await (const event of events) {
      if (!reading) return;
      handleEvent(event);
    }
  })().catch(() => {
    // The test is over or the agent was detached.
  });

  function handleEvent(
    event:
      | { type: 'hello' }
      | { type: 'ping' }
      | { type: 'desired-state'; state: AgentDesiredState }
      | { type: 'command'; command: AgentCommand }
      | { type: 'restart'; reason: string },
  ): void {
    if (event.type === 'ping') return;

    // Logged only: the fake has no Caddy to restart and no process to exit.
    if (event.type === 'restart') {
      requests.push({ kind: 'restart', reason: event.reason });
      return;
    }

    if (event.type === 'hello') {
      requests.push({ kind: 'hello' });
      return;
    }
    if (event.type === 'desired-state') {
      agent.desired = event.state;
      requests.push({ kind: 'desired-state', state: event.state });
      return;
    }

    requests.push({ kind: 'command', command: event.command });
    const answer = options.answer?.(event.command) ?? raw.caddyAdmin;
    settleResults(agentId, [
      {
        id: event.command.id,
        ok: true,
        response: {
          status: answer.status,
          text: answer.text,
          headers: { 'content-type': 'application/json' },
        },
      },
    ]);
  }

  // A connected agent that never reported counts as present-but-unusable.
  agent.report();

  // Let the hello and desired-state frames land before the test asserts on them.
  await Bun.sleep(5);
  return agent;
}

/** So one suite's registry cannot leak into the next. */
export function clearAgentEnv(): void {
  resetRegistry();
}
