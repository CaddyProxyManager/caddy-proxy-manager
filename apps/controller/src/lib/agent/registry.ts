/**
 * The only way to reach an agent: it dials in, so one missing here is unreachable whatever the
 * database says. A stream belongs to the process it reached; one another replica holds is
 * mirrored here and reached through it (./broker.ts), so callers never ask which. Transport-agnostic.
 */

import { randomUUID } from "node:crypto";
import {
  AGENT_COMMAND_TIMEOUT_MS,
  AGENT_STREAM_KEEPALIVE_MS,
  type AgentCommand,
  type DecodedCommandResult,
  type AgentDesiredState,
  type AgentServerEvent,
  type AgentStatus,
  type CaddyAdminProxyRequest,
  type CaddyAdminProxyResponse,
  type CaddyValidateRequest,
  type LogReadRequest,
  type CertificateFileRequest,
  type CertificateFilesReadRequest,
} from "@cpm/shared";
import { isClusterShared } from "../cluster/bus";
import { cluster } from "../cluster/state";
import {
  bindRegistry,
  claimStream,
  forwardEvent,
  forwardResult,
  isHeldAnywhere,
  originOf,
  releaseStream,
  requestDetach,
  storeStatus,
} from "./broker";
import {
  AgentCommandError,
  AgentNotConnectedError,
  type Connection,
  failWaiters,
  type RemoteConnection,
  registry,
  settleWaiter,
} from "./registry-state";

export { AgentCommandError, AgentNotConnectedError } from "./registry-state";

const { connections, waiters, remote } = registry;

function quietly(what: string, work: Promise<unknown>): void {
  work.catch((error: unknown) => console.error(`[agent] could not ${what}:`, error));
}

// ─── Attaching ───────────────────────────────────────────────────────────────

export type AttachedAgent = {
  /** An iterable, not a stream, so the GraphQL layer owns the transport. */
  events: AsyncIterableIterator<AgentServerEvent>;
  push: (state: AgentDesiredState) => void;
};

/** A reconnect replaces the old stream; keeping both after a partition would double commands. */
export function attach(params: {
  agentId: string;
  agentRowId: number;
  credential?: string;
  name: string;
  controllerId: string;
  controllerName: string;
  initialState: AgentDesiredState;
}): AttachedAgent {
  const existing = connections.get(params.agentId);
  if (existing) {
    existing.close();
    connections.delete(params.agentId);
  }

  // At most one of `pending` (produced, not taken) and `waiting` (consumer came first) is set.
  const pending: AgentServerEvent[] = [];
  let waiting: ((event: IteratorResult<AgentServerEvent>) => void) | null = null;
  let closed = false;
  let keepalive: ReturnType<typeof setInterval> | null = null;

  // A live consumer asks for the next event within milliseconds. Unread for a whole keepalive, the
  // transport died without telling Yoga to stop, and a command sent down it would go nowhere.
  let lastPulled = Date.now();
  const stalled = () => pending.length > 0 && Date.now() - lastPulled > AGENT_STREAM_KEEPALIVE_MS;

  const send = (event: AgentServerEvent): boolean => {
    if (closed || stalled()) return false;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: event, done: false });
      return true;
    }
    pending.push(event);
    return true;
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
    // Ends the consumer's `for await`, which is what tears the subscription down.
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: undefined, done: true });
    }
  };

  const connection: Connection = {
    agentId: params.agentId,
    name: params.name,
    agentRowId: params.agentRowId,
    credential: params.credential,
    connectedAt: Date.now(),
    send,
    close,
    status: null,
    lastSeenAt: Date.now(),
  };

  // Only while still the agent's stream: a newer one may have replaced it, here or elsewhere.
  const hangUp = () => {
    if (connections.get(params.agentId) === connection) detachLocal(params.agentId);
  };

  const events: AsyncIterableIterator<AgentServerEvent> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      lastPulled = Date.now();
      const queued = pending.shift();
      if (queued) return Promise.resolve({ value: queued, done: false });
      if (closed)
        return Promise.resolve({
          value: undefined,
          done: true,
        } as IteratorResult<AgentServerEvent>);
      return new Promise<IteratorResult<AgentServerEvent>>((resolve) => {
        waiting = resolve;
      });
    },
    // The consumer stopped: the agent hung up or the subscription is shutting down.
    return() {
      hangUp();
      return Promise.resolve({ value: undefined, done: true } as IteratorResult<AgentServerEvent>);
    },
    throw(error) {
      hangUp();
      return Promise.reject(error);
    },
  };

  // `hello` first, so the agent can log what it attached to before any state arrives.
  send({
    type: "hello",
    controllerId: params.controllerId,
    controllerName: params.controllerName,
  });
  send({ type: "desired-state", state: params.initialState });

  keepalive = setInterval(() => {
    if (!send({ type: "ping" })) hangUp();
  }, AGENT_STREAM_KEEPALIVE_MS);

  connections.set(params.agentId, connection);
  quietly("record an agent's stream", claimStream(connection));

  return {
    events,
    push: (state) => {
      send({ type: "desired-state", state });
    },
  };
}

