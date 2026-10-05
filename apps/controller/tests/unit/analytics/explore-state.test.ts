/** The analytics page's URL state: what a link may say, and what it settles to. */
import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_EXPLORE_STATE,
  MAX_CUSTOM_RANGE_SECONDS,
  MAX_FILTERS,
  autoRefreshes,
  decodeFilter,
  encodeFilter,
  normalizeFilterValue,
  parseExploreState,
  previousWindow,
  resolveWindow,
  serializeExploreState,
  withFilter,
} from '@/src/lib/analytics/explore-state';

const parse = (query: string) => parseExploreState(new URLSearchParams(query));

describe('parseExploreState', () => {
  it('reads an empty query as the defaults', () => {
    expect(parse('')).toEqual(DEFAULT_EXPLORE_STATE);
  });

  it('reads every part of a full query', () => {
    expect(
      parse(
        'range=7d&compare=0&group=outcome&f=host:is:App.Example.com&f=status:not:5XX&log=mitigated',
      ),
    ).toEqual({
      range: '7d',
      from: null,
      to: null,
      compare: false,
      group: 'outcome',
      filters: [
        { field: 'host', op: 'is', value: 'app.example.com' },
        { field: 'status', op: 'not', value: '5xx' },
      ],
      mitigatedOnly: true,
    });
  });

  it('falls back on a range, group or filter it does not know', () => {
    const state = parse('range=1y&group=planet&f=planet:is:mars&f=host:maybe:x&f=status:is:999');
    expect(state.range).toBe('24h');
    expect(state.group).toBe('none');
    expect(state.filters).toEqual([]);
  });

  it('takes a custom range only with both ends in order', () => {
    expect(parse('range=custom&from=100&to=200')).toMatchObject({
      range: 'custom',
      from: 100,
      to: 200,
    });
    expect(parse('range=custom&from=200&to=100').range).toBe('24h');
    expect(parse('range=custom&from=abc&to=200').range).toBe('24h');
  });

  it('cuts a custom range longer than 92 days at its start', () => {
    const to = 2_000_000_000;
    const state = parse(`range=custom&from=0&to=${to}`);
    expect(state.to).toBe(to);
    expect(state.from).toBe(to - MAX_CUSTOM_RANGE_SECONDS);
  });

  it('keeps a filter value that holds colons, such as an IPv6 address', () => {
    expect(parse('f=ip:is:2001:db8::1').filters).toEqual([
      { field: 'ip', op: 'is', value: '2001:db8::1' },
    ]);
  });

  it('drops duplicate filters and caps how many a link may carry', () => {
    const many = Array.from({ length: MAX_FILTERS + 5 }, (_, i) => `f=path:is:/p${i}`).join('&');
    expect(parse(`f=path:is:/a&f=path:is:/a`).filters).toHaveLength(1);
    expect(parse(many).filters).toHaveLength(MAX_FILTERS);
  });
});

describe('serializeExploreState', () => {
  it('writes nothing for the defaults', () => {
    expect(serializeExploreState(DEFAULT_EXPLORE_STATE).toString()).toBe('');
  });

  it('round-trips a full state', () => {
    const query =
      'range=custom&from=100&to=200&compare=0&group=host&f=outcome%3Ais%3Awaf&log=mitigated';
    expect(serializeExploreState(parse(query)).toString()).toBe(query);
  });
});

describe('normalizeFilterValue', () => {
  it('accepts a status code or class, and nothing else', () => {
    expect(normalizeFilterValue('status', '404')).toBe('404');
    expect(normalizeFilterValue('status', '5XX')).toBe('5xx');
    expect(normalizeFilterValue('status', '600')).toBeNull();
    expect(normalizeFilterValue('status', 'error')).toBeNull();
  });

  it('reads an ASN with or without its prefix', () => {
    expect(normalizeFilterValue('asn', 'AS15169')).toBe('15169');
    expect(normalizeFilterValue('asn', '64500')).toBe('64500');
    expect(normalizeFilterValue('asn', 'google')).toBeNull();
  });

  it('knows the outcomes, country codes and methods', () => {
    expect(normalizeFilterValue('outcome', 'rate_limit')).toBe('rate_limit');
    expect(normalizeFilterValue('outcome', 'nope')).toBeNull();
    expect(normalizeFilterValue('country', 'de')).toBe('DE');
    expect(normalizeFilterValue('country', 'DEU')).toBeNull();
    expect(normalizeFilterValue('method', 'post')).toBe('POST');
  });

  it('refuses an empty or oversized value', () => {
    expect(normalizeFilterValue('path', '   ')).toBeNull();
    expect(normalizeFilterValue('path', `/${'a'.repeat(600)}`)).toBeNull();
  });
});

describe('filters', () => {
  it('encode and decode back', () => {
    const filter = { field: 'path' as const, op: 'not' as const, value: '/a:b' };
    expect(decodeFilter(encodeFilter(filter))).toEqual(filter);
  });

  it('replace an opposite filter on the same value rather than stacking', () => {
    const once = withFilter(DEFAULT_EXPLORE_STATE, { field: 'host', op: 'is', value: 'a.example' });
    const flipped = withFilter(once, { field: 'host', op: 'not', value: 'a.example' });
    expect(flipped.filters).toEqual([{ field: 'host', op: 'not', value: 'a.example' }]);
  });
});

describe('windows', () => {
  const now = 1_800_000_000;

  it('ends a preset range now', () => {
    expect(resolveWindow(parse('range=1h'), now)).toEqual({ from: now - 3600, to: now });
  });

  it('keeps a custom range, cut off at now', () => {
    expect(resolveWindow(parse('range=custom&from=100&to=200'), now)).toEqual({
      from: 100,
      to: 200,
    });
    expect(resolveWindow(parse(`range=custom&from=${now - 60}&to=${now + 3600}`), now)).toEqual({
      from: now - 60,
      to: now,
    });
  });

  it('puts the previous period immediately before, the same length', () => {
    expect(previousWindow({ from: 1000, to: 1600 })).toEqual({ from: 400, to: 1000 });
  });

  it('refreshes ranges of a day or less, and never a custom one', () => {
    expect(autoRefreshes(parse('range=1h'))).toBe(true);
    expect(autoRefreshes(parse(''))).toBe(true);
    expect(autoRefreshes(parse('range=7d'))).toBe(false);
    expect(autoRefreshes(parse('range=custom&from=100&to=200'))).toBe(false);
  });
});
