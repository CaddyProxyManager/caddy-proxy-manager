/**
 * The registry's state, apart from its API so the broker can reach it without an import cycle.
 * On globalThis: a dev program reload re-evaluates the modules, and every agent would vanish
 * until it reconnected - the demo's never does.
 */
import type {
  AgentServerEvent,
  AgentStatus,
  CaddyAdminProxyResponse,
  DecodedCommandResult,
} from "@cpm/shared";

/** A stream this process holds. */
export type Connection = {
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

/** A stream another replica holds, as its `agent_connections` row last read. */
export type RemoteConnection = {
  agentId: string;
  name: string;
  agentRowId: number;
  credential?: string;
  replicaId: string;
  connectedAt: number;
  status: AgentStatus | null;
  lastSeenAt: number;
};

export type Waiter = {
  resolve: (result: CaddyAdminProxyResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** The replica the command was forwarded through; null when sent down this process's stream. */
  via: string | null;
};

type RegistryState = {
  connections: Map<string, Connection>;
  waiters: Map<string, Waiter>;
  remote: Map<string, RemoteConnection>;
};

const global = globalThis as typeof globalThis & { __cpmAgentRegistry?: Partial<RegistryState> };
global.__cpmAgentRegistry ??= {};
const partial = global.__cpmAgentRegistry;
partial.connections ??= new Map();
partial.waiters ??= new Map();
partial.remote ??= new Map();

export const registry = partial as RegistryState;

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

/** A command's answer: the agent's, or a holding replica's word that the agent was gone. */
export type ForwardedResult = DecodedCommandResult | { id: string; notConnected: true };

/** Unknown ids are stale and dropped. An agent may only settle its own commands. */
export function settleWaiter(agentId: string, result: ForwardedResult): boolean {
  if (!result.id.startsWith(`${agentId}:`)) return false;
  const waiter = registry.waiters.get(result.id);
  if (!waiter) return false;
  clearTimeout(waiter.timer);
  registry.waiters.delete(result.id);
  if ("notConnected" in result)
    waiter.reject(new AgentNotConnectedError("That agent disconnected."));
  else if ("malformed" in result)
    waiter.reject(new AgentCommandError("Malformed agent reply", 502));
  else if (result.ok) waiter.resolve(result.response);
  else waiter.reject(new AgentCommandError(result.error, 502));
  return true;
}

/**
 * Fails the waiters of commands sent through one stream - this process's, or one replica's - now
 * rather than at their timeout. Another stream's commands may still be answered.
 */
export function failWaiters(agentId: string, via: string | null, error: Error): void {
  for (const [id, waiter] of registry.waiters) {
    if (!id.startsWith(`${agentId}:`) || waiter.via !== via) continue;
    clearTimeout(waiter.timer);
    waiter.reject(error);
    registry.waiters.delete(id);
  }
}
