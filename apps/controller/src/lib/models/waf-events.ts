import {
  queryWafCount,
  queryWafCountWithSearch,
  queryWafEventStatsWithSearch,
  queryTopWafRulesWithHosts,
  queryWafCountries,
  queryWafRuleMessages,
  queryWafEvents,
  type WafEvent,
  type WafEventStats,
  type TopWafRule,
  type TopWafRuleWithHosts,
  type WafEventFilter,
} from "../clickhouse/client";
import { isConnectionError } from "../errors/net-errors";

export type { WafEvent, WafEventStats, TopWafRule, TopWafRuleWithHosts, WafEventFilter };

const EMPTY_WAF_STATS: WafEventStats = {
  total: 0,
  blocked: 0,
  critical: 0,
  uniqueHosts: 0,
  ruleIdsTriggered: 0,
};

/**
 * The ClickHouse client rejects with anything from a coded error to a bare wrapper, so the shared
 * check walks the cause chain for both a connection code and the runtime's message.
 */
function isClickHouseConnectionError(error: unknown): boolean {
  return isConnectionError(error);
}

async function withWafAnalyticsFallback<T>(
  operation: string,
  fallback: T,
  query: () => Promise<T>,
): Promise<T> {
  try {
    return await query();
  } catch (error) {
    if (isClickHouseConnectionError(error)) {
      console.warn(
        `[waf-events] ClickHouse unavailable during ${operation}; returning empty WAF analytics.`,
      );
      return fallback;
    }
    throw error;
  }
}

export async function countWafEvents(
  filter?: string | WafEventFilter,
  from?: number,
  to?: number,
): Promise<number> {
  return withWafAnalyticsFallback("countWafEvents", 0, () =>
    queryWafCountWithSearch(filter, from, to),
  );
}

export async function getWafEventStats(
  filter?: string | WafEventFilter,
  from?: number,
  to?: number,
): Promise<WafEventStats> {
  return withWafAnalyticsFallback("getWafEventStats", EMPTY_WAF_STATS, () =>
    queryWafEventStatsWithSearch(filter, from, to),
  );
}

export async function countWafEventsInRange(from: number, to: number): Promise<number> {
  return withWafAnalyticsFallback("countWafEventsInRange", 0, () => queryWafCount(from, to));
}

export async function getTopWafRulesWithHosts(
  from: number,
  to: number,
  limit = 10,
): Promise<TopWafRuleWithHosts[]> {
  return withWafAnalyticsFallback("getTopWafRulesWithHosts", [], () =>
    queryTopWafRulesWithHosts(from, to, limit),
  );
}

export async function getWafEventCountries(
  from: number,
  to: number,
): Promise<{ countryCode: string; count: number }[]> {
  return withWafAnalyticsFallback("getWafEventCountries", [], () => queryWafCountries(from, to));
}

export async function getWafRuleMessages(
  ruleIds: number[],
): Promise<Record<number, string | null>> {
  return withWafAnalyticsFallback("getWafRuleMessages", {}, () => queryWafRuleMessages(ruleIds));
}

export async function listWafEvents(
  limit = 50,
  offset = 0,
  filter?: string | WafEventFilter,
  from?: number,
  to?: number,
): Promise<WafEvent[]> {
  return withWafAnalyticsFallback("listWafEvents", [], () =>
    queryWafEvents(limit, offset, filter, from, to),
  );
}
