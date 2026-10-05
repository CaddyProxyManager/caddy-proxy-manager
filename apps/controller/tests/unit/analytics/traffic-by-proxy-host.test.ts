/**
 * Folding per-Host-header totals onto host rows, where numbers go wrong with no query wrong:
 * a port left on the authority, a domain in another case, a multi-domain host reporting one.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';

const queryHostTotals = vi.fn();
const isAnalyticsEnabled = vi.fn();

vi.mock('../../../src/lib/clickhouse/client', () => ({
  queryHostTotals,
  isAnalyticsEnabled,
  querySummary: vi.fn(),
  queryTimeline: vi.fn(),
  queryCountries: vi.fn(),
  queryCountryBreakdown: vi.fn(),
  queryProtocols: vi.fn(),
  queryUserAgents: vi.fn(),
  queryBlocked: vi.fn(),
  queryTrafficEvents: vi.fn(),
  queryStatusClasses: vi.fn(),
  queryWafCount: vi.fn(),
  queryDistinctHosts: vi.fn(),
}));

import { getTrafficByProxyHost } from '../../../src/lib/analytics/db';

beforeEach(() => {
  queryHostTotals.mockReset();
  isAnalyticsEnabled.mockReset();
  isAnalyticsEnabled.mockResolvedValue(true);
});

describe('getTrafficByProxyHost', () => {
  it('sums every domain of a host onto its row', async () => {
    queryHostTotals.mockResolvedValue([
      { host: 'media.example.com', total: 100, blocked: 4 },
      { host: 'watch.example.com', total: 50, blocked: 1 },
    ]);

    const result = await getTrafficByProxyHost(0, 1, [
      { id: 7, domains: ['media.example.com', 'watch.example.com'] },
    ]);

    expect(result.byHost.get(7)).toEqual({ total: 150, blocked: 5, serverErrors: 0 });
  });

  it('matches regardless of case and ignores a port on the authority', async () => {
    // Caddy logs the authority as sent, so a non-default port and whatever case the client used
    // both reach ClickHouse intact.
    queryHostTotals.mockResolvedValue([{ host: 'Git.Example.com:8443', total: 12, blocked: 0 }]);

    const result = await getTrafficByProxyHost(0, 1, [{ id: 3, domains: ['git.example.com'] }]);

    expect(result.byHost.get(3)).toEqual({ total: 12, blocked: 0, serverErrors: 0 });
  });

  it('leaves out hosts that took no traffic rather than reporting zero', async () => {
    queryHostTotals.mockResolvedValue([{ host: 'a.example.com', total: 5, blocked: 0 }]);

    const result = await getTrafficByProxyHost(0, 1, [
      { id: 1, domains: ['a.example.com'] },
      { id: 2, domains: ['b.example.com'] },
    ]);

    expect(result.byHost.has(1)).toBe(true);
    expect(result.byHost.has(2)).toBe(false);
  });

  it('does not expand wildcards, since a wildcard never arrives as a Host header', async () => {
    queryHostTotals.mockResolvedValue([{ host: 'one.lab.example.com', total: 9, blocked: 0 }]);

    const result = await getTrafficByProxyHost(0, 1, [{ id: 4, domains: ['*.lab.example.com'] }]);

    expect(result.byHost.has(4)).toBe(false);
  });

  it('reports traffic as available when analytics is on but nothing was recorded', async () => {
    // ClickHouse answers an empty window with no rows, exactly as it does when analytics is off.
    // Only the second may hide the column - a quiet day is a zero worth showing.
    queryHostTotals.mockResolvedValue([]);

    const result = await getTrafficByProxyHost(0, 1, [{ id: 1, domains: ['a.example.com'] }]);

    expect(result.available).toBe(true);
    expect(result.byHost.size).toBe(0);
  });

  it('reports traffic as unavailable when analytics is switched off, without querying', async () => {
    isAnalyticsEnabled.mockResolvedValue(false);

    const result = await getTrafficByProxyHost(0, 1, [{ id: 1, domains: ['a.example.com'] }]);

    expect(result.available).toBe(false);
    expect(queryHostTotals).not.toHaveBeenCalled();
  });

  it('reports traffic as unavailable when ClickHouse cannot be reached', async () => {
    queryHostTotals.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const result = await getTrafficByProxyHost(0, 1, [{ id: 1, domains: ['a.example.com'] }]);

    expect(result.available).toBe(false);
    expect(result.byHost.size).toBe(0);
  });

  it('skips the query for an empty page but still says whether traffic is available', async () => {
    const result = await getTrafficByProxyHost(0, 1, []);

    expect(result.available).toBe(true);
    expect(result.byHost.size).toBe(0);
    expect(queryHostTotals).not.toHaveBeenCalled();
  });
});
