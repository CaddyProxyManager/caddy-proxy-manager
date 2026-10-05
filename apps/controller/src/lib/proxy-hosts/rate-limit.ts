/**
 * Rate limiting through the opt-in caddy-ratelimit module. Each zone counts requests per client in
 * a sliding window and answers the rest with a 429 and Retry-After, which the host's error pages
 * then render. Zones come from the host, from Settings, or both. No Node imports: the host editor
 * reads the limits from here.
 */
import { isCaddyDuration } from "../caddy/duration";
import { domainError } from "../errors/domain-error";

export const RATE_LIMIT_KEYS = ["ip", "ip+path", "header", "user"] as const;
export type RateLimitKey = (typeof RATE_LIMIT_KEYS)[number];

/** How a host's own zones combine with the global ones. */
export const RATE_LIMIT_MODES = ["inherit", "merge", "override"] as const;
export type RateLimitMode = (typeof RATE_LIMIT_MODES)[number];

export const RATE_LIMIT_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

export const RATE_LIMIT_MAX_ZONES = 20;
export const RATE_LIMIT_MAX_PATHS = 50;
export const RATE_LIMIT_PATH_MAX_LENGTH = 512;
export const RATE_LIMIT_MAX_EVENTS = 1_000_000;
export const RATE_LIMIT_IPV6_PREFIX_MIN = 1;
export const RATE_LIMIT_IPV6_PREFIX_MAX = 128;
export const RATE_LIMIT_HEADER_MAX_LENGTH = 64;
export const RATE_LIMIT_MAX_ALLOWLIST = 200;

/** An RFC 7230 token: no brace can reach the placeholder the name is put in. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// http.vars.client_ip honours the server's trusted proxies; there is no http.request.client_ip,
// which would expand to empty and put every client in one bucket.
const CLIENT_IP = "{http.vars.client_ip}";
const IP_KEYS: Record<"ip" | "ip+path", string> = {
  ip: CLIENT_IP,
  "ip+path": `${CLIENT_IP} {http.request.uri.path}`,
};

/** As stored in the host's meta and in the `rate_limit` setting. */
export type HostRateLimitZoneMeta = {
  paths?: string[];
  methods?: string[];
  max_events: number;
  window: string;
  key: RateLimitKey;
  /** The header a `header` zone counts by. */
  header?: string;
  ipv6_prefix?: number;
};
export type HostRateLimitMeta = {
  enabled: boolean;
  zones: HostRateLimitZoneMeta[];
  /** Absent on a host stored before global zones existed, which keeps its own zones as before. */
  mode?: RateLimitMode;
};

/** As the API and the editor see it. */
export type HostRateLimitZone = {
  /** Empty covers every request to the host. */
  paths: string[];
  /** Empty covers every method. */
  methods?: string[];
  maxEvents: number;
  window: string;
  key: RateLimitKey;
  header?: string | null;
  /** Counts a whole IPv6 prefix as one client; only for the `ip` key. */
  ipv6Prefix: number | null;
};
export type HostRateLimitConfig = {
  enabled: boolean;
  zones: HostRateLimitZone[];
  /** Always set when read back; a client that leaves it out keeps a host's own zones. */
  mode?: RateLimitMode;
};

/** The global zones and the addresses no zone ever counts. */
export type GlobalRateLimitSettings = {
  enabled: boolean;
  zones: HostRateLimitZoneMeta[];
  /** Normalised CIDRs. */
  allowlist: string[];
};

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

  const methods: string[] = [];
  for (const entry of Array.isArray(raw.methods) ? raw.methods : []) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const method = entry.trim().toUpperCase();
    if (!(RATE_LIMIT_METHODS as readonly string[]).includes(method)) {
      refuse("hostRateLimitMethodInvalid", { value: method.slice(0, 20) });
      continue;
    }
    if (!methods.includes(method)) methods.push(method);
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

  const key: RateLimitKey = (RATE_LIMIT_KEYS as readonly unknown[]).includes(raw.key)
    ? (raw.key as RateLimitKey)
    : "ip";
  const zone: HostRateLimitZoneMeta = { max_events: maxEvents, window, key };
  if (paths.length > 0) zone.paths = paths;
  if (methods.length > 0) zone.methods = methods;

  if (key === "header") {
    const header = typeof raw.header === "string" ? raw.header.trim() : "";
    // A brace would put a placeholder of the caller's choosing into the key.
    if (!HEADER_NAME.test(header) || header.length > RATE_LIMIT_HEADER_MAX_LENGTH) {
      refuse("hostRateLimitHeaderInvalid", { max: RATE_LIMIT_HEADER_MAX_LENGTH });
      return undefined;
    }
    zone.header = header;
  }

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

