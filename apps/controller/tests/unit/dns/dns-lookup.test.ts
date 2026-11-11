/** The controller's own lookups: which servers, how long to wait, and AAAA-then-A merging. */
import { describe, expect, it } from 'bun:test';
import type { Resolver } from 'node:dns/promises';
import {
  getLookupServers,
  getLookupTimeoutMs,
  resolveHostnameAddresses,
  resolveHostnameRecords,
  withTimeout,
} from '@/src/lib/dns/lookup';

const route = (over: Partial<Parameters<typeof getLookupServers>[0] & object> = {}) => ({
  enabled: true,
  resolvers: ['10.0.0.1'],
  fallbacks: null,
  timeout: null,
  ...over,
});
const global = { enabled: true, resolvers: ['1.1.1.1'], fallbacks: ['8.8.8.8'], timeout: '3s' };

/** Answers per family, or throws its message; records carry a TTL when asked for one. */
function resolver(v6: string[] | string, v4: string[] | string): Resolver {
  const answer = (value: string[] | string, options?: { ttl: boolean }) => {
    if (typeof value === 'string') return Promise.reject(new Error(value));
    return Promise.resolve(options?.ttl ? value.map((address) => ({ address, ttl: 60 })) : value);
  };
  return {
    resolve6: (_: string, options?: { ttl: boolean }) => answer(v6, options),
    resolve4: (_: string, options?: { ttl: boolean }) => answer(v4, options),
  } as unknown as Resolver;
}

describe('getLookupServers', () => {
  it("prefers the host's resolvers, then its fallbacks", () => {
    expect(getLookupServers(route({ fallbacks: ['10.0.0.2'] }), global)).toEqual([
      '10.0.0.1',
      '10.0.0.2',
    ]);
    expect(getLookupServers(route(), global)).toEqual(['10.0.0.1']);
  });

  it('falls back to the global settings, and to none', () => {
    expect(getLookupServers(route({ enabled: false }), global)).toEqual(['1.1.1.1', '8.8.8.8']);
    expect(getLookupServers(null, { ...global, fallbacks: undefined })).toEqual(['1.1.1.1']);
    expect(getLookupServers(null, { ...global, enabled: false })).toEqual([]);
    expect(getLookupServers(null, null)).toEqual([]);
  });
});

describe('getLookupTimeoutMs', () => {
  it("prefers the host's timeout, then an enabled global one", () => {
    expect(getLookupTimeoutMs(route({ timeout: '500ms' }), global)).toBe(500);
    expect(getLookupTimeoutMs(route(), global)).toBe(3000);
    expect(getLookupTimeoutMs(route(), { ...global, enabled: false })).toBeNull();
    expect(getLookupTimeoutMs(null, { ...global, timeout: undefined })).toBeNull();
  });
});

describe('withTimeout', () => {
  it('passes through with no timeout, and rejects one that runs over', async () => {
    expect(await withTimeout(Promise.resolve(1), null, 'x')).toBe(1);
    expect(await withTimeout(Promise.resolve(2), 1000, 'x')).toBe(2);
    const never = new Promise<never>(() => {});
    await expect(withTimeout(never, 5, 'slow lookup')).rejects.toThrow(
      'slow lookup timed out after 5ms',
    );
  });
});

describe('resolveHostnameAddresses', () => {
  it('merges both families, AAAA first, without duplicates', async () => {
    const addresses = await resolveHostnameAddresses(
      resolver(['::1', '::1'], ['10.0.0.1']),
      'a.test',
      'both',
      null,
    );
    expect(addresses).toEqual(['::1', '10.0.0.1']);
  });

  it('asks only the family it is limited to', async () => {
    const both = resolver(['::1'], ['10.0.0.1']);
    expect(await resolveHostnameAddresses(both, 'a.test', 'ipv6', null)).toEqual(['::1']);
    expect(await resolveHostnameAddresses(both, 'a.test', 'ipv4', null)).toEqual(['10.0.0.1']);
  });

  it('answers with one family when the other fails, and throws when both do', async () => {
    expect(
      await resolveHostnameAddresses(resolver('ENODATA', ['10.0.0.1']), 'a.test', 'both', null),
    ).toEqual(['10.0.0.1']);
    await expect(
      resolveHostnameAddresses(resolver('no v6', 'no v4'), 'a.test', 'both', null),
    ).rejects.toThrow('no v6; no v4');
  });
});

describe('resolveHostnameRecords', () => {
  it('keeps each address with its TTL', async () => {
    const records = await resolveHostnameRecords(resolver(['::1'], ['10.0.0.1']), 'a.test', null);
    expect(records).toEqual([
      { address: '::1', ttl: 60 },
      { address: '10.0.0.1', ttl: 60 },
    ]);
  });
});
