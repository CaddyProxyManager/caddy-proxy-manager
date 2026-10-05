/**
 * Lookups the controller does itself: pinning upstreams to addresses, and the hostnames in
 * access-list IP rules. Caddy never sees a name from either.
 */
import type { Resolver } from "node:dns/promises";
import { toDurationMs } from "../caddy/utils";
import type { DnsSettings, UpstreamDnsAddressFamily } from "../settings";

export type DnsResolverRouteConfig = {
  enabled: boolean;
  resolvers: string[];
  fallbacks: string[] | null;
  timeout: string | null;
};

export function getLookupServers(
  dnsConfig: DnsResolverRouteConfig | null,
  globalDnsSettings: DnsSettings | null,
): string[] {
  if (dnsConfig?.enabled && dnsConfig.resolvers.length > 0) {
    const servers = [...dnsConfig.resolvers];
    if (dnsConfig.fallbacks && dnsConfig.fallbacks.length > 0) {
      servers.push(...dnsConfig.fallbacks);
    }
    return servers;
  }

  if (
    globalDnsSettings?.enabled &&
    Array.isArray(globalDnsSettings.resolvers) &&
    globalDnsSettings.resolvers.length > 0
  ) {
    const servers = [...globalDnsSettings.resolvers];
    if (Array.isArray(globalDnsSettings.fallbacks) && globalDnsSettings.fallbacks.length > 0) {
      servers.push(...globalDnsSettings.fallbacks);
    }
    return servers;
  }

  return [];
}

export function getLookupTimeoutMs(
  dnsConfig: DnsResolverRouteConfig | null,
  globalDnsSettings: DnsSettings | null,
): number | null {
  const hostTimeout = toDurationMs(dnsConfig?.timeout ?? null);
  if (hostTimeout !== null) {
    return hostTimeout;
  }

  if (globalDnsSettings?.enabled) {
    const globalTimeout = toDurationMs(globalDnsSettings.timeout ?? null);
    if (globalTimeout !== null) {
      return globalTimeout;
    }
  }

  return null;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | null,
  timeoutLabel: string,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

/**
 * AAAA then A, deduplicated on `key`. Throws only when nothing resolved and a lookup failed, so a
 * name with only one family still answers.
 */
async function lookupFamilies<T>(
  hostname: string,
  family: UpstreamDnsAddressFamily,
  timeoutMs: number | null,
  queries: { v6: () => Promise<T[]>; v4: () => Promise<T[]> },
  key: (item: T) => string,
): Promise<T[]> {
  // Each lookup reports its own failure so the two can run together and still join errors in
  // AAAA-then-A order.
  const lookup = async (
    query: () => Promise<T[]>,
    label: string,
  ): Promise<{ addresses: T[]; error: string | null }> => {
    try {
      return { addresses: await withTimeout(query(), timeoutMs, label), error: null };
    } catch (error) {
      return { addresses: [], error: error instanceof Error ? error.message : String(error) };
    }
  };

  const resolve6 = () => lookup(queries.v6, `AAAA lookup for ${hostname}`);
  const resolve4 = () => lookup(queries.v4, `A lookup for ${hostname}`);

  const results =
    family === "ipv6"
      ? [await resolve6()]
      : family === "ipv4"
        ? [await resolve4()]
        : await Promise.all([resolve6(), resolve4()]);

  const resolved: T[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const result of results) {
    if (result.error !== null) errors.push(result.error);
    for (const address of result.addresses) {
      if (!seen.has(key(address))) {
        seen.add(key(address));
        resolved.push(address);
      }
    }
  }

  if (resolved.length === 0 && errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  return resolved;
}

export function resolveHostnameAddresses(
  resolver: Resolver,
  hostname: string,
  family: UpstreamDnsAddressFamily,
  timeoutMs: number | null,
): Promise<string[]> {
  return lookupFamilies(
    hostname,
    family,
    timeoutMs,
    { v6: () => resolver.resolve6(hostname), v4: () => resolver.resolve4(hostname) },
    (address) => address,
  );
}

export type DnsRecord = { address: string; ttl: number };

/** Both families with their TTLs, for a cache that must know when to ask again. */
export function resolveHostnameRecords(
  resolver: Resolver,
  hostname: string,
  timeoutMs: number | null,
): Promise<DnsRecord[]> {
  return lookupFamilies(
    hostname,
    "both",
    timeoutMs,
    {
      v6: () => resolver.resolve6(hostname, { ttl: true }),
      v4: () => resolver.resolve4(hostname, { ttl: true }),
    },
    (record) => record.address,
  );
}