/** This process's stream only; another replica's row stays as it is. */
function detachLocal(agentId: string): void {
  const connection = connections.get(agentId);
  if (!connection) return;
  connection.close();
  connections.delete(agentId);
  // Fail waiters now rather than letting them run to their timeout.
  failWaiters(agentId, null, new AgentNotConnectedError(`${connection.name} disconnected.`));
  quietly("release an agent's stream", releaseStream(agentId));
}

/** Wherever the stream is: one another replica holds is closed there. */
export function detach(agentId: string): void {
  if (connections.has(agentId)) {
    detachLocal(agentId);
    return;
  }
  const elsewhere = remote.get(agentId);
  if (elsewhere) requestDetach(elsewhere);
}

/**
 * Closes every stream of this process `stillValid` rejects, before anything else can be sent down
 * it - a restore can replace the agents table under open streams. Returns the agentIds it closed.
 */
export function reconcileConnections(
  stillValid: (connection: { agentId: string; agentRowId: number; credential?: string }) => boolean,
): string[] {
  const closed: string[] = [];
  for (const connection of [...connections.values()]) {
    if (stillValid(connection)) continue;
    detachLocal(connection.agentId);
    closed.push(connection.agentId);
  }
  return closed;
}

bindRegistry({
  detachLocal,
  reconcile: async () => {
    const { reconcileAgentConnections } = await import("../models/agents");
    await reconcileAgentConnections({ local: true });
  },
});

// ─── Reading ─────────────────────────────────────────────────────────────────

export type ConnectedAgent = {
  agentId: string;
  name: string;
  agentRowId: number;
  status: AgentStatus | null;
  lastSeenAt: number;
};

function describe(connection: Connection | RemoteConnection): ConnectedAgent {
  return {
    agentId: connection.agentId,
    name: connection.name,
    agentRowId: connection.agentRowId,
    status: connection.status,
    lastSeenAt: connection.lastSeenAt,
  };
}

/** Every agent with a stream open to any replica; this process's own first. */
export function connectedAgents(): ConnectedAgent[] {
  const agents = [...connections.values()].map(describe);
  for (const elsewhere of remote.values()) {
    if (!connections.has(elsewhere.agentId)) agents.push(describe(elsewhere));
  }
  return agents;
}

/** Only the streams this process holds, for work each replica does for its own. */
export function localAgents(): ConnectedAgent[] {
  return [...connections.values()].map(describe);
}

export function isConnected(agentId: string): boolean {
  return connections.has(agentId) || remote.has(agentId);
}

/** `isConnected`, checked against the database too: a stream opened elsewhere a moment ago counts. */
export function isConnectedAnywhere(agentId: string): Promise<boolean> {
  return isHeldAnywhere(agentId);
}

/** Returns the status it replaces. */
export async function recordStatus(
  agentId: string,
  status: AgentStatus,
  now = Date.now(),
): Promise<AgentStatus | null> {
  const connection = connections.get(agentId);
  let previous = connection?.status ?? remote.get(agentId)?.status ?? null;
  if (connection) {
    connection.status = status;
    connection.lastSeenAt = now;
  }
  try {
    const stored = await storeStatus(agentId, status, now);
    if (stored && !connection) previous = stored.previous;
  } catch (error) {
    console.error("[agent] could not store an agent's status:", error);
  }
  return previous;
}

// ─── Desired state ───────────────────────────────────────────────────────────

/** False when it is connected nowhere. */
function deliver(agentId: string, event: AgentServerEvent): boolean {
  const connection = connections.get(agentId);
  if (connection) {
    if (connection.send(event)) return true;
    detachLocal(agentId);
    return false;
  }
  const elsewhere = remote.get(agentId);
  if (!elsewhere) return false;
  quietly(`forward ${event.type} to an agent`, forwardEvent(elsewhere, event));
  return true;
}

/**
 * State is built per agent; null skips one, leaving it on its last state rather than a guess.
 * Sequential so a large fleet does not stampede the database on every host save.
 */
export async function broadcastDesiredState(
  build: (agent: ConnectedAgent) => Promise<AgentDesiredState | null>,
): Promise<void> {
  for (const agent of connectedAgents()) {
    const state = await build(agent);
    if (state === null) continue;
    // It may have hung up while its state was being computed.
    deliver(agent.agentId, { type: "desired-state", state });
  }
}

/** One agent's state, for a change only it cares about. False when it is not connected. */
export function sendDesiredState(agentId: string, state: AgentDesiredState): boolean {
  return deliver(agentId, { type: "desired-state", state });
}

/** Returns how many were asked. Not awaited: the caller is about to exit too. */
export function broadcastRestart(reason: string): number {
  let asked = 0;
  for (const agent of connectedAgents()) {
    if (deliver(agent.agentId, { type: "restart", reason })) asked++;
  }
  return asked;
}

// ─── Commands ────────────────────────────────────────────────────────────────

