/**
 * Host revisions over GraphQL. Admin only, as the rest of the host API is. A revision is answered
 * as the parsed host its own query returns, never the stored row, so nothing sealed is decrypted
 * and nothing the host query keeps back is handed out here instead.
 */
import { NotFoundError } from "../api/auth";
import { domainError } from "../errors/domain-error";
import {
  type HostRevision,
  compareHostRevisions,
  getHostRevision,
  hostFromSnapshot,
  listDeletedHosts,
  listHostRevisions,
  missingReferences,
} from "../host-history";
import { apiSubmitter, submitOrApply } from "../approvals";
import type { HostKind } from "../host-history/types";
import type { GraphQLContext } from "./context";

const MAX_PAGE = 200;

function kindOf(raw: string): HostKind {
  if (raw === "http" || raw === "l4") return raw;
  throw domainError("hostKindInvalid", {}, { status: 400 });
}

async function revisionForApi(revision: HostRevision) {
  const { snapshot, hostKind, ...summary } = revision;
  return {
    ...summary,
    kind: hostKind,
    host: hostFromSnapshot(hostKind, snapshot),
    agentIds: snapshot.agentIds,
    missingReferences: await missingReferences(hostKind, snapshot),
  };
}

async function revisionOrThrow(id: number) {
  const revision = await getHostRevision(id);
  if (!revision) throw new NotFoundError("Host revision not found");
  return revisionForApi(revision);
}

export const hostHistoryQueryResolvers = {
  hostRevisions: async (
    _: unknown,
    args: { kind: string; hostId: number; limit?: number | null; offset?: number | null },
    _context: GraphQLContext,
  ) => {
    const kind = kindOf(args.kind);
    const limit = Math.min(Math.max(args.limit ?? 20, 1), MAX_PAGE);
    const summaries = await listHostRevisions(
      kind,
      args.hostId,
      limit,
      Math.max(args.offset ?? 0, 0),
    );
    const revisions = await Promise.all(summaries.map((summary) => getHostRevision(summary.id)));
    return Promise.all(
      revisions.filter((revision): revision is HostRevision => !!revision).map(revisionForApi),
    );
  },
  hostRevision: async (_: unknown, args: { id: number }, _context: GraphQLContext) => {
    const revision = await getHostRevision(args.id);
    return revision ? revisionForApi(revision) : null;
  },
  compareHostRevisions: async (
    _: unknown,
    args: { kind: string; hostId: number; from: number; to: number; config?: boolean | null },
    _context: GraphQLContext,
  ) => {
    return compareHostRevisions(kindOf(args.kind), args.hostId, args.from, args.to, {
      config: args.config === true,
    });
  },
  deletedHosts: async (_: unknown, args: { kind: string }, _context: GraphQLContext) => {
    return listDeletedHosts(kindOf(args.kind));
  },
};

export const hostHistoryMutationResolvers = {
  rollbackHost: async (_: unknown, args: { revisionId: number }, context: GraphQLContext) => {
    const { revisionId } = await submitOrApply(apiSubmitter(await context.viewer()), {
      kind: "hostRollback",
      payload: { revisionId: args.revisionId },
    });
    return revisionOrThrow(revisionId);
  },
  restoreHost: async (
    _: unknown,
    args: { revisionId: number; dropMissingReferences?: boolean | null },
    context: GraphQLContext,
  ) => {
    const { revisionId } = await submitOrApply(apiSubmitter(await context.viewer()), {
      kind: "hostRestore",
      payload: {
        revisionId: args.revisionId,
        dropMissingReferences: args.dropMissingReferences === true,
      },
    });
    return revisionOrThrow(revisionId);
  },
};
