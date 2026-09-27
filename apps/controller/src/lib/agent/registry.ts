/**
 * The only way to reach an agent: it dials in, so one missing here is unreachable whatever the
 * database says. In memory because a connection belongs to this process; a second replica would
 * hold half the fleet, and a broker would go here, not in the callers. Transport-agnostic.
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
} from "@cpm/shared";

type Connection = {
  agentId: string;
  /** For messages, never for routing. */
  name: string;
  agentRowId: number;
  /** Fingerprint of the secret the stream authenticated with; unset for the demo agent. */
  credential?: string;
  connectedAt: number;
  /** False once the stream is gone. */
  send: (event: AgentServerEvent) => boolean;
  close: () => void;
  status: AgentStatus | null;
  lastSeenAt: number;
};

type Waiter = {
  resolve: (result: CaddyAdminProxyResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const connections = new Map<string, Connection>();
const waiters = new Map<string, Waiter>();

export class AgentNotConnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentNotConnectedError";
  }
}

export class AgentCommandError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
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

  const send = (event: AgentServerEvent): boolean => {
    if (closed) return false;
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

  const events: AsyncIterableIterator<AgentServerEvent> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
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
      detach(params.agentId);
      return Promise.resolve({ value: undefined, done: true } as IteratorResult<AgentServerEvent>);
    },
    throw(error) {
      detach(params.agentId);
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
    send({ type: "ping" });
  }, AGENT_STREAM_KEEPALIVE_MS);

  connections.set(params.agentId, {
    agentId: params.agentId,
    name: params.name,
    agentRowId: params.agentRowId,
    credential: params.credential,
    connectedAt: Date.now(),
    send,
    close,
    status: null,
    lastSeenAt: Date.now(),
  });

  return {
    events,
    push: (state) => {
      send({ type: "desired-state", state });
    },
  };
}

export function detach(agentId: string): void {
  const connection = connections.get(agentId);
  if (!connection) return;
  connection.close();
  connections.delete(agentId);

  // Fail waiters now rather than letting them run to their timeout.
  for (const [id, waiter] of waiters) {
    if (id.startsWith(`${agentId}:`)) {
      clearTimeout(waiter.timer);
      waiter.reject(new AgentNotConnectedError(`${connection.name} disconnected.`));
      waiters.delete(id);
    }
  }
}

/**
 * Closes every stream `stillValid` rejects, before anything else can be sent down it - a restore
 * can replace the agents table under open streams. Returns the agentIds it closed.
 */
export function reconcileConnections(
  stillValid: (connection: { agentId: string; agentRowId: number; credential?: string }) => boolean,
): string[] {
  const closed: string[] = [];
  for (const connection of [...connections.values()]) {
    if (stillValid(connection)) continue;
    detach(connection.agentId);
    closed.push(connection.agentId);
  }
  return closed;
}

// ─── Reading ─────────────────────────────────────────────────────────────────

export type ConnectedAgent = {
  agentId: string;
  name: string;
  agentRowId: number;
  status: AgentStatus | null;
  lastSeenAt: number;
};

export function connectedAgents(): ConnectedAgent[] {
  return [...connections.values()].map((c) => ({
    agentId: c.agentId,
    name: c.name,
    agentRowId: c.agentRowId,
    status: c.status,
    lastSeenAt: c.lastSeenAt,
  }));
}

export function isConnected(agentId: string): boolean {
  return connections.has(agentId);
}

export function recordStatus(agentId: string, status: AgentStatus): void {
  const connection = connections.get(agentId);
  if (!connection) return;
  connection.status = status;
  connection.lastSeenAt = Date.now();
}

// ─── Desired state ───────────────────────────────────────────────────────────

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
    const connection = connections.get(agent.agentId);
    // It may have hung up while its state was being computed.
    if (!connection) continue;
    if (!connection.send({ type: "desired-state", state })) detach(connection.agentId);
  }
}

/** Returns how many were asked. Not awaited: the caller is about to exit too. */
export function broadcastRestart(reason: string): number {
  let asked = 0;
  for (const agent of connectedAgents()) {
    const connection = connections.get(agent.agentId);
    if (!connection) continue;
    if (connection.send({ type: "restart", reason })) asked++;
    else detach(connection.agentId);
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

type CommandBody =
  | { kind: "caddy-admin"; request: CaddyAdminProxyRequest }
  | { kind: "caddy-validate"; request: CaddyValidateRequest }
  | { kind: "log-read"; request: LogReadRequest }
  | { kind: "certificate-list"; request: Record<string, never> }
  | { kind: "certificate-read"; request: CertificateFileRequest };

function dispatch(agentId: string, body: CommandBody): Promise<CaddyAdminProxyResponse> {
  const connection = connections.get(agentId);
  if (!connection) {
    return Promise.reject(new AgentNotConnectedError("That agent is not connected."));
  }

  const commandId = `${agentId}:${randomUUID()}`;
  const command: AgentCommand = { id: commandId, ...body };

  return new Promise<CaddyAdminProxyResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(commandId);
      reject(new AgentCommandError(`${connection.name} did not answer in time.`, 504));
    }, AGENT_COMMAND_TIMEOUT_MS);

    waiters.set(commandId, { resolve, reject, timer });

    if (!connection.send({ type: "command", command })) {
      clearTimeout(timer);
      waiters.delete(commandId);
      detach(agentId);
      reject(new AgentNotConnectedError(`${connection.name} disconnected.`));
    }
  });
}

/** Unknown ids are stale and dropped. */
export function settleResults(agentId: string, results: DecodedCommandResult[]): void {
  for (const result of results) {
    const waiter = waiters.get(result.id);
    if (!waiter) continue;
    // An agent may only settle its own commands; the id carries the agent it was issued to.
    if (!result.id.startsWith(`${agentId}:`)) continue;

    clearTimeout(waiter.timer);
    waiters.delete(result.id);
    if ("malformed" in result) waiter.reject(new AgentCommandError("Malformed agent reply", 502));
    else if (result.ok) waiter.resolve(result.response);
    else waiter.reject(new AgentCommandError(result.error, 502));
  }

  const connection = connections.get(agentId);
  if (connection) connection.lastSeenAt = Date.now();
}

/** Test seam. */
export function resetRegistry(): void {
  for (const connection of connections.values()) connection.close();
  connections.clear();
  for (const waiter of waiters.values()) clearTimeout(waiter.timer);
  waiters.clear();
}
