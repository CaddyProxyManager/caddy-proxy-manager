/** Audit sinks over GraphQL. Admin only, as the page is; no URL or header value is ever answered. */
import {
  createSink,
  deleteSink,
  listSinks,
  type SinkInput,
  testSink,
  updateSink,
} from "../audit-stream";
import type { GraphQLContext } from "./context";

export const auditStreamQueryResolvers = {
  auditSinks: async (_: unknown, __: unknown, _context: GraphQLContext) => {
    return listSinks();
  },
};

export const auditStreamMutationResolvers = {
  createAuditSink: async (_: unknown, args: { input: SinkInput }, context: GraphQLContext) => {
    const { userId } = await context.viewer();
    return createSink(args.input, userId);
  },
  updateAuditSink: async (
    _: unknown,
    args: { id: number; input: SinkInput },
    context: GraphQLContext,
  ) => {
    const { userId } = await context.viewer();
    return updateSink(args.id, args.input, userId);
  },
  deleteAuditSink: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    const { userId } = await context.viewer();
    await deleteSink(args.id, userId);
    return true;
  },
  testAuditSink: async (
    _: unknown,
    args: { id?: number | null; input?: SinkInput | null },
    _context: GraphQLContext,
  ) => {
    return testSink(args.id ?? null, args.input ?? null);
  },
};
