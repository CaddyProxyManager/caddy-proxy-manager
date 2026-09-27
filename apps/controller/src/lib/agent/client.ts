/**
 * A facade over `registry.ts`: agents connect inbound, so nothing here dials. Port publishing and
 * Caddy rebuilds are desired state, so they return `pending` and the agent's status reports the
 * rest.
 */

import {
  AgentDecodeError,
  type AgentStatus,
  type CaddyAdminProxyRequest,
  type CaddyAdminProxyResponse,
  type CaddyBuildStatus,
  type CaddyCertificate,
  type CertificateFileRequest,
  type CertificateFiles,
  decodeCertificateFiles,
  decodeCertificateList,
  decodeLogReadResponse,
  type L4PortsStatus,
  type LogReadRequest,
  type LogReadResponse,
} from "@cpm/shared";
import { type DomainErrorCode, domainErrorMessage } from "../domain-error";
import { pushDesiredState } from "./desired-state";
import {
  AgentCommandError,
  AgentNotConnectedError,
  type ConnectedAgent,
  connectedAgents,
  dispatchCaddyAdmin,
  dispatchCaddyValidate,
  dispatchLogRead,
  dispatchCertificateList,
  dispatchCertificateRead,
} from "./registry";

export class AgentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUnavailableError";
  }
}

export class AgentRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AgentRequestError";
  }
}

/** Per agent, so a partial failure is visible. */
export type AgentResult<T> =
  | { agent: string; ok: true; value: T }
  /** `code` is set when this side wrote `error`, so a page can say it in its reader's language. */
  | { agent: string; ok: false; error: string; code?: DomainErrorCode };

function noAgentError(): AgentUnavailableError {
  return new AgentUnavailableError(
    "No agent is connected. Start the agent and pair it from Settings → Agent.",
  );
}

/** An agent not holding a stream open cannot be reached at all, so it is not a target. */
export async function listAgentTargets(): Promise<ConnectedAgent[]> {
  return connectedAgents();
}

/**
 * Every paired agent, connected or not: hiding a down agent from a picker would lose its host
 * assignments on the next save.
 */
export async function listAgentOptions(): Promise<
  { id: number; name: string; connected: boolean; hasOwnBuildSettings: boolean }[]
> {
  const { listAgents } = await import("../models/agents");
  const live = new Set(connectedAgents().map((agent) => agent.agentId));
  return (await listAgents()).map((agent) => ({
    id: agent.id,
    name: agent.name,
    connected: live.has(agent.agentId),
    hasOwnBuildSettings: agent.hasOwnBuildSettings,
  }));
}

function primary(): ConnectedAgent | null {
  return connectedAgents()[0] ?? null;
}

// ─── Status ──────────────────────────────────────────────────────────────────

export async function isAgentAvailable(): Promise<boolean> {
  return connectedAgents().length > 0;
}

/** Throws when there is no primary, or it has not reported yet. A map lookup, no round trip. */
export async function getAgentStatus(): Promise<AgentStatus> {
  const agent = primary();
  if (!agent) throw noAgentError();
  if (!agent.status) {
    throw new AgentRequestError(`${agent.name} has connected but not reported yet.`, 503);
  }
  return agent.status;
}

/** For page renders: a missing agent must not turn the page into an error. */
export async function tryGetAgentStatus(): Promise<AgentStatus | null> {
  return primary()?.status ?? null;
}

/** By row id, not the self-asserted `agentId`: per-agent config is keyed on the row. */
export async function getAgentStatusFor(agentRowId: number): Promise<AgentStatus | null> {
  return connectedAgents().find((agent) => agent.agentRowId === agentRowId)?.status ?? null;
}

/** Never throws. */
export async function getAllAgentStatuses(): Promise<AgentResult<AgentStatus>[]> {
  return connectedAgents().map((agent) =>
    agent.status
      ? { agent: agent.name, ok: true as const, value: agent.status }
      : {
          agent: agent.name,
          ok: false as const,
          error: domainErrorMessage("agentNotReported"),
          code: "agentNotReported" as const,
        },
  );
}

// ─── Desired state ───────────────────────────────────────────────────────────

/**
 * `ports` is ignored: desired state is recomputed from settings rather than trusted from the
 * caller, since two sources for one fact drift.
 */
export async function requestL4Ports(_ports: string[]): Promise<L4PortsStatus> {
  if (connectedAgents().length === 0) throw noAgentError();
  await pushDesiredState();
  return { state: "pending", triggeredAt: new Date().toISOString() };
}

