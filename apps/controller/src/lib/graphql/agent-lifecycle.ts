/**
 * The agent lifecycle over GraphQL: what Settings → Agent and the Agents page do, through the
 * same functions and guards. The agent's own protocol (agentStatus...) is `./agent.ts`.
 */

import { GraphQLError } from "graphql";
import { NotFoundError } from "../api/auth";
import { ApiValidationError } from "../api/errors";
import {
  BOOTSTRAP_TOKEN_TTL_MS,
  forgetBootstrapAgent,
  isBundledAgent,
  issueBootstrapToken,
} from "../agent/bootstrap";
import { AgentUnavailableError } from "../agent/client";
import { ensurePairingCode, mintRepairCode, revokeRepairCode } from "../agent/pairing-codes";
import { detach } from "../agent/registry";
import { applyCaddyBuild } from "../caddy/image-build";
import { type PairedAgent, deleteAgent, findAgentById, renameAgent } from "../models/agents";
import { assertCanManage } from "../users/permissions";
import type { GraphQLContext } from "./context";

type PairingCodeView = { code: string | null; expiresAt: string; bootstrap: boolean };

async function requireAgent(id: number): Promise<PairedAgent> {
  const agent = await findAgentById(id);
  if (!agent) throw new NotFoundError("Agent not found");
  return agent;
}

/** The bundled agent gets a token on the shared volume, bound to its id; any other a code. */
async function repairCredential(agent: PairedAgent): Promise<PairingCodeView> {
  if (await isBundledAgent(agent.agentId)) {
    const now = Date.now();
    if (!(await issueBootstrapToken(agent.agentId, now))) {
      throw new GraphQLError(
        "The bootstrap token could not be written to the data volume; see the controller log.",
      );
    }
    return {
      code: null,
      expiresAt: new Date(now + BOOTSTRAP_TOKEN_TTL_MS).toISOString(),
      bootstrap: true,
    };
  }
  const { code, expiresAt } = await mintRepairCode(agent.agentId);
  return { code, expiresAt: new Date(expiresAt).toISOString(), bootstrap: false };
}

export const agentLifecycleMutationResolvers = {
  mintAgentPairingCode: async (
    _: unknown,
    args: { agentId?: number | null },
    _context: GraphQLContext,
  ): Promise<PairingCodeView> => {
    if (args.agentId !== undefined && args.agentId !== null) {
      return await repairCredential(await requireAgent(args.agentId));
    }
    const { code, expiresAt } = await ensurePairingCode();
    return { code, expiresAt: new Date(expiresAt).toISOString(), bootstrap: false };
  },

  unpairAgent: async (_: unknown, args: { id: number }, _context: GraphQLContext) => {
    await requireAgent(args.id);
    const agentId = await deleteAgent(args.id);
    if (agentId) {
      await revokeRepairCode(agentId);
      // Or the bundled agent would find a fresh bootstrap token and pair straight back.
      await forgetBootstrapAgent(agentId);
      detach(agentId);
    }
    return true;
  },

  renameAgent: async (
    _: unknown,
    args: { id: number; name: string },
    context: GraphQLContext,
  ): Promise<PairedAgent> => {
    assertCanManage(await context.access(), "agent", args.id);
    const name = args.name.trim();
    if (!name) throw new ApiValidationError("Name is required");
    await requireAgent(args.id);
    await renameAgent(args.id, name);
    return await requireAgent(args.id);
  },

  rebuildAgentCaddy: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    assertCanManage(await context.access(), "agent", args.id);
    await requireAgent(args.id);
    try {
      await applyCaddyBuild(args.id);
    } catch (error) {
      // The app's own wording, which the mask would otherwise replace with "Internal server error".
      if (error instanceof AgentUnavailableError) throw new GraphQLError(error.message);
      throw error;
    }
    return true;
  },
};
