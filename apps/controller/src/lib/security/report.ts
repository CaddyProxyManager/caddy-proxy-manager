/**
 * The security page for one URL state. Mitigated requests come from the access log's outcomes;
 * where those are missing (an agent too old to record them, or a failing query) the page falls
 * back to the WAF event table alone, and with analytics off it shows only the rule set.
 */

import type { TrafficOutcome } from "@cpm/shared";
import {
  type AnalyticsFilter,
  type ExploreState,
  type TimeWindow,
  previousWindow,
  resolveWindow,
} from "../analytics/explore-state";
import { bucketSizeForDuration, isAnalyticsEnabled } from "../clickhouse/client";
import {
  type ExploreSeries,
  bucketStarts,
  queryExploreGroups,
  queryExploreTop,
  queryExploreTotalsWithMitigatedIps,
} from "../clickhouse/explore";
import {
  type SecuritySource,
  queryMitigatedByOutcomeCompared,
  queryTopMitigatedSources,
  queryTopWafSources,
  queryWafEventPage,
  queryWafEventsByHost,
  queryWafTimeline,
  queryWafTotals,
} from "../clickhouse/security";
import { listActiveBlockedSources } from "../models/blocked-sources";
import { listProxyHosts } from "../models/proxy-hosts";
import { type WafEvent, redactStoredWafEvent } from "../models/waf-events";
import { listWafExclusionRules } from "../models/waf-exclusions";
import { isConnectionError } from "../errors/net-errors";
import { getWafSettings } from "../settings";
import { CRS_VERSION, effectiveTuning } from "../waf/tuning";
import { getWafEventReviews, type WafEventReview } from "./waf-event";
import { countModes, type WafEngineMode, wafHostModes } from "./waf-hosts";

export const SECURITY_EVENTS_PER_PAGE = 50;
const TOP_LIMIT = 10;

export type SecurityRuleSet = {
  globalMode: WafEngineMode;
  crsLoaded: boolean;
  crsVersion: string;
  paranoiaLevel: number;
  detectionParanoiaLevel: number;
  inboundThreshold: number;
  outboundThreshold: number;
  hosts: Record<WafEngineMode, number>;
  exclusions: number;
  blockedSources: number;
};

export type SecurityPeak = {
  ts: number;
  bucketSeconds: number;
  count: number;
  ip: string | null;
  host: string | null;
  ruleId: number | null;
  ruleMessage: string | null;
};

export type SecurityRule = {
  ruleId: number;
  message: string | null;
  events: number;
  blocked: number;
  sources: number;
  excluded: boolean;
};

export type SecurityReport = {
  /**
   * `traffic`: access-log outcomes; `waf`: WAF events only; `none`: analytics are off;
   * `unavailable`: they are on, but ClickHouse could not be reached.
   */
  source: "traffic" | "waf" | "none" | "unavailable";
  window: TimeWindow;
  previousWindow: TimeWindow;
  bucketSeconds: number;
  ruleSet: SecurityRuleSet;
  totals: {
    requests: number;
    mitigated: number;
    previousMitigated: number;
    sources: number;
    byOutcome: { outcome: string; count: number; previous: number }[];
    topHost: { host: string; count: number } | null;
  };
  /** Bucket starts, index-aligned with every series. */
  buckets: number[];
  series: ExploreSeries[];
  peak: SecurityPeak | null;
  topRules: SecurityRule[];
  topSources: (SecuritySource & { blocked: boolean })[];
  events: {
    items: (WafEvent & { review: WafEventReview | null })[];
    total: number;
    page: number;
    perPage: number;
  };
};

const MITIGATED_FILTER: AnalyticsFilter = { field: "outcome", op: "not", value: "served" };

type RuleSetLists = {
  exclusions: Awaited<ReturnType<typeof listWafExclusionRules>>;
  blocked: Awaited<ReturnType<typeof listActiveBlockedSources>>;
};

/** The lists are the report's own too: read once for both. */
async function ruleSetSummary(
  lists: Promise<RuleSetLists> = loadRuleSetLists(),
): Promise<SecurityRuleSet> {
  const [settings, hosts, { exclusions, blocked }] = await Promise.all([
    getWafSettings(),
    listProxyHosts(),
    lists,
  ]);
  const tuning = effectiveTuning(settings);
  const globalMode: WafEngineMode =
    !settings?.enabled || settings.mode === "Off"
      ? "Off"
      : settings.mode === "DetectionOnly"
        ? "DetectionOnly"
        : "On";
  return {
    globalMode,
    crsLoaded: Boolean(settings?.load_owasp_crs),
    crsVersion: CRS_VERSION,
    paranoiaLevel: tuning.paranoiaLevel,
    detectionParanoiaLevel: tuning.detectionParanoiaLevel,
    inboundThreshold: tuning.inboundThreshold,
    outboundThreshold: tuning.outboundThreshold,
    hosts: countModes(wafHostModes(settings, hosts, null)),
    exclusions: exclusions.length,
    blockedSources: blocked.length,
  };
}

