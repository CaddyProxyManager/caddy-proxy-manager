import { describe, it, expect } from 'bun:test';
import {
  expandPrivateRanges,
  formatHostPort,
  PRIVATE_RANGES_CIDRS,
  splitHostPort,
  mergeDeep,
  parseJson,
  parseOptionalJson,
  parseCustomHandlers,
  parseHostPort,
  parseUpstreamTarget,
  formatDialAddress,
  toDurationMs,
  stripCaddyPlaceholders,
} from '@/src/lib/caddy-utils';

// ---------------------------------------------------------------------------
// expandPrivateRanges
// ---------------------------------------------------------------------------

describe('expandPrivateRanges', () => {
  it('returns array unchanged when "private_ranges" is absent', () => {
    expect(expandPrivateRanges(['10.0.0.1', '192.168.1.0/24'])).toEqual([
      '10.0.0.1',
      '192.168.1.0/24',
    ]);
  });

  it('replaces "private_ranges" with all private CIDRs', () => {
    const result = expandPrivateRanges(['private_ranges']);
    expect(result).toEqual(PRIVATE_RANGES_CIDRS);
  });

  it('preserves other entries alongside expanded private_ranges', () => {
    const result = expandPrivateRanges(['1.2.3.4', 'private_ranges', '5.6.7.8']);
    expect(result).toContain('1.2.3.4');
    expect(result).toContain('5.6.7.8');
    for (const cidr of PRIVATE_RANGES_CIDRS) {
      expect(result).toContain(cidr);
    }
  });

  it('handles empty array', () => {
    expect(expandPrivateRanges([])).toEqual([]);
  });

  it('handles multiple private_ranges occurrences', () => {
    const result = expandPrivateRanges(['private_ranges', 'private_ranges']);
    expect(result.length).toBe(PRIVATE_RANGES_CIDRS.length * 2);
  });
});

// ---------------------------------------------------------------------------
// mergeDeep
// ---------------------------------------------------------------------------

