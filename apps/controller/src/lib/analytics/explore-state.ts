/**
 * The analytics page's whole state, as it lives in the URL query: a link or a saved view is the
 * page. Client safe, and the server parses the same string, so a hand-edited link is sanitised in
 * one place rather than trusted.
 */

import { TRAFFIC_OUTCOMES, type TrafficOutcome } from "@cpm/shared";

export const ANALYTICS_RANGES = ["1h", "24h", "7d", "30d"] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export const RANGE_SECONDS: Record<AnalyticsRange, number> = {
  "1h": 3600,
  "24h": 86400,
  "7d": 7 * 86400,
  "30d": 30 * 86400,
};

export const MAX_CUSTOM_RANGE_SECONDS = 92 * 86400;

/** Refreshed every 30 seconds; a longer range barely moves in that time. */
export const AUTO_REFRESH_MAX_SECONDS = 86400;
export const AUTO_REFRESH_MS = 30_000;

/** Everything a request that never reached the end of the gates. */
export const MITIGATED_OUTCOMES: readonly TrafficOutcome[] = TRAFFIC_OUTCOMES.filter(
  (outcome) => outcome !== "served",
);

export const FILTER_FIELDS = [
  "host",
  "path",
  "country",
  "asn",
  "status",
  "method",
  "proto",
  "ip",
  "ua",
  "outcome",
  "rule",
] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export type FilterOp = "is" | "not";

export type AnalyticsFilter = { field: FilterField; op: FilterOp; value: string };

export const MAX_FILTERS = 20;
const MAX_FILTER_VALUE = 512;

export const GROUP_BYS = ["none", "outcome", "status", "host"] as const;
export type GroupBy = (typeof GROUP_BYS)[number];

/** Grouped by host, past this many hosts the rest share one series under this key. */
export const MAX_HOST_SERIES = 6;
export const OTHER_SERIES_KEY = "__other__";

export const TOP_DIMENSIONS = [
  "host",
  "path",
  "country",
  "asn",
  "status",
  "ip",
  "ua",
  "method",
  "proto",
  "rule",
] as const;
export type TopDimension = (typeof TOP_DIMENSIONS)[number];

/** The filter a top-list row adds: every list but status is keyed by its own field. */
export const TOP_DIMENSION_FIELD: Record<TopDimension, FilterField> = {
  host: "host",
  path: "path",
  country: "country",
  asn: "asn",
  status: "status",
  ip: "ip",
  ua: "ua",
  method: "method",
  proto: "proto",
  rule: "rule",
};

export const TOP_LIMIT = 10;
export const TOP_VIEW_ALL_LIMIT = 100;

const DEFAULT_RANGE: AnalyticsRange = "24h";

export type ExploreState = {
  range: AnalyticsRange | "custom";
  /** Epoch seconds, only with `range` custom. */
  from: number | null;
  to: number | null;
  compare: boolean;
  group: GroupBy;
  filters: AnalyticsFilter[];
  /** The latest-requests log: everything, or only what a gate stopped. */
  mitigatedOnly: boolean;
};

export const DEFAULT_EXPLORE_STATE: ExploreState = {
  range: DEFAULT_RANGE,
  from: null,
  to: null,
  compare: true,
  group: "none",
  filters: [],
  mitigatedOnly: false,
};

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return (list as readonly unknown[]).includes(value);
}

/** `404` or a class such as `5xx`. */
const STATUS = /^(?:[1-5]\d\d|[1-5]xx)$/;

/** The value as stored, or null for one that can never match and would only confuse a link. */
export function normalizeFilterValue(field: FilterField, raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > MAX_FILTER_VALUE) return null;
  switch (field) {
    case "status":
      return STATUS.test(value.toLowerCase()) ? value.toLowerCase() : null;
    case "asn": {
      const digits = value.replace(/^as/i, "");
      return /^\d{1,10}$/.test(digits) && Number(digits) <= 4_294_967_295 ? digits : null;
    }
    case "rule":
      return /^-?\d{1,10}$/.test(value) && Math.abs(Number(value)) <= 2_147_483_647 ? value : null;
    case "outcome":
      return isOneOf(TRAFFIC_OUTCOMES, value) ? value : null;
    case "country":
      return /^[a-z]{2}$/i.test(value) ? value.toUpperCase() : null;
    case "method":
      return /^[A-Za-z]{1,16}$/.test(value) ? value.toUpperCase() : null;
    case "host":
      return value.toLowerCase();
    default:
      return value;
  }
}