async function loadRuleSetLists(): Promise<RuleSetLists> {
  const [exclusions, blocked] = await Promise.all([
    listWafExclusionRules(),
    listActiveBlockedSources(),
  ]);
  return { exclusions, blocked };
}

function emptyReport(
  window: TimeWindow,
  bucketSeconds: number,
  ruleSet: SecurityRuleSet,
  page: number,
  source: "none" | "unavailable" = "none",
): SecurityReport {
  return {
    source,
    window,
    previousWindow: previousWindow(window),
    bucketSeconds,
    ruleSet,
    totals: {
      requests: 0,
      mitigated: 0,
      previousMitigated: 0,
      sources: 0,
      byOutcome: [],
      topHost: null,
    },
    buckets: [],
    series: [],
    peak: null,
    topRules: [],
    topSources: [],
    events: { items: [], total: 0, page, perPage: SECURITY_EVENTS_PER_PAGE },
  };
}

/** The busiest bucket, and who made it so. */
async function explainPeak(
  buckets: readonly number[],
  series: readonly ExploreSeries[],
  bucketSeconds: number,
  filters: readonly AnalyticsFilter[],
  source: "traffic" | "waf",
): Promise<SecurityPeak | null> {
  const totals = buckets.map((_, i) => series.reduce((sum, s) => sum + (s.counts[i] ?? 0), 0));
  const max = Math.max(0, ...totals);
  if (max === 0) return null;
  const index = totals.indexOf(max);
  const window = { from: buckets[index], to: buckets[index] + bucketSeconds };
  const trafficFilters = [...filters, MITIGATED_FILTER];
  const [ips, hosts, rules] = await Promise.all(
    source === "traffic"
      ? [
          queryExploreTop(window, trafficFilters, "ip", 1),
          queryExploreTop(window, trafficFilters, "host", 1),
          queryExploreTop(window, filters, "rule", 1),
        ]
      : [
          queryTopWafSources(window, filters, 1).then((rows) =>
            rows.map((row) => ({ key: row.ip })),
          ),
          Promise.resolve([] as { key: string }[]),
          queryExploreTop(window, filters, "rule", 1),
        ],
  );
  return {
    ts: buckets[index],
    bucketSeconds,
    count: max,
    ip: ips[0]?.key ?? null,
    host: hosts[0]?.key ?? null,
    ruleId: rules[0] ? Number(rules[0].key) : null,
    ruleMessage: (rules[0] as { label?: string | null } | undefined)?.label ?? null,
  };
}

export async function getSecurityReport(
  state: ExploreState,
  page = 1,
  now = Math.floor(Date.now() / 1000),
): Promise<SecurityReport> {
  const window = resolveWindow(state, now);
  const bucketSeconds = bucketSizeForDuration(window.to - window.from);
  const safePage = Math.max(1, Math.floor(page) || 1);
  const listsPromise = loadRuleSetLists();
  const ruleSetPromise = ruleSetSummary(listsPromise);
  if (!(await isAnalyticsEnabled())) {
    return emptyReport(window, bucketSeconds, await ruleSetPromise, safePage);
  }
  try {
    return await analyticsReport(
      state,
      window,
      bucketSeconds,
      safePage,
      ruleSetPromise,
      listsPromise,
    );
  } catch (error) {
    if (!isConnectionError(error)) throw error;
    console.warn("[security] ClickHouse unavailable; showing the rule set only.");
    return emptyReport(window, bucketSeconds, await ruleSetPromise, safePage, "unavailable");
  }
}