export function zonesOf(value: unknown, refuse: Refuse): HostRateLimitZoneMeta[] {
  const rawZones = Array.isArray(value) ? value : [];
  if (rawZones.length > RATE_LIMIT_MAX_ZONES) {
    refuse("hostRateLimitTooManyZones", { max: RATE_LIMIT_MAX_ZONES });
  }
  return rawZones
    .slice(0, RATE_LIMIT_MAX_ZONES)
    .map((zone) => zoneOf(zone, refuse))
    .filter((zone): zone is HostRateLimitZoneMeta => Boolean(zone));
}

/** Of the API shape or the stored one. */
function build(value: unknown, refuse: Refuse): HostRateLimitMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const zones = zonesOf(raw.zones, refuse);
  const enabled = raw.enabled === true;
  let mode: RateLimitMode | undefined;
  if ((RATE_LIMIT_MODES as readonly unknown[]).includes(raw.mode)) {
    mode = raw.mode as RateLimitMode;
  } else if (raw.mode !== undefined && raw.mode !== null) {
    refuse("hostRateLimitModeInvalid");
  }
  // Inherit, off and with nothing to remember is the same as never set.
  if (!enabled && zones.length === 0 && (mode === undefined || mode === "inherit")) {
    return undefined;
  }
  return mode === undefined ? { enabled, zones } : { enabled, zones, mode };
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

/** A host stored with zones but no mode predates global zones, and keeps its own as before. */
export function hostRateLimitMode(meta: HostRateLimitMeta | undefined): RateLimitMode {
  if (!meta) return "inherit";
  return meta.mode ?? "merge";
}

export function hydrateZone(zone: HostRateLimitZoneMeta): HostRateLimitZone {
  return {
    paths: zone.paths ?? [],
    methods: zone.methods ?? [],
    maxEvents: zone.max_events,
    window: zone.window,
    key: zone.key,
    header: zone.header ?? null,
    ipv6Prefix: zone.ipv6_prefix ?? null,
  };
}

export function hydrateHostRateLimit(
  meta: HostRateLimitMeta | undefined,
): HostRateLimitConfig | null {
  if (!meta) return null;
  return {
    enabled: meta.enabled,
    zones: meta.zones.map(hydrateZone),
    mode: hostRateLimitMode(meta),
  };
}

/** Zone state is global to Caddy, keyed by name, so the host id keeps hosts' counters apart. */
export function rateLimitZoneName(hostId: number, index: number): string {
  return `h${hostId}_${index}`;
}

/** A global zone counts per host too: inheriting a limit is not sharing one. */
export function globalRateLimitZoneName(hostId: number, index: number): string {
  return `h${hostId}_g${index}`;
}

/** The zones a host enforces, named, after its mode has combined them with the global ones. */
export function effectiveRateLimitZones(
  hostId: number,
  meta: HostRateLimitMeta | undefined,
  global: GlobalRateLimitSettings | null | undefined,
): { name: string; zone: HostRateLimitZoneMeta }[] {
  const host = sanitizeHostRateLimit(meta);
  const mode = hostRateLimitMode(host);
  const own =
    host?.enabled && mode !== "inherit"
      ? host.zones.map((zone, index) => ({ name: rateLimitZoneName(hostId, index), zone }))
      : [];
  const inherited =
    global?.enabled && mode !== "override"
      ? global.zones.map((zone, index) => ({ name: globalRateLimitZoneName(hostId, index), zone }))
      : [];
  return [...inherited, ...own];
}

type Handler = Record<string, unknown>;

/**
 * Matcher sets for one zone, AND-ed: its paths and methods, never the allowlisted addresses, and
 * an optional presence test on a header.
 */