/** `field:op:value`; the value is last so it may hold colons (an IPv6 address, a path). */
export function encodeFilter(filter: AnalyticsFilter): string {
  return `${filter.field}:${filter.op}:${filter.value}`;
}

export function decodeFilter(raw: string): AnalyticsFilter | null {
  const first = raw.indexOf(":");
  const second = first === -1 ? -1 : raw.indexOf(":", first + 1);
  if (second === -1) return null;
  const field = raw.slice(0, first);
  const op = raw.slice(first + 1, second);
  if (!isOneOf(FILTER_FIELDS, field) || (op !== "is" && op !== "not")) return null;
  const value = normalizeFilterValue(field, raw.slice(second + 1));
  return value === null ? null : { field, op, value };
}

function sameFilter(a: AnalyticsFilter, b: AnalyticsFilter): boolean {
  return a.field === b.field && a.op === b.op && a.value === b.value;
}

/** Duplicates dropped, then capped. */
export function dedupeFilters(filters: readonly AnalyticsFilter[]): AnalyticsFilter[] {
  const out: AnalyticsFilter[] = [];
  for (const filter of filters) {
    if (!out.some((kept) => sameFilter(kept, filter))) out.push(filter);
  }
  return out.slice(0, MAX_FILTERS);
}

const EPOCH = /^\d{1,12}$/;

export function parseExploreState(params: URLSearchParams): ExploreState {
  const rangeParam = params.get("range");
  let range: ExploreState["range"] = isOneOf(ANALYTICS_RANGES, rangeParam)
    ? rangeParam
    : DEFAULT_EXPLORE_STATE.range;
  let from: number | null = null;
  let to: number | null = null;
  if (rangeParam === "custom") {
    const f = params.get("from") ?? "";
    const t = params.get("to") ?? "";
    if (EPOCH.test(f) && EPOCH.test(t) && Number(f) < Number(t)) {
      range = "custom";
      from = Number(f);
      // Longer than the cap keeps its end and loses its start.
      to = Number(t);
      if (to - from > MAX_CUSTOM_RANGE_SECONDS) from = to - MAX_CUSTOM_RANGE_SECONDS;
    }
  }
  const group = params.get("group");
  return {
    range,
    from,
    to,
    compare: params.get("compare") !== "0",
    group: isOneOf(GROUP_BYS, group) ? group : DEFAULT_EXPLORE_STATE.group,
    filters: dedupeFilters(
      params
        .getAll("f")
        .map(decodeFilter)
        .filter((filter) => filter !== null),
    ),
    mitigatedOnly: params.get("log") === "mitigated",
  };
}

/** Defaults left out, so the plain page has a plain URL. */
export function serializeExploreState(state: ExploreState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.range === "custom" && state.from !== null && state.to !== null) {
    params.set("range", "custom");
    params.set("from", String(state.from));
    params.set("to", String(state.to));
  } else if (state.range !== "custom" && state.range !== DEFAULT_EXPLORE_STATE.range) {
    params.set("range", state.range);
  }
  if (!state.compare) params.set("compare", "0");
  if (state.group !== "none") params.set("group", state.group);
  for (const filter of state.filters) params.append("f", encodeFilter(filter));
  if (state.mitigatedOnly) params.set("log", "mitigated");
  return params;
}

export type TimeWindow = { from: number; to: number };

/** A preset range ends now; a custom one is as chosen, cut off at now. */
export function resolveWindow(state: ExploreState, now: number): TimeWindow {
  if (state.range === "custom" && state.from !== null && state.to !== null) {
    const to = Math.min(state.to, now);
    return { from: Math.min(state.from, to - 60), to };
  }
  // A custom range missing its ends reads as the default.
  const seconds = RANGE_SECONDS[state.range === "custom" ? DEFAULT_RANGE : state.range];
  return { from: now - seconds, to: now };
}

/** The same length, immediately before. */
export function previousWindow(window: TimeWindow): TimeWindow {
  const length = window.to - window.from;
  return { from: window.from - length, to: window.from };
}

export function autoRefreshes(state: ExploreState): boolean {
  return state.range !== "custom" && RANGE_SECONDS[state.range] <= AUTO_REFRESH_MAX_SECONDS;
}

/** Same field and value replace each other: "is" and "is not" the same thing cannot both hold. */
export function withFilter(state: ExploreState, filter: AnalyticsFilter): ExploreState {
  const rest = state.filters.filter((f) => !(f.field === filter.field && f.value === filter.value));
  return { ...state, filters: dedupeFilters([...rest, filter]) };
}