/** The one place the controller blocks on an agent; the timeout bounds a wedged one. */
export function dispatchCaddyAdmin(
  agentId: string,
  request: CaddyAdminProxyRequest,
): Promise<CaddyAdminProxyResponse> {
  return dispatch(agentId, { kind: "caddy-admin", request });
}

/** Only for an agent listing `caddy-validate`: an older one never answers and this times out. */
export function dispatchCaddyValidate(
  agentId: string,
  request: CaddyValidateRequest,
): Promise<CaddyAdminProxyResponse> {
  return dispatch(agentId, { kind: "caddy-validate", request });
}

/** Only for an agent listing `log-read`; see dispatchCaddyValidate. */
export function dispatchLogRead(
  agentId: string,
  request: LogReadRequest,
): Promise<CaddyAdminProxyResponse> {
  return dispatch(agentId, { kind: "log-read", request });
}

/** Only for an agent listing `certificates`. */
export function dispatchCertificateList(agentId: string): Promise<CaddyAdminProxyResponse> {
  return dispatch(agentId, { kind: "certificate-list", request: {} });
}

export function dispatchCertificateRead(
  agentId: string,
  request: CertificateFileRequest,
): Promise<CaddyAdminProxyResponse> {
  return dispatch(agentId, { kind: "certificate-read", request });
}

/** Only for an agent listing `caddy-image` and reporting `caddyBuild.external`. */
export function dispatchCaddyImageLoad(agentId: string): Promise<CaddyAdminProxyResponse> {
  return dispatch(agentId, { kind: "caddy-image-load", request: {} });
}

/** Only for an agent listing `certificate-files`. */
export function dispatchCertificateFilesList(agentId: string): Promise<CaddyAdminProxyResponse> {
  return dispatch(agentId, { kind: "certificate-files-list", request: {} });
}

export function dispatchCertificateFilesRead(
  agentId: string,
  request: CertificateFilesReadRequest,
): Promise<CaddyAdminProxyResponse> {
  return dispatch(agentId, { kind: "certificate-files-read", request });
}

type CommandBody =
  | { kind: "caddy-admin"; request: CaddyAdminProxyRequest }
  | { kind: "caddy-validate"; request: CaddyValidateRequest }
  | { kind: "log-read"; request: LogReadRequest }
  | { kind: "certificate-list"; request: Record<string, never> }
  | { kind: "certificate-read"; request: CertificateFileRequest }
  | { kind: "caddy-image-load"; request: Record<string, never> }
  | { kind: "certificate-files-list"; request: Record<string, never> }
  | { kind: "certificate-files-read"; request: CertificateFilesReadRequest };

function dispatch(agentId: string, body: CommandBody): Promise<CaddyAdminProxyResponse> {
  const connection = connections.get(agentId);
  const elsewhere = connection ? undefined : remote.get(agentId);
  const target = connection ?? elsewhere;
  if (!target) {
    return Promise.reject(new AgentNotConnectedError("That agent is not connected."));
  }

  // The issuing replica in the id, so the agent's answer finds its way back through any other.
  const commandId = `${agentId}:${cluster.replicaId}:${randomUUID()}`;
  const command: AgentCommand = { id: commandId, ...body };

  return new Promise<CaddyAdminProxyResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(commandId);
      reject(new AgentCommandError(`${target.name} did not answer in time.`, 504));
    }, AGENT_COMMAND_TIMEOUT_MS);

    waiters.set(commandId, { resolve, reject, timer, via: elsewhere?.replicaId ?? null });
    const unsent = (error: Error) => {
      if (!waiters.delete(commandId)) return;
      clearTimeout(timer);
      reject(error);
    };

    if (connection) {
      if (!connection.send({ type: "command", command })) {
        detachLocal(agentId);
        unsent(new AgentNotConnectedError(`${connection.name} disconnected.`));
      }
      return;
    }
    if (elsewhere) {
      forwardEvent(elsewhere, { type: "command", command }).catch((error: unknown) => {
        console.error("[agent] could not forward a command:", error);
        unsent(new AgentNotConnectedError(`${elsewhere.name} could not be reached.`));
      });
    }
  });
}

/** Results for commands another replica issued are passed on to it. */
export async function settleResults(
  agentId: string,
  results: DecodedCommandResult[],
): Promise<void> {
  const connection = connections.get(agentId);
  if (connection) connection.lastSeenAt = Date.now();
  for (const result of results) {
    if (settleWaiter(agentId, result)) continue;
    if (!result.id.startsWith(`${agentId}:`) || !isClusterShared()) continue;
    const origin = originOf(result.id);
    if (!origin || origin === cluster.replicaId) continue;
    try {
      await forwardResult(origin, result);
    } catch (error) {
      console.error("[agent] could not forward a command result:", error);
    }
  }
}

/** Test seam. */
export function resetRegistry(): void {
  for (const connection of connections.values()) connection.close();
  connections.clear();
  remote.clear();
  for (const waiter of waiters.values()) clearTimeout(waiter.timer);
  waiters.clear();
}
