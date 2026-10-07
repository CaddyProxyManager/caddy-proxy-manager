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
  restoreHost,
  rollbackHost,
} from "../host-history";
import type { HostKind } from "../host-history/types";
import { type GraphQLContext, requireAdmin } from "./context";

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
    context: GraphQLContext,
  ) => {
    await requireAdmin(context);
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
  hostRevision: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    await requireAdmin(context);
    const revision = await getHostRevision(args.id);
    return revision ? revisionForApi(revision) : null;
  },
  compareHostRevisions: async (
    _: unknown,
    args: { kind: string; hostId: number; from: number; to: number; config?: boolean | null },
    context: GraphQLContext,
  ) => {
    await requireAdmin(context);
    return compareHostRevisions(kindOf(args.kind), args.hostId, args.from, args.to, {
      config: args.config === true,
    });
  },
  deletedHosts: async (_: unknown, args: { kind: string }, context: GraphQLContext) => {
    await requireAdmin(context);
    return listDeletedHosts(kindOf(args.kind));
  },
};

export const hostHistoryMutationResolvers = {
  rollbackHost: async (_: unknown, args: { revisionId: number }, context: GraphQLContext) => {
    const { userId } = await requireAdmin(context);
    const { revisionId } = await rollbackHost(args.revisionId, userId);
    return revisionOrThrow(revisionId);
  },
  restoreHost: async (
    _: unknown,
    args: { revisionId: number; dropMissingReferences?: boolean | null },
    context: GraphQLContext,
  ) => {
    const { userId } = await requireAdmin(context);
    const { revisionId } = await restoreHost(args.revisionId, userId, {
      dropMissingReferences: args.dropMissingReferences === true,
    });
    return revisionOrThrow(revisionId);
  },
};
