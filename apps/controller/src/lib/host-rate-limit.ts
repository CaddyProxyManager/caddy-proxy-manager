/**
 * Per-host rate limiting through the opt-in caddy-ratelimit module. Each zone counts requests per
 * client in a sliding window and answers the rest with a 429 and Retry-After, which the host's error
 * pages then render. No Node imports: the host editor reads the limits from here.
 */
import { isCaddyDuration } from "./caddy-duration";
import { domainError } from "./domain-error";

export const RATE_LIMIT_KEYS = ["ip", "ip+path"] as const;
export type RateLimitKey = (typeof RATE_LIMIT_KEYS)[number];

export const RATE_LIMIT_MAX_ZONES = 20;
export const RATE_LIMIT_MAX_PATHS = 50;
export const RATE_LIMIT_PATH_MAX_LENGTH = 512;
export const RATE_LIMIT_MAX_EVENTS = 1_000_000;
export const RATE_LIMIT_IPV6_PREFIX_MIN = 1;
export const RATE_LIMIT_IPV6_PREFIX_MAX = 128;

// http.vars.client_ip honours the server's trusted proxies; there is no http.request.client_ip,
// which would expand to empty and put every client in one bucket.
const CLIENT_IP = "{http.vars.client_ip}";
const KEY_TEMPLATES: Record<RateLimitKey, string> = {
  ip: CLIENT_IP,
  "ip+path": `${CLIENT_IP} {http.request.uri.path}`,
};

/** As stored in the host's meta. */
export type HostRateLimitZoneMeta = {
  paths?: string[];
  max_events: number;
  window: string;
  key: RateLimitKey;
  ipv6_prefix?: number;
};
export type HostRateLimitMeta = { enabled: boolean; zones: HostRateLimitZoneMeta[] };

/** As the API and the editor see it. */
export type HostRateLimitZone = {
  /** Empty covers every request to the host. */
  paths: string[];
  maxEvents: number;
  window: string;
  key: RateLimitKey;
  /** Counts a whole IPv6 prefix as one client; only for the `ip` key. */
  ipv6Prefix: number | null;
};
export type HostRateLimitConfig = { enabled: boolean; zones: HostRateLimitZone[] };

type Refuse = (
  code: Parameters<typeof domainError>[0],
  params?: Record<string, string | number>,
) => void;

/** Caddy refuses a zero window, and a zero duration still matches the duration pattern. */
function isWindow(value: string): boolean {
  return isCaddyDuration(value) && /[1-9]/.test(value.replace(/(?:ns|us|µs|μs|ms|s|m|h|d)/g, ""));
}

function wholeIn(value: unknown, min: number, max: number): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  if (value === null || value === undefined || value === "" || !Number.isInteger(number)) {
    return undefined;
  }
  return number >= min && number <= max ? number : undefined;
}

function zoneOf(value: unknown, refuse: Refuse): HostRateLimitZoneMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;

  const paths: string[] = [];
  const rawPaths = Array.isArray(raw.paths) ? raw.paths : [];
  if (rawPaths.length > RATE_LIMIT_MAX_PATHS) {
    refuse("hostRateLimitTooManyPaths", { max: RATE_LIMIT_MAX_PATHS });
  }
  for (const entry of rawPaths.slice(0, RATE_LIMIT_MAX_PATHS)) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const path = entry.trim();
    // A placeholder in a matcher would read request state; refused rather than stripped.
    if (/[{}\s]/.test(path) || path.length > RATE_LIMIT_PATH_MAX_LENGTH) {
      refuse("hostRateLimitPathInvalid", { value: path.slice(0, 80) });
      continue;
    }
    if (!paths.includes(path)) paths.push(path);
  }

  const maxEvents = wholeIn(raw.max_events ?? raw.maxEvents, 1, RATE_LIMIT_MAX_EVENTS);
  if (maxEvents === undefined) {
    refuse("hostRateLimitMaxEventsInvalid", { max: RATE_LIMIT_MAX_EVENTS });
    return undefined;
  }

  const window = typeof raw.window === "string" ? raw.window.trim() : "";
  if (!isWindow(window)) {
    refuse("hostRateLimitWindowInvalid", { value: window });
    return undefined;
  }

  const key: RateLimitKey = raw.key === "ip+path" ? "ip+path" : "ip";
  const zone: HostRateLimitZoneMeta = { max_events: maxEvents, window, key };
  if (paths.length > 0) zone.paths = paths;

  const rawPrefix = raw.ipv6_prefix ?? raw.ipv6Prefix;
  if (rawPrefix !== undefined && rawPrefix !== null && rawPrefix !== "") {
    const prefix = wholeIn(rawPrefix, RATE_LIMIT_IPV6_PREFIX_MIN, RATE_LIMIT_IPV6_PREFIX_MAX);
    if (prefix === undefined) {
      refuse("hostRateLimitIpv6PrefixInvalid", {
        min: RATE_LIMIT_IPV6_PREFIX_MIN,
        max: RATE_LIMIT_IPV6_PREFIX_MAX,
      });
    } else if (key === "ip") {
      // The module masks the key only when it parses as an address, which ip+path never does.
      zone.ipv6_prefix = prefix;
    }
  }
  return zone;
}

