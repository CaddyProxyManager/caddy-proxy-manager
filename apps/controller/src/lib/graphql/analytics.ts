/**
 * Analytics over GraphQL: the page's report, top lists, traffic signals and saved views. Input is
 * turned into the page's own query string and parsed back, so both are sanitised by one parser.
 */

import { getAnalyticsReport, getAnalyticsTopList } from "../analytics/explore";
import {
  type ExploreState,
  type TopDimension,
  TOP_DIMENSIONS,
  encodeFilter,
  parseExploreState,
} from "../analytics/explore-state";
import { detectTrafficSignals } from "../analytics/signals";
import {
  createAnalyticsView,
  deleteAnalyticsView,
  listAnalyticsViews,
  updateAnalyticsView,
} from "../models/analytics-views";
import { type GraphQLContext, requireAdmin } from "./context";

export type AnalyticsQueryInput = {
  range?: string | null;
  from?: number | null;
  to?: number | null;
  compare?: boolean | null;
  group?: string | null;
  filters?: { field: string; op: string; value: string }[] | null;
  mitigatedOnly?: boolean | null;
};

export function exploreStateFromInput(input: AnalyticsQueryInput | null | undefined): ExploreState {
  const params = new URLSearchParams();
  if (input?.from != null && input.to != null) {
    params.set("range", "custom");
    params.set("from", String(input.from));
    params.set("to", String(input.to));
  } else if (input?.range) {
    params.set("range", input.range);
  }
  if (input?.compare === false) params.set("compare", "0");
  if (input?.group) params.set("group", input.group);
  for (const filter of input?.filters ?? []) {
    params.append("f", encodeFilter(filter as Parameters<typeof encodeFilter>[0]));
  }
  if (input?.mitigatedOnly) params.set("log", "mitigated");
  return parseExploreState(params);
}

const MIN_BUDGET_MS = 100;
const MAX_BUDGET_MS = 10_000;

export const analyticsQueryResolvers = {
  analyticsReport: async (
    _: unknown,
    args: { query?: AnalyticsQueryInput | null },
    context: GraphQLContext,
  ) => {
    await requireAdmin(context);
    const report = await getAnalyticsReport(exploreStateFromInput(args.query));
    return {
      ...report,
      topLists: TOP_DIMENSIONS.map((dimension) => ({ dimension, rows: report.top[dimension] })),
    };
  },
  analyticsTopList: async (
    _: unknown,
    args: { query?: AnalyticsQueryInput | null; dimension: TopDimension; limit?: number | null },
    context: GraphQLContext,
  ) => {
    await requireAdmin(context);
    return getAnalyticsTopList(
      exploreStateFromInput(args.query),
      args.dimension,
      args.limit ?? undefined,
    );
  },
  trafficSignals: async (
    _: unknown,
    args: { from?: number | null; to?: number | null; budgetMs?: number | null },
    context: GraphQLContext,
  ) => {
    await requireAdmin(context);
    const window =
      args.from != null && args.to != null && args.from < args.to
        ? { from: args.from, to: args.to }
        : undefined;
    const budgetMs =
      args.budgetMs == null
        ? undefined
        : Math.min(Math.max(args.budgetMs, MIN_BUDGET_MS), MAX_BUDGET_MS);
    return detectTrafficSignals({ window, budgetMs });
  },
  analyticsViews: async (_: unknown, __: unknown, context: GraphQLContext) => {
    const { userId } = await requireAdmin(context);
    return listAnalyticsViews(userId);
  },
};

export const analyticsMutationResolvers = {
  createAnalyticsView: async (
    _: unknown,
    args: { name: string; query: string; shared?: boolean | null },
    context: GraphQLContext,
  ) => {
    const { userId } = await requireAdmin(context);
    return createAnalyticsView(userId, {
      name: args.name,
      query: args.query,
      shared: args.shared ?? false,
    });
  },
  updateAnalyticsView: async (
    _: unknown,
    args: { id: number; name?: string | null; query?: string | null; shared?: boolean | null },
    context: GraphQLContext,
  ) => {
    const { userId } = await requireAdmin(context);
    return updateAnalyticsView(userId, args.id, {
      name: args.name ?? undefined,
      query: args.query ?? undefined,
      shared: args.shared ?? undefined,
    });
  },
  deleteAnalyticsView: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    const { userId } = await requireAdmin(context);
    await deleteAnalyticsView(userId, args.id);
    return true;
  },
};