/** `modules` is ignored, for the same reason. */
export async function requestCaddyBuild(_modules: string[]): Promise<CaddyBuildStatus> {
  if (connectedAgents().length === 0) throw noAgentError();
  await pushDesiredState();
  return { state: "pending", triggeredAt: new Date().toISOString() };
}

// ─── Caddy admin ─────────────────────────────────────────────────────────────

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The primary (no `agentId`) is only for answers that stay on the controller; anything feeding a
 * config loaded onto an agent must name that agent, since agents are less trusted.
 */
export async function caddyAdminViaAgent(
  request: CaddyAdminProxyRequest,
  agentId?: string,
): Promise<CaddyAdminProxyResponse> {
  const agent =
    agentId === undefined
      ? primary()
      : (connectedAgents().find((candidate) => candidate.agentId === agentId) ?? null);
  if (!agent) throw noAgentError();
  try {
    return await dispatchCaddyAdmin(agent.agentId, request);
  } catch (error) {
    if (error instanceof AgentNotConnectedError) throw noAgentError();
    if (error instanceof AgentCommandError)
      throw new AgentRequestError(error.message, error.status);
    throw error;
  }
}

/** Null when no agent can. Any will do: the answer never ends up in a config. */
export async function caddyValidateViaAgent(
  config: string,
  /** Any capable agent when omitted. */
  agentId?: string,
): Promise<CaddyAdminProxyResponse | null> {
  const agent = connectedAgents().find(
    (candidate) =>
      (!agentId || candidate.agentId === agentId) &&
      candidate.status?.capabilities?.includes("caddy-validate"),
  );
  if (!agent) return null;
  try {
    return await dispatchCaddyValidate(agent.agentId, { config });
  } catch (error) {
    if (error instanceof AgentNotConnectedError) return null;
    if (error instanceof AgentCommandError)
      throw new AgentRequestError(error.message, error.status);
    throw error;
  }
}

function agentsWith(capability: "certificates" | "log-read") {
  return connectedAgents().filter((agent) => agent.status?.capabilities?.includes(capability));
}

/** A failed agent is reported per agent, so one wedged host doesn't blank the whole list. */
export async function listAgentCertificates(): Promise<
  { agentId: string; name: string; certificates: CaddyCertificate[] | null }[]
> {
  return await Promise.all(
    agentsWith("certificates").map(async (agent) => {
      try {
        const response = await dispatchCertificateList(agent.agentId);
        return {
          agentId: agent.agentId,
          name: agent.name,
          certificates: decodeCertificateList(response.text),
        };
      } catch {
        return { agentId: agent.agentId, name: agent.name, certificates: null };
      }
    }),
  );
}

export async function readAgentCertificate(
  agentId: string,
  request: CertificateFileRequest,
): Promise<CertificateFiles | null> {
  if (!agentsWith("certificates").some((agent) => agent.agentId === agentId)) return null;
  const response = await dispatchCertificateRead(agentId, request);
  return response.status === 200 ? decodeCertificateFiles(response.text) : null;
}

export function logReadableAgents(): { agentId: string; name: string }[] {
  return connectedAgents()
    .filter((agent) => agent.status?.capabilities?.includes("log-read"))
    .map(({ agentId, name }) => ({ agentId, name }));
}

export async function readAgentLog(
  agentId: string,
  request: LogReadRequest,
): Promise<LogReadResponse | null> {
  if (!logReadableAgents().some((agent) => agent.agentId === agentId)) return null;
  try {
    const response = await dispatchLogRead(agentId, request);
    return decodeLogReadResponse(response.text);
  } catch (error) {
    if (error instanceof AgentNotConnectedError) return null;
    if (error instanceof AgentDecodeError) throw new AgentRequestError(error.message, 502);
    if (error instanceof AgentCommandError)
      throw new AgentRequestError(error.message, error.status);
    throw error;
  }
}

/**
 * Per agent, so a config that loaded on one host and was refused on another stays visible. A
 * `request` function that throws fails only its own agent, not the rest of the fleet.
 */
export async function broadcastCaddyAdmin(
  request:
    | CaddyAdminProxyRequest
    | ((agent: ConnectedAgent) => CaddyAdminProxyRequest | Promise<CaddyAdminProxyRequest>),
): Promise<AgentResult<CaddyAdminProxyResponse>[]> {
  const agents = connectedAgents();
  return Promise.all(
    agents.map(async (agent): Promise<AgentResult<CaddyAdminProxyResponse>> => {
      try {
        const forAgent = typeof request === "function" ? await request(agent) : request;
        return {
          agent: agent.name,
          ok: true,
          value: await dispatchCaddyAdmin(agent.agentId, forAgent),
        };
      } catch (error) {
        return { agent: agent.name, ok: false, error: describe(error) };
      }
    }),
  );
}