async function analyticsReport(
  state: ExploreState,
  window: TimeWindow,
  bucketSeconds: number,
  safePage: number,
  ruleSetPromise: Promise<SecurityRuleSet>,
  listsPromise: Promise<RuleSetLists>,
): Promise<SecurityReport> {
  const previous = previousWindow(window);
  const { filters } = state;
  const mitigatedFilters = [...filters, MITIGATED_FILTER];
  // Independent of each other: the outcomes and the WAF events are read side by side.
  const [traffic, [wafTotals, previousWafTotals, eventPage, wafRules]] = await Promise.all([
    Promise.all([
      queryExploreTotalsWithMitigatedIps(window, filters),
      queryMitigatedByOutcomeCompared(window, previous, filters),
    ]).catch((error: unknown) => {
      console.warn("[security] access-log outcomes unavailable; showing WAF events only:", error);
      return null;
    }),
    Promise.all([
      queryWafTotals(window, filters),
      queryWafTotals(previous, filters),
      queryWafEventPage(
        window,
        filters,
        SECURITY_EVENTS_PER_PAGE,
        (safePage - 1) * SECURITY_EVENTS_PER_PAGE,
      ),
      queryExploreTop(window, filters, "rule", TOP_LIMIT),
    ]),
  ]);

  // An agent that predates outcomes logs a WAF block as served, so its blocks outnumber them.
  const wafOutcomes = traffic?.[1].current.find((row) => row.outcome === "waf")?.count ?? 0;
  const source: "traffic" | "waf" = traffic && wafOutcomes >= wafTotals.blocked ? "traffic" : "waf";
  const buckets = bucketStarts(window, bucketSeconds);

  let totals: SecurityReport["totals"];
  let series: ExploreSeries[];
  let topSources: SecuritySource[];
  if (source === "traffic" && traffic) {
    const [all, { current: byOutcome, previous: previousByOutcome }] = traffic;
    const sum = (rows: { count: number }[]) => rows.reduce((total, row) => total + row.count, 0);
    const [groups, hosts, sources] = await Promise.all([
      queryExploreGroups(window, mitigatedFilters, bucketSeconds, "outcome"),
      queryExploreTop(window, mitigatedFilters, "host", 1),
      queryTopMitigatedSources(window, filters, TOP_LIMIT),
    ]);
    totals = {
      requests: all.requests,
      mitigated: all.mitigated,
      // Every mitigated request has an outcome, so the groups add up to the window's count.
      previousMitigated: sum(previousByOutcome),
      sources: all.mitigatedIps,
      byOutcome: byOutcome.map((row) => ({
        ...row,
        previous: previousByOutcome.find((p) => p.outcome === row.outcome)?.count ?? 0,
      })),
      topHost: hosts[0] ? { host: hosts[0].key, count: hosts[0].requests } : null,
    };
    series = groups;
    topSources = sources;
  } else {
    const [timeline, sources] = await Promise.all([
      queryWafTimeline(window, filters, bucketSeconds),
      queryTopWafSources(window, filters, TOP_LIMIT),
    ]);
    totals = {
      requests: traffic?.[0].requests ?? 0,
      mitigated: wafTotals.blocked,
      previousMitigated: previousWafTotals.blocked,
      sources: wafTotals.sources,
      byOutcome: [
        {
          outcome: "waf" satisfies TrafficOutcome,
          count: wafTotals.blocked,
          previous: previousWafTotals.blocked,
        },
      ],
      topHost: null,
    };
    series = [
      { key: "waf", counts: timeline.blocked },
      { key: "detected", counts: timeline.detected },
    ];
    topSources = sources;
  }

  const [ruleSet, peak, { blocked, exclusions }, reviews] = await Promise.all([
    ruleSetPromise,
    explainPeak(
      buckets,
      series.filter((s) => s.key !== "detected"),
      bucketSeconds,
      filters,
      source,
    ),
    listsPromise,
    getWafEventReviews(eventPage.items.map((event) => event.key)),
  ]);
  const blockedIps = new Set(blocked.filter((b) => b.kind === "ip").map((b) => b.value));
  const globallyExcluded = new Set(
    exclusions
      .filter((rule) => rule.proxyHostId === null && !rule.path && !rule.target)
      .map((rule) => rule.ruleId),
  );

  return {
    source,
    window,
    previousWindow: previous,
    bucketSeconds,
    ruleSet,
    totals,
    buckets,
    series,
    peak,
    topRules: wafRules.map((row) => ({
      ruleId: Number(row.key),
      message: row.label,
      events: row.requests,
      blocked: row.mitigated,
      sources: row.uniqueIps,
      excluded: globallyExcluded.has(Number(row.key)),
    })),
    topSources: topSources.map((row) => ({ ...row, blocked: blockedIps.has(row.ip) })),
    events: {
      items: eventPage.items.map((event) => ({
        ...redactStoredWafEvent(event),
        review: reviews.get(event.key) ?? null,
      })),
      total: eventPage.total,
      page: safePage,
      perPage: SECURITY_EVENTS_PER_PAGE,
    },
  };
}

/** Per-host WAF modes with the last seven days' events, for the WAF page's host table. */
export async function getWafHostModes(now = Math.floor(Date.now() / 1000)) {
  const [settings, hosts, analytics] = await Promise.all([
    getWafSettings(),
    listProxyHosts(),
    isAnalyticsEnabled(),
  ]);
  const events = analytics
    ? await queryWafEventsByHost(now - 7 * 86_400, now).catch(() => null)
    : null;
  return wafHostModes(settings, hosts, events);
}
