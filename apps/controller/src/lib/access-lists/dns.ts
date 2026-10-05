/**
 * Resolves the hostnames in access-list IP rules. Caddy's IP matchers take only ranges, so the
 * controller looks names up, caches the answers, and re-applies when one changes.
 */
import { Resolver } from "node:dns/promises";
import { and, inArray, isNotNull, lt, ne } from "drizzle-orm";
import db from "../db";
import { accessListDnsCache, accessListIpRules } from "../db/schema";
import {
  type DnsRecord,
  getLookupServers,
  getLookupTimeoutMs,
  resolveHostnameRecords,
} from "../dns/lookup";
import { MAX_ADDRESSES_PER_HOSTNAME, splitRuleHostname } from "./rules";
import { getDnsSettings } from "../settings";

/** TTLs are clamped: a 0 would re-resolve every wake, a day would miss a dynamic-DNS update. */
export const MIN_TTL_SECONDS = 60;
export const MAX_TTL_SECONDS = 60 * 60;
/** How long the last known answer outlives failed lookups before the name stands for nothing. */
export const MAX_STALE_MS = 24 * 60 * 60 * 1000;
/** A save waits on this; the refresher retries anything slower within a minute. */
export const SAVE_TIMEOUT_MS = 3000;
const REFRESH_TIMEOUT_MS = 5000;
const WAKE_MS = 60_000;

export type HostnameResolver = (name: string, timeoutMs: number) => Promise<DnsRecord[]>;

export type HostnameResolution = {
  hostname: string;
  addresses: string[];
  resolvedAt: string | null;
  expiresAt: string;
  lastError: string | null;
  lastErrorAt: string | null;
};

const systemResolver: HostnameResolver = async (name, timeoutMs) => {
  const settings = await getDnsSettings();
  const resolver = new Resolver();
  const servers = getLookupServers(null, settings);
  if (servers.length > 0) resolver.setServers(servers);
  // The configured DNS timeout, but never past what a save is willing to wait.
  const configured = getLookupTimeoutMs(null, settings) ?? timeoutMs;
  return resolveHostnameRecords(resolver, name, Math.min(configured, timeoutMs));
};

let activeResolver: HostnameResolver = systemResolver;

/** Tests swap in a fake so nothing reaches real DNS; null restores the system one. */
export function setHostnameResolver(resolver: HostnameResolver | null): void {
  activeResolver = resolver ?? systemResolver;
}

function toResolution(row: typeof accessListDnsCache.$inferSelect): HostnameResolution {
  let addresses: string[] = [];
  try {
    const parsed = JSON.parse(row.addresses);
    if (Array.isArray(parsed)) addresses = parsed.filter((a): a is string => typeof a === "string");
  } catch {
    // An unreadable row stands for nothing until the next lookup rewrites it.
  }
  return {
    hostname: row.hostname,
    addresses,
    resolvedAt: row.resolvedAt,
    expiresAt: row.expiresAt,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt,
  };
}

export async function readHostnameResolutions(
  names?: readonly string[],
): Promise<Map<string, HostnameResolution>> {
  if (names && names.length === 0) return new Map();
  const rows = await (names
    ? db
        .select()
        .from(accessListDnsCache)
        .where(inArray(accessListDnsCache.hostname, [...names]))
    : db.select().from(accessListDnsCache));
  return new Map(rows.map((row) => [row.hostname, toResolution(row)]));
}

/** The bare names (no prefix suffix) the rules look up, each once. */
export function lookupNames(hostnames: readonly (string | null)[]): string[] {
  const names = new Set<string>();
  for (const hostname of hostnames) if (hostname) names.add(splitRuleHostname(hostname).name);
  return [...names];
}

function clampTtl(records: DnsRecord[]): number {
  const ttl = Math.min(...records.map((record) => record.ttl));
  return Math.min(Math.max(Number.isFinite(ttl) ? ttl : 0, MIN_TTL_SECONDS), MAX_TTL_SECONDS);
}

/** Sorted, so a round-robin answer in a new order is not a change. */
function addressSet(records: DnsRecord[]): string[] {
  return [...new Set(records.map((record) => record.address))]
    .sort()
    .slice(0, MAX_ADDRESSES_PER_HOSTNAME);
}

const sameAddresses = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((address, index) => address === b[index]);

async function store(entry: HostnameResolution): Promise<void> {
  const { hostname, ...values } = entry;
  const row = { ...values, addresses: JSON.stringify(values.addresses) };
  await db
    .insert(accessListDnsCache)
    .values({ hostname, ...row })
    .onConflictDoUpdate({ target: accessListDnsCache.hostname, set: row });
}