describe('mergeDeep', () => {
  it('merges top-level keys', () => {
    const target: Record<string, unknown> = { a: 1 };
    mergeDeep(target, { b: 2 });
    expect(target).toEqual({ a: 1, b: 2 });
  });

  it('overwrites primitive values', () => {
    const target: Record<string, unknown> = { a: 1 };
    mergeDeep(target, { a: 99 });
    expect(target.a).toBe(99);
  });

  it('deep-merges nested objects', () => {
    const target: Record<string, unknown> = { a: { x: 1 } };
    mergeDeep(target, { a: { y: 2 } });
    expect(target).toEqual({ a: { x: 1, y: 2 } });
  });

  it('replaces arrays (does not concat)', () => {
    const target: Record<string, unknown> = { arr: [1, 2] };
    mergeDeep(target, { arr: [3, 4, 5] });
    expect(target.arr).toEqual([3, 4, 5]);
  });

  it('blocks __proto__ pollution', () => {
    const target: Record<string, unknown> = {};
    mergeDeep(target, JSON.parse('{"__proto__":{"polluted":true}}'));
    expect(Object.hasOwn(target, '__proto__')).toBe(false);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('blocks constructor pollution', () => {
    const target: Record<string, unknown> = {};
    mergeDeep(target, { constructor: { name: 'hacked' } });
    expect(Object.hasOwn(target, 'constructor')).toBe(false);
  });

  it('blocks prototype key', () => {
    const target: Record<string, unknown> = {};
    mergeDeep(target, { prototype: { evil: true } });
    expect(Object.hasOwn(target, 'prototype')).toBe(false);
  });

  it('handles deeply nested merge without pollution', () => {
    const target: Record<string, unknown> = { outer: { inner: { val: 1 } } };
    mergeDeep(target, { outer: { inner: { extra: 2 } } });
    expect((target.outer as Record<string, unknown>).inner).toEqual({ val: 1, extra: 2 });
  });
});

// ---------------------------------------------------------------------------
// parseJson
// ---------------------------------------------------------------------------

describe('parseJson', () => {
  it('parses valid JSON', () => {
    expect(parseJson('{"a":1}', {})).toEqual({ a: 1 });
  });

  it('returns fallback for null', () => {
    expect(parseJson(null, 42)).toBe(42);
  });

  it('returns fallback for empty string', () => {
    expect(parseJson('', { default: true })).toEqual({ default: true });
  });

  it('returns fallback for malformed JSON', () => {
    expect(parseJson('not-json{', 'fallback')).toBe('fallback');
  });

  it('parses arrays', () => {
    expect(parseJson('[1,2,3]', [] as number[])).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// parseOptionalJson
// ---------------------------------------------------------------------------

describe('parseOptionalJson', () => {
  it('returns parsed object', () => {
    expect(parseOptionalJson('{"x":1}')).toEqual({ x: 1 });
  });

  it('returns null for null input', () => {
    expect(parseOptionalJson(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseOptionalJson(undefined)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseOptionalJson('{bad')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseCustomHandlers
// ---------------------------------------------------------------------------

describe('parseCustomHandlers', () => {
  it('parses JSON array of objects', () => {
    expect(parseCustomHandlers('[{"handler":"file_server"}]')).toEqual([
      { handler: 'file_server' },
    ]);
  });

  it('wraps single object in array', () => {
    expect(parseCustomHandlers('{"handler":"static_response"}')).toEqual([
      { handler: 'static_response' },
    ]);
  });

  it('filters out non-object entries', () => {
    expect(parseCustomHandlers('[{"ok":true}, 42, "string", null]')).toEqual([{ ok: true }]);
  });

  it('returns empty array for null', () => {
    expect(parseCustomHandlers(null)).toEqual([]);
  });

  it('returns empty array for malformed JSON', () => {
    expect(parseCustomHandlers('{bad')).toEqual([]);
  });

  it('returns empty array for empty array JSON', () => {
    expect(parseCustomHandlers('[]')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseHostPort
// ---------------------------------------------------------------------------

describe('parseHostPort', () => {
  it('parses hostname:port', () => {
    expect(parseHostPort('example.com:8080')).toEqual({ host: 'example.com', port: '8080' });
  });

  it('parses IPv4:port', () => {
    expect(parseHostPort('127.0.0.1:3000')).toEqual({ host: '127.0.0.1', port: '3000' });
  });

  it('parses IPv6 [addr]:port', () => {
    expect(parseHostPort('[::1]:8080')).toEqual({ host: '::1', port: '8080' });
  });

  it('parses full IPv6 address with port', () => {
    expect(parseHostPort('[2001:db8::1]:443')).toEqual({
      host: '2001:db8::1',
      port: '443',
    });
  });

  it('returns null for empty string', () => {
    expect(parseHostPort('')).toBeNull();
  });

  it('returns null for hostname without port', () => {
    expect(parseHostPort('example.com')).toBeNull();
  });

  it('returns null for bare IPv6 without brackets', () => {
    expect(parseHostPort('::1')).toBeNull();
  });

  it('returns null for [bracket but no closing bracket', () => {
    expect(parseHostPort('[::1')).toBeNull();
  });

  it('returns null for IPv6 bracket without port colon', () => {
    expect(parseHostPort('[::1]')).toBeNull();
  });

  it('returns null for port-only', () => {
    expect(parseHostPort(':8080')).toBeNull();
  });

  it('returns null for host-only ending with colon', () => {
    expect(parseHostPort('example.com:')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatDialAddress
// ---------------------------------------------------------------------------

describe('formatDialAddress', () => {
  it('formats IPv4 address normally', () => {
    expect(formatDialAddress('10.0.0.1', '8080')).toBe('10.0.0.1:8080');
  });

  it('wraps IPv6 address in brackets', () => {
    expect(formatDialAddress('::1', '8080')).toBe('[::1]:8080');
  });

  it('wraps full IPv6 in brackets', () => {
    expect(formatDialAddress('2001:db8::1', '443')).toBe('[2001:db8::1]:443');
  });

  it('formats hostname without brackets', () => {
    expect(formatDialAddress('example.com', '80')).toBe('example.com:80');
  });
});

// ---------------------------------------------------------------------------
// parseUpstreamTarget
// ---------------------------------------------------------------------------

describe('parseUpstreamTarget', () => {
  it('parses host:port upstream', () => {
    const r = parseUpstreamTarget('backend:8080');
    expect(r.scheme).toBeNull();
    expect(r.host).toBe('backend');
    expect(r.port).toBe('8080');
    expect(r.dial).toBe('backend:8080');
  });

  it('parses http:// URL and defaults port to 80', () => {
    const r = parseUpstreamTarget('http://service.local');
    expect(r.scheme).toBe('http');
    expect(r.port).toBe('80');
  });

  it('parses https:// URL and defaults port to 443', () => {
    const r = parseUpstreamTarget('https://service.local');
    expect(r.scheme).toBe('https');
    expect(r.port).toBe('443');
  });

  it('parses https:// URL with explicit port', () => {
    const r = parseUpstreamTarget('https://service.local:8443');
    expect(r.scheme).toBe('https');
    expect(r.port).toBe('8443');
  });

  it('wraps IPv6 dial address in brackets', () => {
    const r = parseUpstreamTarget('[::1]:9000');
    expect(r.dial).toBe('[::1]:9000');
  });

  it('handles empty string gracefully', () => {
    const r = parseUpstreamTarget('');
    expect(r.scheme).toBeNull();
    expect(r.host).toBeNull();
  });

  it('handles unparseable non-URL string gracefully', () => {
    const r = parseUpstreamTarget('not-valid-upstream');
    expect(r.scheme).toBeNull();
    expect(r.host).toBeNull();
    expect(r.dial).toBe('not-valid-upstream');
  });
});

// ---------------------------------------------------------------------------
// toDurationMs
// ---------------------------------------------------------------------------

describe('toDurationMs', () => {
  it('parses seconds', () => {
    expect(toDurationMs('5s')).toBe(5000);
  });

  it('parses milliseconds', () => {
    expect(toDurationMs('500ms')).toBe(500);
  });

  it('parses minutes', () => {
    expect(toDurationMs('2m')).toBe(120_000);
  });

  it('parses hours', () => {
    expect(toDurationMs('1h')).toBe(3_600_000);
  });

  it('parses composite: 1m30s', () => {
    expect(toDurationMs('1m30s')).toBe(90_000);
  });

  it('parses composite: 2h30m', () => {
    expect(toDurationMs('2h30m')).toBe(9_000_000);
  });

  it('parses decimal seconds', () => {
    expect(toDurationMs('1.5s')).toBe(1500);
  });

  it('returns null for null input', () => {
    expect(toDurationMs(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(toDurationMs(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(toDurationMs('')).toBeNull();
  });

  it('returns null for plain number without unit', () => {
    expect(toDurationMs('5000')).toBeNull();
  });

  it('returns null for invalid text', () => {
    expect(toDurationMs('invalid')).toBeNull();
  });

  it('returns null for partial match with trailing garbage', () => {
    expect(toDurationMs('5s garbage')).toBeNull();
  });

  it('returns null for zero-duration', () => {
    expect(toDurationMs('0s')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stripCaddyPlaceholders
// ---------------------------------------------------------------------------

describe('stripCaddyPlaceholders', () => {
  it('removes placeholders and leaves the rest of the path', () => {
    expect(stripCaddyPlaceholders('/api/{http.request.uri}/v1')).toBe('/api//v1');
    expect(stripCaddyPlaceholders('/plain/path')).toBe('/plain/path');
  });

  it('stays linear on an unterminated run of braces', () => {
    // The earlier /\{[^}]*\}/g rescanned to end-of-string from every start position.
    const start = performance.now();
    expect(stripCaddyPlaceholders('{'.repeat(100_000))).toBe('{'.repeat(100_000));
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('splitHostPort', () => {
  it('splits a bare port', () => {
    expect(splitHostPort(':5432')).toEqual({ host: '', port: 5432 });
  });

  it('splits a hostname and port', () => {
    expect(splitHostPort('db.internal:5432')).toEqual({ host: 'db.internal', port: 5432 });
  });

  it('splits an IPv4 address and port', () => {
    expect(splitHostPort('10.0.0.1:5432')).toEqual({ host: '10.0.0.1', port: 5432 });
  });

  it('splits a bracketed IPv6 address and port, without the brackets', () => {
    expect(splitHostPort('[2001:db8::1]:5432')).toEqual({ host: '2001:db8::1', port: 5432 });
  });

  it('handles the IPv6 loopback and the unspecified address', () => {
    expect(splitHostPort('[::1]:443')).toEqual({ host: '::1', port: 443 });
    expect(splitHostPort('[::]:443')).toEqual({ host: '::', port: 443 });
  });

  it('refuses a bare IPv6 literal rather than reading its last group as a port', () => {
    // Splitting on the last colon would turn `2001:db8::1` into a listener on port 1.
    expect(splitHostPort('2001:db8::1')).toBeNull();
    expect(splitHostPort('::1')).toBeNull();
    expect(splitHostPort('fe80::1234:5678')).toBeNull();
  });

  it('refuses brackets around something that is not an IPv6 address', () => {
    expect(splitHostPort('[example.com]:443')).toBeNull();
    expect(splitHostPort('[10.0.0.1]:443')).toBeNull();
  });

  it('refuses unbalanced or misplaced brackets', () => {
    expect(splitHostPort('[2001:db8::1:5432')).toBeNull();
    expect(splitHostPort('[2001:db8::1]5432')).toBeNull();
    expect(splitHostPort('[2001:db8::1]')).toBeNull();
  });

  it('refuses a value with no port at all', () => {
    expect(splitHostPort('example.com')).toBeNull();
    expect(splitHostPort('')).toBeNull();
    expect(splitHostPort('   ')).toBeNull();
  });

  it('refuses a port outside the usable range', () => {
    expect(splitHostPort(':0')).toBeNull();
    expect(splitHostPort(':65536')).toBeNull();
    expect(splitHostPort(':99999')).toBeNull();
  });

  it('refuses a port that is not a number', () => {
    expect(splitHostPort('host:http')).toBeNull();
    expect(splitHostPort('host:-1')).toBeNull();
    expect(splitHostPort('host:5432x')).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    expect(splitHostPort('  10.0.0.1:5432  ')).toEqual({ host: '10.0.0.1', port: 5432 });
  });
});

describe('formatHostPort', () => {
  it('brackets an IPv6 address and leaves everything else alone', () => {
    expect(formatHostPort('2001:db8::1', 5432)).toBe('[2001:db8::1]:5432');
    expect(formatHostPort('10.0.0.1', 5432)).toBe('10.0.0.1:5432');
    expect(formatHostPort('db.internal', 5432)).toBe('db.internal:5432');
  });

  it('drops the host entirely when there is none', () => {
    expect(formatHostPort('', 5432)).toBe(':5432');
  });

  it('round-trips with splitHostPort', () => {
    for (const value of ['[2001:db8::1]:5432', '10.0.0.1:5432', 'db.internal:5432', ':5432']) {
      const parsed = splitHostPort(value);
      expect(parsed).not.toBeNull();
      expect(
        formatHostPort((parsed as { host: string }).host, (parsed as { port: number }).port),
      ).toBe(value);
    }
  });
});
