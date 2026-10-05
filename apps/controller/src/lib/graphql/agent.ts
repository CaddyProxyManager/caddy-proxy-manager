/**
 * The agent's half of the schema, gated per field rather than split into a second endpoint: the
 * `agent*` fields require a signed agent and reject a Bearer token, every other field the reverse.
 * Pairing stays REST, since it runs before there is a secret to sign with.
 */

import {
  AgentDecodeError,
  decodeAgentStatus,
  decodeCertificateFileResults,
  decodeCommandResults,
  MAX_ANALYTICS_REQUEST_BYTES,
  MAX_CADDY_CONFIG_BYTES,
  type AgentAnalyticsResult,
  type AgentCommandResult,
  type AgentServerEvent,
  type AgentStatus,
  type CertificateFilesAck,
} from "@cpm/shared";
import { AnalyticsIngestError, ingestAnalytics } from "../agent/analytics-ingest";
import { modulesChanged, portsReapplied, reapplyAfterRecreate } from "../agent/module-change";
import {
  attach,
  connectedAgents,
  isConnected,
  recordStatus,
  settleResults,
} from "../agent/registry";
import {
  buildDesiredState,
  DESIRED_STATE_CAPABILITIES,
  pushDesiredStateTo,
} from "../agent/desired-state";
import { ingestCertificateFileResults } from "../models/certificate-files";
import { verifyAgentRequest } from "../agent/verify";
import { isDemoMode } from "../demo/mode";
import { agentCredentialFingerprint, getControllerId, recordAgentContact } from "../models/agents";
import { getSetting } from "../settings";
import type { GraphQLContext } from "./context";
import { GraphQLError } from "graphql";

/** Per operation: a command result can carry a megabytes-long config readback. */
const MAX_STATUS_BYTES = 64 * 1024;

export type VerifiedAgent = { id: number; agentId: string; name: string; credential: string };

/**
 * Verifies the raw bytes the agent sent (Yoga consumed the original), not a re-serialisation that
 * may differ in key order or spacing from what was signed.
 */
export async function requireAgent(
  context: GraphQLContext,
  maxBytes: number,
): Promise<VerifiedAgent> {
  // An agent paired before demo mode was switched on would configure its real Caddy. Not tagged
  // AGENT_UNAUTHORIZED: the agent drops its pairing on that, and only retries on anything else.
  if (isDemoMode()) {
    throw new GraphQLError("This controller is in demo mode and does not accept agents.", {
      extensions: { code: "DEMO_MODE" },
    });
  }

  const raw = await context.rawBody();
  if (raw.length > maxBytes) {
    throw new GraphQLError("That request is too large.", {
      extensions: { code: "PAYLOAD_TOO_LARGE" },
    });
  }

  const verified = await verifyAgentRequest(context.request, raw);
  if (!verified.ok) {
    throw new GraphQLError(verified.error, { extensions: { code: "AGENT_UNAUTHORIZED" } });
  }
  return {
    id: verified.agent.id,
    agentId: verified.agent.agentId,
    name: verified.agent.name,
    credential: agentCredentialFingerprint(verified.agent.secret),
  };
}

/** A signed but malformed value is the agent's fault: refused with a code it can log, not a 500. */
function decodeOrRefuse<T>(decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (!(error instanceof AgentDecodeError)) throw error;
    throw new GraphQLError(error.message, { extensions: { code: "AGENT_BAD_REQUEST" } });
  }
}

export const agentResolvers = {
  Subscription: {
    agentEvents: {
      subscribe: async (_: unknown, __: unknown, context: GraphQLContext) => {
        const agent = await requireAgent(context, MAX_STATUS_BYTES);

        const controllerName =
          (await getSetting<string>("branding_title").catch(() => null)) || "Caddy Proxy Manager";

        const { events } = attach({
          agentId: agent.agentId,
          agentRowId: agent.id,
          credential: agent.credential,
          name: agent.name,
          controllerId: await getControllerId(),
          controllerName,
          initialState: await buildDesiredState(agent.id),
        });

        return (async function* () {
          for await (const event of events) {
            yield { agentEvents: event };
          }
        })();
      },
      resolve: (payload: { agentEvents: AgentServerEvent }) => payload.agentEvents,
    },
  },

  Mutation: {
    agentStatus: async (
      _: unknown,
      args: { status: AgentStatus },
      context: GraphQLContext,
    ): Promise<boolean> => {
      const agent = await requireAgent(context, MAX_STATUS_BYTES);

      // Without a subscription the host is unreachable; recording this would claim otherwise.
      if (!isConnected(agent.agentId)) {
        throw new GraphQLError("That agent is not connected.", {
          extensions: { code: "AGENT_NOT_CONNECTED" },
        });
      }

      const status = decodeOrRefuse(() => decodeAgentStatus(args.status));
      const previous =
        connectedAgents().find((candidate) => candidate.agentId === agent.agentId)?.status ?? null;
      recordStatus(agent.agentId, status);
      if (modulesChanged(previous, status) || portsReapplied(previous, status)) {
        reapplyAfterRecreate(agent.agentId);
      }
      void import("../notifications/agents")
        .then(({ reportAgentStatus }) => reportAgentStatus(agent, previous, status))
        .catch((error: unknown) => console.error("[notifications] agent status:", error));
      // The attach-time state went out before this agent's capabilities were known.
      const shapesState = (s: AgentStatus | null) =>
        DESIRED_STATE_CAPABILITIES.map((c) => s?.capabilities?.includes(c) ?? false).join();
      if (shapesState(status) !== shapesState(previous)) {
        void pushDesiredStateTo({ agentId: agent.agentId, agentRowId: agent.id });
      }
      await recordAgentContact(agent.id, { ok: true });
      return true;
    },

    agentCommandResults: async (
      _: unknown,
      args: { results: AgentCommandResult[] },
      context: GraphQLContext,
    ): Promise<boolean> => {
      const agent = await requireAgent(context, MAX_CADDY_CONFIG_BYTES);

      settleResults(
        agent.agentId,
        decodeOrRefuse(() => decodeCommandResults(args.results)),
      );
      return true;
    },

    agentCertificateFiles: async (
      _: unknown,
      args: { results: unknown[] },
      context: GraphQLContext,
    ): Promise<CertificateFilesAck> => {
      const agent = await requireAgent(context, MAX_CADDY_CONFIG_BYTES);
      const results = decodeOrRefuse(() => decodeCertificateFileResults(args.results));
      const { resend, refused } = await ingestCertificateFileResults(agent.id, results);
      if (refused.length > 0) {
        // The agent chose its own name, so it stays out of the format string.
        console.warn(
          "[agent] refused certificate files not sourced from agent:",
          agent.name,
          refused,
        );
      }
      return { resend };
    },

    agentAnalytics: async (
      _: unknown,
      args: { kind: string; rows: unknown[] },
      context: GraphQLContext,
    ): Promise<AgentAnalyticsResult> => {
      const agent = await requireAgent(context, MAX_ANALYTICS_REQUEST_BYTES);

      // No connection check: rows parsed while the stream was down still describe real traffic.
      try {
        return await ingestAnalytics(agent.agentId, args.kind, args.rows);
      } catch (error) {
        if (error instanceof AnalyticsIngestError) {
          throw new GraphQLError(error.message, { extensions: { code: error.code } });
        }
        throw error;
      }
    },
  },
};
