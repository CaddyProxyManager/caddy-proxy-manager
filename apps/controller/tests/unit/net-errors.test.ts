/** Bun 1.4 changed fetch rejections and duplicate headers; these shapes come from live fetches. */
import { describe, expect, it } from 'bun:test';
import { isConnectionError } from '@/src/lib/errors/net-errors';
import { lastHeaderValue } from '@/src/lib/http/request-headers';

const coded = (code: string, message = 'failed'): Error => {
  const error = new TypeError(message);
  Object.assign(error, { code });
  return error;
};

describe('isConnectionError', () => {
  it('matches the TypeError Bun rejects with for a refused connection', () => {
    // Bun reports "ConnectionRefused", not "ECONNREFUSED", and sets no cause.
    expect(
      isConnectionError(
        coded('ConnectionRefused', 'Unable to connect. Is the computer able to access the url?'),
      ),
    ).toBe(true);
  });

  it('matches an unresolvable host', () => {
    expect(isConnectionError(coded('ENOTFOUND', 'getaddrinfo ENOTFOUND example.invalid'))).toBe(
      true,
    );
  });

  it("matches Bun's DNS timeout for a service not running on an internal network", () => {
    const error = new Error('DNS lookup timed out');
    Object.assign(error, { name: 'DNSException', code: 'ETIMEOUT', syscall: 'getaddrinfo' });
    expect(isConnectionError(error)).toBe(true);
  });

  it("matches Node's shape, where the code hangs off the cause", () => {
    const error = new TypeError('fetch failed');
    Object.assign(error, { cause: coded('ECONNREFUSED') });
    expect(isConnectionError(error)).toBe(true);
  });

  it('walks nested causes from wrapping clients', () => {
    const inner = coded('FailedToOpenSocket');
    const middle = new Error('clickhouse request failed', { cause: inner });
    const outer = new Error('analytics query failed', { cause: middle });
    expect(isConnectionError(outer)).toBe(true);
  });

  it('does not match an unrelated failure', () => {
    expect(isConnectionError(coded('ERR_INVALID_ARG_TYPE'))).toBe(false);
    expect(isConnectionError(new Error('Caddy config load failed: 500'))).toBe(false);
  });

  it('tolerates non-errors and self-referential causes', () => {
    expect(isConnectionError(null)).toBe(false);
    expect(isConnectionError('ECONNREFUSED')).toBe(false);

    const looping = new Error('loop') as Error & { cause?: unknown };
    looping.cause = looping;
    expect(isConnectionError(looping)).toBe(false);
  });
});

describe('lastHeaderValue', () => {
  it('returns a single value unchanged', () => {
    expect(lastHeaderValue('app.example.com')).toBe('app.example.com');
  });

  it('takes the proxy-supplied value when duplicates were combined', () => {
    // Bun 1.4 joins duplicate headers per the Fetch spec, the client's value first.
    expect(lastHeaderValue('spoofed.example.com, app.example.com')).toBe('app.example.com');
  });

  it('trims whitespace around the segment', () => {
    expect(lastHeaderValue('  10.0.0.1 ,  203.0.113.7  ')).toBe('203.0.113.7');
  });

  it('returns an empty string for a missing or empty header', () => {
    expect(lastHeaderValue(null)).toBe('');
    expect(lastHeaderValue(undefined)).toBe('');
    expect(lastHeaderValue('')).toBe('');
    expect(lastHeaderValue('  ,  ')).toBe('');
  });
});
