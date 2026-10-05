/**
 * Everything the analytics page shows for one URL state, in one round trip: tiles, chart, lists
 * and log share the filters and the window, and per-widget routes would let them disagree.
 */

import { bucketSizeForDuration, isAnalyticsEnabled } from "../clickhouse/client";
import {
  type ExploreBucket,
  type ExploreRequest,
  type ExploreSeries,
  type ExploreTotals,
  type TopRow,
  queryExploreGroups,
  queryExploreRequests,
  queryExploreTimeline,
  queryExploreTop,
  queryExploreTotals,
  TOP_MAX_LIMIT,
} from "../clickhouse/explore";
import {
  type ExploreState,
  type TimeWindow,
  type TopDimension,
  TOP_DIMENSIONS,
  TOP_LIMIT,
  TOP_VIEW_ALL_LIMIT,
  previousWindow,
  resolveWindow,
} from "./explore-state";
import { isLoggingActive } from "./db";

export type {
  ExploreBucket,
  ExploreRequest,
  ExploreSeries,
  ExploreTotals,
  TopRow,
} from "../clickhouse/explore";

export type AnalyticsReport = {
  analyticsDisabled: boolean;
  /** No agent reports an access log, so nothing new is arriving. */
  loggingDisabled: boolean;
  window: TimeWindow;
  previousWindow: TimeWindow | null;
  bucketSeconds: number;
  totals: ExploreTotals;
  previousTotals: ExploreTotals | null;
  timeline: ExploreBucket[];
  /** Index-aligned with `timeline`: bucket i of the period before. */
  previousTimeline: ExploreBucket[] | null;
  groups: ExploreSeries[];
  top: Record<TopDimension, TopRow[]>;
  /** Every country, for the map; `top.country` is its first ten. */
  countries: TopRow[];
  requests: ExploreRequest[];
};

const EMPTY_TOTALS: ExploreTotals = {
  requests: 0,
  bytes: 0,
  uniqueIps: 0,
  mitigated: 0,
  serverErrors: 0,
  avgDurationMs: null,
};

function emptyTop(): Record<TopDimension, TopRow[]> {
  return Object.fromEntries(
    TOP_DIMENSIONS.map((dimension) => [dimension, []]),
  ) as unknown as Record<TopDimension, TopRow[]>;
}

export async function getAnalyticsReport(
  state: ExploreState,
  now = Math.floor(Date.now() / 1000),
): Promise<AnalyticsReport> {
  const window = resolveWindow(state, now);
  const previous = state.compare ? previousWindow(window) : null;
  const bucketSeconds = bucketSizeForDuration(window.to - window.from);

  const loggingActive = isLoggingActive().catch(() => false);
  if (!(await isAnalyticsEnabled())) {
    return {
      analyticsDisabled: true,
      loggingDisabled: !(await loggingActive),
      window,
      previousWindow: previous,
      bucketSeconds,
      totals: EMPTY_TOTALS,
      previousTotals: previous ? EMPTY_TOTALS : null,
      timeline: [],
      previousTimeline: previous ? [] : null,
      groups: [],
      top: emptyTop(),
      countries: [],
      requests: [],
    };
  }

  const { filters } = state;
  const [totals, previousTotals, timeline, previousTimeline, groups, requests, ...tops] =
    await Promise.all([
      queryExploreTotals(window, filters),
      previous ? queryExploreTotals(previous, filters) : Promise.resolve(null),
      queryExploreTimeline(window, filters, bucketSeconds),
      previous ? queryExploreTimeline(previous, filters, bucketSeconds) : Promise.resolve(null),
      state.group === "none"
        ? Promise.resolve([])
        : queryExploreGroups(window, filters, bucketSeconds, state.group),
      queryExploreRequests(window, filters, state.mitigatedOnly),
      ...TOP_DIMENSIONS.map((dimension) =>
        queryExploreTop(
          window,
          filters,
          dimension,
          dimension === "country" ? TOP_MAX_LIMIT : TOP_LIMIT,
        ),
      ),
    ]);
  const countries = tops[TOP_DIMENSIONS.indexOf("country")] ?? [];

  return {
    analyticsDisabled: false,
    loggingDisabled: !(await loggingActive),
    window,
    previousWindow: previous,
    bucketSeconds,
    totals,
    previousTotals,
    timeline,
    previousTimeline,
    groups,
    top: Object.fromEntries(
      TOP_DIMENSIONS.map((dimension, index) => [
        dimension,
        (tops[index] ?? []).slice(0, TOP_LIMIT),
      ]),
    ) as Record<TopDimension, TopRow[]>,
    countries,
    requests,
  };
}

/** One list on its own, up to the view-all length: for "view all" and its CSV. */
export async function getAnalyticsTopList(
  state: ExploreState,
  dimension: TopDimension,
  limit = TOP_VIEW_ALL_LIMIT,
  now = Math.floor(Date.now() / 1000),
): Promise<TopRow[]> {
  if (!(await isAnalyticsEnabled())) return [];
  return queryExploreTop(
    resolveWindow(state, now),
    state.filters,
    dimension,
    Math.min(Math.max(1, limit), TOP_VIEW_ALL_LIMIT),
  );
}