/**
 * Looks each name up and stores the answer. A failure keeps the last known addresses until they
 * are MAX_STALE_MS old. True when any name now stands for different addresses.
 */
export async function resolveHostnames(
  names: readonly string[],
  options: { now?: number; timeoutMs?: number; resolver?: HostnameResolver } = {},
): Promise<boolean> {
  if (names.length === 0) return false;
  const now = options.now ?? Date.now();
  const resolver = options.resolver ?? activeResolver;
  const timeoutMs = options.timeoutMs ?? REFRESH_TIMEOUT_MS;
  const previous = await readHostnameResolutions(names);

  const changed = await Promise.all(
    names.map(async (hostname) => {
      const before = previous.get(hostname);
      let entry: HostnameResolution;
      try {
        const records = await resolver(hostname, timeoutMs);
        // Worded like the resolver's own failures, which share the field.
        if (records.length === 0) throw new Error(`ENODATA ${hostname}`);
        entry = {
          hostname,
          addresses: addressSet(records),
          resolvedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + clampTtl(records) * 1000).toISOString(),
          lastError: null,
          lastErrorAt: null,
        };
      } catch (error) {
        const resolvedAt = before?.resolvedAt ?? null;
        const fresh = resolvedAt !== null && now - Date.parse(resolvedAt) < MAX_STALE_MS;
        entry = {
          hostname,
          addresses: fresh ? (before?.addresses ?? []) : [],
          resolvedAt,
          expiresAt: new Date(now + MIN_TTL_SECONDS * 1000).toISOString(),
          // English, like the resolver's own messages; shown as the reason beside the name.
          lastError: error instanceof Error ? error.message : String(error),
          lastErrorAt: new Date(now).toISOString(),
        };
      }
      await store(entry);
      return !sameAddresses(before?.addresses ?? [], entry.addresses);
    }),
  );
  return changed.some(Boolean);
}

/**
 * Empties answers older than MAX_STALE_MS. Run before the startup apply too, so a controller that
 * was down for days does not load a stale allow before its first lookup finishes.
 */
export async function expireStaleHostnames(now = Date.now()): Promise<boolean> {
  const cutoff = new Date(now - MAX_STALE_MS).toISOString();
  const expired = await db
    .update(accessListDnsCache)
    .set({ addresses: "[]" })
    .where(
      and(
        isNotNull(accessListDnsCache.resolvedAt),
        lt(accessListDnsCache.resolvedAt, cutoff),
        ne(accessListDnsCache.addresses, "[]"),
      ),
    )
    .returning({ hostname: accessListDnsCache.hostname });
  return expired.length > 0;
}

/**
 * One pass: forget names no rule uses, look up the ones whose answer expired, and apply once if
 * anything a rule stands for changed.
 */
export async function refreshAccessListDns(
  options: { now?: number; resolver?: HostnameResolver; apply?: () => Promise<void> } = {},
): Promise<{ resolved: number; changed: boolean }> {
  const now = options.now ?? Date.now();
  const rules = await db
    .select({ hostname: accessListIpRules.hostname })
    .from(accessListIpRules)
    .where(isNotNull(accessListIpRules.hostname));
  const names = lookupNames(rules.map((rule) => rule.hostname));

  const cached = await readHostnameResolutions();
  const unused = [...cached.keys()].filter((name) => !names.includes(name));
  if (unused.length > 0) {
    await db.delete(accessListDnsCache).where(inArray(accessListDnsCache.hostname, unused));
  }

  const expired = await expireStaleHostnames(now);
  const due = names.filter((name) => {
    const entry = cached.get(name);
    return !entry || Date.parse(entry.expiresAt) <= now;
  });
  const changed = (await resolveHostnames(due, { now, resolver: options.resolver })) || expired;
  if (changed) {
    await (options.apply ?? (async () => (await import("../caddy")).applyCaddyConfig()))();
  }
  return { resolved: due.length, changed };
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Idempotent. A pass still running when the next wake comes is not overlapped. */
export function startAccessListDnsRefresher(): void {
  if (timer) return;
  const wake = () => {
    if (running) return;
    running = true;
    void refreshAccessListDns()
      .catch((error: unknown) => {
        console.error("[access-lists] hostname refresh failed:", error);
      })
      .finally(() => {
        running = false;
      });
  };
  wake();
  timer = setInterval(wake, WAKE_MS);
  timer.unref();
}
