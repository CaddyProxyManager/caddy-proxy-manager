/** WAF exclusions, WAF event detail and review, the security report and the deny list. */

import {
  type BlockedSourceInput,
  createBlockedSource,
  deleteBlockedSource,
  listBlockedSources,
} from "../models/blocked-sources";
import { type WafExclusionInput, listWafExclusions } from "../models/waf-exclusions";
import { apiSubmitter, submitOrApply } from "../approvals";
import { getSecurityReport } from "../security/report";
import { type WafEventVerdict, getWafEventDetail, reviewWafEvent } from "../security/waf-event";
import { type AnalyticsQueryInput, exploreStateFromInput } from "./analytics";
import type { GraphQLContext } from "./context";

export const securityQueryResolvers = {
  wafExclusions: async (_: unknown, __: unknown, _context: GraphQLContext) => {
    return listWafExclusions();
  },
  wafEvent: async (_: unknown, args: { key: string }, _context: GraphQLContext) => {
    const detail = await getWafEventDetail(args.key);
    return { ...detail, rawRecord: detail.event.rawData };
  },
  securityReport: async (
    _: unknown,
    args: { query?: AnalyticsQueryInput | null; page?: number | null },
    _context: GraphQLContext,
  ) => {
    return getSecurityReport(exploreStateFromInput(args.query), args.page ?? 1);
  },
  blockedSources: async (_: unknown, __: unknown, _context: GraphQLContext) => {
    return listBlockedSources();
  },
};

export const securityMutationResolvers = {
  createWafExclusion: async (
    _: unknown,
    args: { input: WafExclusionInput },
    context: GraphQLContext,
  ) => {
    return submitOrApply(apiSubmitter(await context.viewer()), {
      kind: "wafExclusionCreate",
      payload: { input: args.input },
    });
  },
  updateWafExclusion: async (
    _: unknown,
    args: { id: number; input: WafExclusionInput },
    context: GraphQLContext,
  ) => {
    return submitOrApply(apiSubmitter(await context.viewer()), {
      kind: "wafExclusionUpdate",
      payload: { id: args.id, input: args.input },
    });
  },
  deleteWafExclusion: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    await submitOrApply(apiSubmitter(await context.viewer()), {
      kind: "wafExclusionDelete",
      payload: { id: args.id },
    });
    return true;
  },
  reviewWafEvent: async (
    _: unknown,
    args: { key: string; verdict?: string | null },
    context: GraphQLContext,
  ) => {
    const { userId } = await context.viewer();
    return reviewWafEvent(args.key, (args.verdict ?? null) as WafEventVerdict | null, userId);
  },
  createBlockedSource: async (
    _: unknown,
    args: { input: BlockedSourceInput },
    context: GraphQLContext,
  ) => {
    const { userId } = await context.viewer();
    return createBlockedSource(args.input, userId);
  },
  deleteBlockedSource: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    const { userId } = await context.viewer();
    await deleteBlockedSource(args.id, userId);
    return true;
  },
};
