/**
 * The agent's half of the schema, gated per field rather than split into a second endpoint: the
 * `agent*` fields require a signed agent and reject a Bearer token, every other field the reverse.
 * Pairing stays REST, since it runs before there is a secret to sign with.
 */

import {
  MAX_ANALYTICS_REQUEST_BYTES,
  MAX_CADDY_CONFIG_BYTES,
  type AgentAnalyticsResult,
  type AgentCommandResult,
  type AgentServerEvent,
  type AgentStatus,
} from "@cpm/shared";
import { AnalyticsIngestError, ingestAnalytics } from "../agent/analytics-ingest";
import { attach, isConnected, recordStatus, settleResults } from "../agent/registry";
import { buildDesiredState } from "../agent/desired-state";
import { verifyAgentRequest } from "../agent/verify";
import { isDemoMode } from "../demo-mode";
import { getControllerId, recordAgentContact } from "../models/agents";
import { getSetting } from "../settings";
import type { GraphQLContext } from "./context";
import { GraphQLError } from "graphql";

/** Per operation: a command result can carry a megabytes-long config readback. */
const MAX_STATUS_BYTES = 64 * 1024;

export type VerifiedAgent = { id: number; agentId: string; name: string };

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
  return { id: verified.agent.id, agentId: verified.agent.agentId, name: verified.agent.name };
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

      recordStatus(agent.agentId, args.status);
      await recordAgentContact(agent.id, { ok: true });
      return true;
    },

    agentCommandResults: async (
      _: unknown,
      args: { results: AgentCommandResult[] },
      context: GraphQLContext,
    ): Promise<boolean> => {
      const agent = await requireAgent(context, MAX_CADDY_CONFIG_BYTES);

      settleResults(agent.agentId, args.results);
      return true;
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
