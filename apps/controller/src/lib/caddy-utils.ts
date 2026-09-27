/** Pure helpers extracted from caddy.ts - no DB, network or filesystem, so directly testable. */
import { isIP } from "node:net";

// ── Private range expansion ──────────────────────────────────────────────────

export const PRIVATE_RANGES_CIDRS = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "fd00::/8",
  "::1/128",
];

export function expandPrivateRanges(proxies: string[]): string[] {
  if (!proxies.includes("private_ranges")) return proxies;
  return proxies.flatMap((p) => (p === "private_ranges" ? PRIVATE_RANGES_CIDRS : [p]));
}

// ── Host placeholders ────────────────────────────────────────────────────────

const HOST_PLACEHOLDER_RE = /(?<!\\)\{(?=(?:file|env|system)\.)/g;

/**
 * Caddy expands `{file.*}`, `{env.*}` and `{system.*}` in response bodies and header values, so
 * operator-written text could read the Caddy host. A backslashed brace is served literally, minus
 * the backslash; request placeholders (`{http.*}`) keep working.
 */
export function escapeHostPlaceholders(value: string): string {
  return value.replace(HOST_PLACEHOLDER_RE, "\\{");
}

// ── Header names ─────────────────────────────────────────────────────────────

/** Go's canonical form ("X-Cpm-User"): Caddy's header placeholders look names up literally. */
export function canonicalHeaderName(name: string): string {
  return name
    .split("-")
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part))
    .join("-");
}

/** The `{http.reverse_proxy.header.*}` placeholder, however the caller spelled the name. */
export function upstreamHeaderPlaceholder(name: string): string {
  return `{http.reverse_proxy.header.${canonicalHeaderName(name)}}`;
}

/**
 * The client's own credentials, not an identity assertion: excluded paths, basic auth and the auth
 * server itself need them, so the identity strip leaves them alone.
 */
const CLIENT_CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie"]);

/** Past this, 2^n spellings would bloat the config; only the uniform ones are listed. */
const MAX_ENUMERATED_HEADER_SEPARATORS = 6;

function isClientCredentialHeader(name: string): boolean {
  return CLIENT_CREDENTIAL_HEADERS.has(name.toLowerCase().replace(/_/g, "-"));
}

/** `name` itself first, then every mix of "-" and "_" at its separators. */
function headerSeparatorSpellings(name: string): string[] {
  const parts = name.split(/[-_]/);
  const separators = parts.length - 1;
  if (separators > MAX_ENUMERATED_HEADER_SEPARATORS) {
    return [name, parts.join("-"), parts.join("_")];
  }
  const spellings = [name];
  for (let mask = 0; mask < 1 << separators; mask++) {
    let spelling = parts[0];
    for (let i = 1; i < parts.length; i++) {
      spelling += (mask & (1 << (i - 1)) ? "_" : "-") + parts[i];
    }
    spellings.push(spelling);
  }
  return spellings;
}

/** Deduplicated as Caddy matches them: its delete folds case, not "-" and "_". */
function uniqueSpellings(names: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const name of names) {
    for (const spelling of headerSeparatorSpellings(name)) {
      const key = spelling.toLowerCase();
      if (!unique.has(key)) unique.set(key, spelling);
    }
  }
  return [...unique.values()];
}

/**
 * Deletes client copies of the identity headers an auth server vouches for, in every separator
 * spelling: CGI/WSGI upstreams fold "-" and "_" into one variable (HTTP_X_CPM_USER).
 */
export function buildIdentityHeaderStripHandler(
  headerNames: readonly string[],
): Record<string, unknown> | null {
  const names = uniqueSpellings(headerNames.filter((name) => !isClientCredentialHeader(name)));
  return names.length > 0 ? { handler: "headers", request: { delete: names } } : null;
}

/**
 * The 2xx handle_response routes: copy each header the auth server answered with a value. A listed
 * credential header escapes the strip, so it is removed here when the answer has none - the
 * upstream must only ever see the auth server's value.
 */
export function buildAuthResponseCopyRoutes(
  headerNames: readonly string[],
): Record<string, unknown>[] {
  const routes: Record<string, unknown>[] = [{ handle: [{ handler: "vars" }] }];
  for (const rawName of headerNames) {
    // Canonical, since the placeholder is looked up literally in Go's canonicalised map.
    const headerName = canonicalHeaderName(rawName);
    const placeholder = upstreamHeaderPlaceholder(headerName);
    routes.push({
      handle: [{ handler: "headers", request: { set: { [headerName]: [placeholder] } } }],
      match: [{ not: [{ vars: { [placeholder]: [""] } }] }],
    });
    if (isClientCredentialHeader(headerName)) {
      routes.push({
        handle: [{ handler: "headers", request: { delete: uniqueSpellings([headerName]) } }],
        match: [{ vars: { [placeholder]: [""] } }],
      });
    }
  }
  return routes;
}

// ── Type helpers ─────────────────────────────────────────────────────────────

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ── Deep merge (prototype-pollution safe) ────────────────────────────────────

export function mergeDeep(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const [key, value] of Object.entries(source)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const existing = target[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      mergeDeep(existing, value);
    } else {
      target[key] = value;
    }
  }
}

// ── JSON helpers ─────────────────────────────────────────────────────────────

export function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.warn("Failed to parse JSON value", value, error);
    return fallback;
  }
}