function zoneMatch(
  zone: HostRateLimitZoneMeta,
  allowlist: readonly string[],
  header: { name: string; present: boolean } | null,
): Record<string, unknown>[] | undefined {
  const set: Record<string, unknown> = {};
  if (zone.paths?.length) set.path = [...zone.paths];
  if (zone.methods?.length) set.method = [...zone.methods];
  const not: Record<string, unknown>[] = [];
  if (allowlist.length > 0) not.push({ client_ip: { ranges: [...allowlist] } });
  if (header?.present) set.header = { [header.name]: ["*"] };
  if (header && !header.present) not.push({ header: { [header.name]: ["*"] } });
  if (not.length > 0) set.not = not;
  return Object.keys(set).length > 0 ? [set] : undefined;
}

function limitEntry(
  zone: HostRateLimitZoneMeta,
  key: string,
  match: Record<string, unknown>[] | undefined,
  ipv6Prefix?: number,
): Record<string, unknown> {
  const entry: Record<string, unknown> = { key, window: zone.window, max_events: zone.max_events };
  if (match) entry.match = match;
  if (ipv6Prefix) entry.ipv6_prefix = ipv6Prefix;
  return entry;
}

/**
 * A header or user zone is two: the value when the header is there, the client's address when it
 * is not, so leaving the header off never escapes the limit.
 */
function addZone(
  into: Record<string, Record<string, unknown>>,
  name: string,
  zone: HostRateLimitZoneMeta,
  allowlist: readonly string[],
  keyHeader: string | null,
): void {
  if (zone.key === "ip" || zone.key === "ip+path") {
    into[name] = limitEntry(
      zone,
      IP_KEYS[zone.key],
      zoneMatch(zone, allowlist, null),
      zone.ipv6_prefix,
    );
    return;
  }
  if (!keyHeader) {
    into[name] = limitEntry(zone, CLIENT_IP, zoneMatch(zone, allowlist, null));
    return;
  }
  into[name] = limitEntry(
    zone,
    `{http.request.header.${keyHeader}}`,
    zoneMatch(zone, allowlist, { name: keyHeader, present: true }),
  );
  into[`${name}_ip`] = limitEntry(
    zone,
    CLIENT_IP,
    zoneMatch(zone, allowlist, { name: keyHeader, present: false }),
  );
}

/**
 * Per-key metrics would publish a header's value, an API key say, as a Prometheus label; such a
 * handler keeps none. The module never logs a key unless asked to, and it is not.
 */
function handlerOf(rateLimits: Record<string, Record<string, unknown>>, keyed: boolean) {
  if (Object.keys(rateLimits).length === 0) return null;
  const handler: Handler = { handler: "rate_limit", rate_limits: rateLimits };
  if (keyed) handler.disable_metrics = true;
  return handler;
}

export type RateLimitHandlers = {
  /** In the shared chain, after CrowdSec. */
  pre: Handler | null;
  /** After sign-in, for zones counting the signed-in user. Null without forward auth. */
  postAuth: Handler | null;
};

/**
 * `identityHeader` is where the host's forward auth puts the verified user, stripped from what the
 * client sent; without one a user zone counts the client's address. The events app the module asks
 * for is loaded by Caddy on demand, so the document needs no `events` entry.
 */
export function buildRateLimitHandlers(
  hostId: number,
  meta: HostRateLimitMeta | undefined,
  options: {
    global?: GlobalRateLimitSettings | null;
    identityHeader?: string | null;
  } = {},
): RateLimitHandlers {
  const zones = effectiveRateLimitZones(hostId, meta, options.global);
  const allowlist = options.global?.allowlist ?? [];
  const identity = options.identityHeader ?? null;
  const pre: Record<string, Record<string, unknown>> = {};
  const post: Record<string, Record<string, unknown>> = {};
  let preKeyed = false;
  for (const { name, zone } of zones) {
    if (zone.key === "user" && identity) {
      addZone(post, name, zone, allowlist, identity);
      continue;
    }
    if (zone.key === "header") preKeyed = true;
    addZone(pre, name, zone, allowlist, zone.key === "header" ? (zone.header ?? null) : null);
  }
  return { pre: handlerOf(pre, preKeyed), postAuth: handlerOf(post, true) };
}

/** The shared-chain handler alone, as a host without global zones or forward auth has it. */
export function buildRateLimitHandler(
  hostId: number,
  meta: HostRateLimitMeta | undefined,
): Record<string, unknown> | null {
  return buildRateLimitHandlers(hostId, meta).pre;
}
