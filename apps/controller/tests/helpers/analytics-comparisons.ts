/**
 * The combined analytics queries against the one-per-list queries they replace, on whatever store
 * the client is configured for. Each returns [name, combined, separate] for an exact comparison.
 */
import type { AnalyticsFilter, TimeWindow } from '@/src/lib/analytics/explore-state';

const DIMENSIONS = [
  'host',
  'path',
  'country',
  'asn',
  'status',
  'ip',
  'ua',
  'method',
  'proto',
] as const;

const MITIGATED: AnalyticsFilter = { field: 'outcome', op: 'not', value: 'served' };

type Comparison = [name: string, combined: unknown, separate: unknown];

export async function compareCombinedQueries(
  window: TimeWindow,
  filters: AnalyticsFilter[],
): Promise<Comparison[]> {
  const client = await import('@/src/lib/clickhouse/client');
  const explore = await import('@/src/lib/clickhouse/explore');
  const security = await import('@/src/lib/clickhouse/security');
  const label = JSON.stringify(filters);
  const out: Comparison[] = [];

  const limits = Object.fromEntries(DIMENSIONS.map((d) => [d, d === 'country' ? 300 : 10]));
  const combined = await explore.queryExploreTopLists(window, filters, limits);
  for (const dimension of DIMENSIONS) {
    out.push([
      `top ${dimension} ${label}`,
      combined[dimension],
      await explore.queryExploreTop(window, filters, dimension, limits[dimension]),
    ]);
  }

  const bucket = client.bucketSizeForDuration(window.to - window.from);
  const folded = await explore.queryExploreTimelineWithTotals(window, filters, bucket);
  out.push([
    `timeline ${label}`,
    folded.timeline,
    await explore.queryExploreTimeline(window, filters, bucket),
  ]);
  out.push([`totals ${label}`, folded.totals, await explore.queryExploreTotals(window, filters)]);

  const withIps = await explore.queryExploreTotalsWithMitigatedIps(window, filters);
  const mitigated = await explore.queryExploreTotals(window, [...filters, MITIGATED]);
  out.push([
    `mitigated ${label}`,
    [withIps.mitigated, withIps.mitigatedIps],
    [mitigated.requests, mitigated.uniqueIps],
  ]);

  const previous = { from: window.from - (window.to - window.from), to: window.from };
  const compared = await security.queryMitigatedByOutcomeCompared(window, previous, filters);
  const ordered = (rows: { outcome: string; count: number }[]) =>
    [...rows].sort((a, b) => b.count - a.count || (a.outcome < b.outcome ? -1 : 1));
  out.push([
    `outcomes ${label}`,
    compared,
    {
      current: ordered(await security.queryMitigatedByOutcome(window, filters)),
      previous: ordered(await security.queryMitigatedByOutcome(previous, filters)),
    },
  ]);
  const previousMitigated = await explore.queryExploreTotals(previous, [...filters, MITIGATED]);
  out.push([
    `previous mitigated ${label}`,
    compared.previous.reduce((sum, row) => sum + row.count, 0),
    previousMitigated.requests,
  ]);
  return out;
}

/** The filter shapes that change the SQL: none, a column, an outcome, a status class, a rule. */
export function comparisonFilters(ruleId: number): AnalyticsFilter[][] {
  return [
    [],
    [{ field: 'host', op: 'is', value: 'photos.example.com' }],
    [MITIGATED],
    [{ field: 'status', op: 'is', value: '4xx' }],
    [{ field: 'asn', op: 'not', value: '0' }],
    [{ field: 'rule', op: 'is', value: String(ruleId) }],
  ];
}