export function parseOptionalJson(value: string | null | undefined) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn("Failed to parse custom JSON", error);
    return null;
  }
}

export function parseCustomHandlers(value: string | null | undefined): Record<string, unknown>[] {
  const parsed = parseOptionalJson(value);
  if (!parsed) return [];
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const handlers: Record<string, unknown>[] = [];
  for (const item of list) {
    if (isPlainObject(item)) {
      handlers.push(item);
    } else {
      console.warn("Ignoring custom handler entry that is not an object", item);
    }
  }
  return handlers;
}

// ── Address / upstream parsing ───────────────────────────────────────────────

export function formatDialAddress(host: string, port: string) {
  return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

export function parseHostPort(value: string): { host: string; port: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("[")) {
    const closeIndex = trimmed.indexOf("]");
    if (closeIndex <= 1) return null;
    const host = trimmed.slice(1, closeIndex);
    const remainder = trimmed.slice(closeIndex + 1);
    if (!remainder.startsWith(":")) return null;
    const port = remainder.slice(1).trim();
    if (!port) return null;
    return { host, port };
  }

  const firstColon = trimmed.indexOf(":");
  const lastColon = trimmed.lastIndexOf(":");
  if (firstColon === -1 || firstColon !== lastColon) return null;

  const host = trimmed.slice(0, lastColon).trim();
  const port = trimmed.slice(lastColon + 1).trim();
  if (!host || !port) return null;

  return { host, port };
}

export type HostPort = {
  /** Empty for a bare `:PORT`, meaning "every address". Never bracketed. */
  host: string;
  port: number;
};

/**
 * `HOST:PORT`, `:PORT` or `[v6]:PORT`. Null for a bare IPv6 literal: `2001:db8::1` would
 * otherwise become a listener on port 1.
 */
export function splitHostPort(value: string): HostPort | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const raw = trimmed.startsWith(":")
    ? { host: "", port: trimmed.slice(1) }
    : parseHostPort(trimmed);
  if (!raw) return null;

  // parseHostPort takes the brackets off but does not check what was inside them.
  if (trimmed.startsWith("[") && isIP(raw.host) !== 6) return null;

  if (!/^\d{1,5}$/.test(raw.port)) return null;
  const port = Number(raw.port);
  if (port < 1 || port > 65535) return null;

  return { host: raw.host, port };
}

/**
 * L4 ports are published on the host, so 2019 would expose the admin API; 9090 is the default
 * metrics listener and 3000 the controller's own port.
 */
export const RESERVED_L4_PORTS: ReadonlySet<number> = new Set([80, 443, 2019, 3000, 9090]);

/** Both the port publisher and the document builder skip such a row, so neither acts alone. */
export function isReservedL4ListenAddress(
  listenAddress: string,
  metricsPort: number | null,
): boolean {
  const parsed = splitHostPort(listenAddress);
  if (!parsed) return false;
  return RESERVED_L4_PORTS.has(parsed.port) || parsed.port === metricsPort;
}

/** The inverse of splitHostPort. */
export function formatHostPort(host: string, port: number): string {
  return host.length === 0 ? `:${port}` : formatDialAddress(host, String(port));
}

export type ParsedUpstreamTarget = {
  original: string;
  dial: string;
  scheme: "http" | "https" | null;
  host: string | null;
  port: string | null;
};

export function parseUpstreamTarget(upstream: string): ParsedUpstreamTarget {
  const trimmed = upstream.trim();
  if (!trimmed) {
    return { original: upstream, dial: upstream, scheme: null, host: null, port: null };
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") {
      const scheme = url.protocol === "https:" ? "https" : "http";
      const port = url.port || (scheme === "https" ? "443" : "80");
      const host = url.hostname;
      return { original: trimmed, dial: formatDialAddress(host, port), scheme, host, port };
    }
  } catch {
    // fall through
  }

  const parsed = parseHostPort(trimmed);
  if (!parsed) {
    return { original: trimmed, dial: trimmed, scheme: null, host: null, port: null };
  }

  return {
    original: trimmed,
    dial: formatDialAddress(parsed.host, parsed.port),
    scheme: null,
    host: parsed.host,
    port: parsed.port,
  };
}

// ── Duration parsing ─────────────────────────────────────────────────────────

export function toDurationMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const regex = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let matched = false;
  let consumed = 0;

  while (true) {
    const match = regex.exec(trimmed);
    if (!match) break;
    matched = true;
    consumed += match[0].length;
    const valueNum = Number.parseFloat(match[1]);
    if (!Number.isFinite(valueNum)) return null;
    const unit = match[2];
    if (unit === "ms") total += valueNum;
    else if (unit === "s") total += valueNum * 1000;
    else if (unit === "m") total += valueNum * 60_000;
    else if (unit === "h") total += valueNum * 3_600_000;
  }

  if (!matched || consumed !== trimmed.length) return null;

  const rounded = Math.round(total);
  return rounded > 0 ? rounded : null;
}

// ── Placeholder stripping ────────────────────────────────────────────────────

/**
 * So a host's own rules cannot reach into request state. The class excludes `{` too: `[^}]*` is
 * quadratic on unterminated braces, and placeholders do not nest.
 */
export function stripCaddyPlaceholders(value: string): string {
  return value.replace(/\{[^{}]*\}/g, "");
}
