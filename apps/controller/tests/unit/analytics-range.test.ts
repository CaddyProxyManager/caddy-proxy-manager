/** A NaN bound from untrusted `from`/`to` matches nothing: "no traffic", not an error. */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { resolveAnalyticsRange, INTERVAL_SECONDS } from '../../src/lib/analytics-db';

const NOW = 1_800_000_000;
const params = (query: string) => new URLSearchParams(query);

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveAnalyticsRange', () => {
  it('takes an explicit window when both bounds are epoch seconds in order', () => {
    expect(resolveAnalyticsRange(params('from=1700000000&to=1700003600'))).toEqual({
      from: 1_700_000_000,
      to: 1_700_003_600,
    });
  });

  it.each([
    ['non-numeric bounds', 'from=abc&to=def'],
    ['a numeric prefix with trailing junk', 'from=1700000000x&to=1700003600'],
    ['scientific notation', 'from=1e9&to=2e9'],
    ['a negative bound', 'from=-5&to=1700003600'],
    ['a reversed window', 'from=1700003600&to=1700000000'],
    ['an empty window', 'from=1700000000&to=1700000000'],
    ['only one bound', 'from=1700000000'],
  ])('falls back to the interval for %s', (_label, query) => {
    expect(resolveAnalyticsRange(params(`${query}&interval=12h`))).toEqual({
      from: NOW - INTERVAL_SECONDS['12h'],
      to: NOW,
    });
  });

  it('uses the named interval when no explicit window is given', () => {
    expect(resolveAnalyticsRange(params('interval=7d'))).toEqual({
      from: NOW - INTERVAL_SECONDS['7d'],
      to: NOW,
    });
  });

  it("falls back to the route's default for an unknown or missing interval", () => {
    expect(resolveAnalyticsRange(params('interval=forever'))).toEqual({
      from: NOW - INTERVAL_SECONDS['1h'],
      to: NOW,
    });
    expect(resolveAnalyticsRange(params(''), '24h')).toEqual({
      from: NOW - INTERVAL_SECONDS['24h'],
      to: NOW,
    });
  });

  it('does not treat inherited object keys as intervals', () => {
    // `in` is true for "toString" on a plain object; the fallback must still apply.
    const result = resolveAnalyticsRange(params('interval=toString'));
    expect(result).toEqual({ from: NOW - INTERVAL_SECONDS['1h'], to: NOW });
  });
});
