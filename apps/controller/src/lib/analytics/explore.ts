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
  queryExploreTimelineWithTotals,
  queryExploreTop,
  queryExploreTopLists,
  TOP_MAX_LIMIT,
} from "../clickhouse/explore";
import { onAnnouncement } from "../cluster/announcements";
import { liveAnnouncement } from "../live/topics";
import { dropProcessMemo, processMemo } from "../settings/process-memo";
import {
  type ExploreState,
  type TimeWindow,
  type TopDimension,
  TOP_DIMENSIONS,
  TOP_LIMIT,
  TOP_VIEW_ALL_LIMIT,
  previousWindow,
  resolveWindow,
  serializeExploreState,
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

/** Under the page's 30s auto-refresh, so two tabs or a quick reload share one set of scans. */
const REPORT_MEMO_MS = 10_000;

// New rows are what the memo cannot know about. Every replica hears it, and a page told "new
// traffic" would otherwise re-read the report it just loaded.
onAnnouncement(liveAnnouncement("analytics"), () => dropProcessMemo("analytics-report"));

/** `now` is for tests, and bypasses the memo: production reads the clock. */
export async function getAnalyticsReport(
  state: ExploreState,
  now?: number,
): Promise<AnalyticsReport> {
  if (now !== undefined) return buildAnalyticsReport(state, now);
  return processMemo(
    `analytics-report:${serializeExploreState(state).toString()}`,
    () => buildAnalyticsReport(state, Math.floor(Date.now() / 1000)),
    { ttlMs: REPORT_MEMO_MS },
  );
}

async function buildAnalyticsReport(state: ExploreState, now: number): Promise<AnalyticsReport> {
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
  const trafficLimits = Object.fromEntries(
    TOP_DIMENSIONS.filter((dimension) => dimension !== "rule").map((dimension) => [
      dimension,
      dimension === "country" ? TOP_MAX_LIMIT : TOP_LIMIT,
    ]),
  );
  const [current, before, groups, requests, trafficTops, ruleTop] = await Promise.all([
    queryExploreTimelineWithTotals(window, filters, bucketSeconds),
    previous
      ? queryExploreTimelineWithTotals(previous, filters, bucketSeconds)
      : Promise.resolve(null),
    state.group === "none"
      ? Promise.resolve([])
      : queryExploreGroups(window, filters, bucketSeconds, state.group),
    queryExploreRequests(window, filters, state.mitigatedOnly),
    queryExploreTopLists(window, filters, trafficLimits),
    // From the WAF table, so not one of the groupings above.
    queryExploreTop(window, filters, "rule", TOP_LIMIT),
  ]);
  const listOf = (dimension: TopDimension): TopRow[] =>
    dimension === "rule" ? ruleTop : (trafficTops[dimension] ?? []);

  return {
    analyticsDisabled: false,
    loggingDisabled: !(await loggingActive),
    window,
    previousWindow: previous,
    bucketSeconds,
    totals: current.totals,
    previousTotals: before?.totals ?? null,
    timeline: current.timeline,
    previousTimeline: before?.timeline ?? null,
    groups,
    top: Object.fromEntries(
      TOP_DIMENSIONS.map((dimension) => [dimension, listOf(dimension).slice(0, TOP_LIMIT)]),
    ) as Record<TopDimension, TopRow[]>,
    countries: listOf("country"),
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
