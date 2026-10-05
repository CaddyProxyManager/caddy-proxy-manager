/** WAF exclusions, WAF event detail and review, the security report and the deny list. */

import {
  type BlockedSourceInput,
  createBlockedSource,
  deleteBlockedSource,
  listBlockedSources,
} from "../models/blocked-sources";
import {
  type WafExclusionInput,
  createWafExclusion,
  deleteWafExclusion,
  listWafExclusions,
  updateWafExclusion,
} from "../models/waf-exclusions";
import { getSecurityReport } from "../security/report";
import { type WafEventVerdict, getWafEventDetail, reviewWafEvent } from "../security/waf-event";
import { type AnalyticsQueryInput, exploreStateFromInput } from "./analytics";
import { type GraphQLContext, requireAdmin } from "./context";

export const securityQueryResolvers = {
  wafExclusions: async (_: unknown, __: unknown, context: GraphQLContext) => {
    await requireAdmin(context);
    return listWafExclusions();
  },
  wafEvent: async (_: unknown, args: { key: string }, context: GraphQLContext) => {
    await requireAdmin(context);
    const detail = await getWafEventDetail(args.key);
    return { ...detail, rawRecord: detail.event.rawData };
  },
  securityReport: async (
    _: unknown,
    args: { query?: AnalyticsQueryInput | null; page?: number | null },
    context: GraphQLContext,
  ) => {
    await requireAdmin(context);
    return getSecurityReport(exploreStateFromInput(args.query), args.page ?? 1);
  },
  blockedSources: async (_: unknown, __: unknown, context: GraphQLContext) => {
    await requireAdmin(context);
    return listBlockedSources();
  },
};

export const securityMutationResolvers = {
  createWafExclusion: async (
    _: unknown,
    args: { input: WafExclusionInput },
    context: GraphQLContext,
  ) => {
    const { userId } = await requireAdmin(context);
    return createWafExclusion(args.input, userId);
  },
  updateWafExclusion: async (
    _: unknown,
    args: { id: number; input: WafExclusionInput },
    context: GraphQLContext,
  ) => {
    const { userId } = await requireAdmin(context);
    return updateWafExclusion(args.id, args.input, userId);
  },
  deleteWafExclusion: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    const { userId } = await requireAdmin(context);
    await deleteWafExclusion(args.id, userId);
    return true;
  },
  reviewWafEvent: async (
    _: unknown,
    args: { key: string; verdict?: string | null },
    context: GraphQLContext,
  ) => {
    const { userId } = await requireAdmin(context);
    return reviewWafEvent(args.key, (args.verdict ?? null) as WafEventVerdict | null, userId);
  },
  createBlockedSource: async (
    _: unknown,
    args: { input: BlockedSourceInput },
    context: GraphQLContext,
  ) => {
    const { userId } = await requireAdmin(context);
    return createBlockedSource(args.input, userId);
  },
  deleteBlockedSource: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    const { userId } = await requireAdmin(context);
    await deleteBlockedSource(args.id, userId);
    return true;
  },
};