/** Of the API shape or the stored one. */
function build(value: unknown, refuse: Refuse): HostRateLimitMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const rawZones = Array.isArray(raw.zones) ? raw.zones : [];
  if (rawZones.length > RATE_LIMIT_MAX_ZONES) {
    refuse("hostRateLimitTooManyZones", { max: RATE_LIMIT_MAX_ZONES });
  }
  const zones = rawZones
    .slice(0, RATE_LIMIT_MAX_ZONES)
    .map((zone) => zoneOf(zone, refuse))
    .filter((zone): zone is HostRateLimitZoneMeta => Boolean(zone));
  const enabled = raw.enabled === true;
  // Off with nothing to remember is the same as never set.
  return enabled || zones.length > 0 ? { enabled, zones } : undefined;
}

/** A stored blob: an unreadable zone is dropped rather than failing the whole Caddy config. */
export function sanitizeHostRateLimit(value: unknown): HostRateLimitMeta | undefined {
  return build(value, () => {});
}

/** From the editor or the API: anything Caddy would reject is refused. */
export function normalizeHostRateLimitInput(value: unknown): HostRateLimitMeta | undefined {
  return build(value, (code, params) => {
    throw domainError(code, params, { status: 400 });
  });
}

export function hydrateHostRateLimit(
  meta: HostRateLimitMeta | undefined,
): HostRateLimitConfig | null {
  if (!meta) return null;
  return {
    enabled: meta.enabled,
    zones: meta.zones.map((zone) => ({
      paths: zone.paths ?? [],
      maxEvents: zone.max_events,
      window: zone.window,
      key: zone.key,
      ipv6Prefix: zone.ipv6_prefix ?? null,
    })),
  };
}

/** Zone state is global to Caddy, keyed by name, so the host id keeps hosts' counters apart. */
export function rateLimitZoneName(hostId: number, index: number): string {
  return `h${hostId}_${index}`;
}

/**
 * Null when off. The events app it asks for is loaded by Caddy on demand (`ctx.App` instantiates
 * an unconfigured app), so the document needs no `events` entry.
 */
export function buildRateLimitHandler(
  hostId: number,
  meta: HostRateLimitMeta | undefined,
): Record<string, unknown> | null {
  const safe = sanitizeHostRateLimit(meta);
  if (!safe?.enabled || safe.zones.length === 0) return null;
  const rateLimits: Record<string, Record<string, unknown>> = {};
  safe.zones.forEach((zone, index) => {
    const entry: Record<string, unknown> = {
      key: KEY_TEMPLATES[zone.key],
      window: zone.window,
      max_events: zone.max_events,
    };
    if (zone.paths?.length) entry.match = [{ path: zone.paths }];
    if (zone.ipv6_prefix) entry.ipv6_prefix = zone.ipv6_prefix;
    rateLimits[rateLimitZoneName(hostId, index)] = entry;
  });
  return { handler: "rate_limit", rate_limits: rateLimits };
}
