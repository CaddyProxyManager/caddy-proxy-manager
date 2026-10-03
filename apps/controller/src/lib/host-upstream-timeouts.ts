/**
 * Per-host upstream timeouts, as Caddy duration strings. Most belong to the reverse_proxy's http
 * transport, the stream pair to the handler itself. Server read/write/idle timeouts are per
 * listener, like protocols, so a host cannot have its own.
 */
import { isCaddyDuration } from "./caddy-duration";
import { domainError } from "./domain-error";

export const UPSTREAM_TIMEOUT_KEYS = [
  "dialTimeout",
  "responseHeaderTimeout",
  "readTimeout",
  "writeTimeout",
  "keepAliveIdleTimeout",
  "streamTimeout",
  "streamCloseDelay",
] as const;
export type UpstreamTimeoutKey = (typeof UPSTREAM_TIMEOUT_KEYS)[number];

const STORED_KEYS = {
  dialTimeout: "dial_timeout",
  responseHeaderTimeout: "response_header_timeout",
  readTimeout: "read_timeout",
  writeTimeout: "write_timeout",
  keepAliveIdleTimeout: "keep_alive_idle_timeout",
  streamTimeout: "stream_timeout",
  streamCloseDelay: "stream_close_delay",
} as const satisfies Record<UpstreamTimeoutKey, string>;

/** As stored in the host's meta. */
export type HostUpstreamTimeoutsMeta = Partial<
  Record<(typeof STORED_KEYS)[UpstreamTimeoutKey], string>
>;

/** As the API and the editor see it; null keeps Caddy's default. */
export type HostUpstreamTimeoutsConfig = Record<UpstreamTimeoutKey, string | null>;

/** Of the API shape or the stored one. */
function build(
  value: unknown,
  onInvalid: (value: string) => void,
): HostUpstreamTimeoutsMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const meta: HostUpstreamTimeoutsMeta = {};
  for (const key of UPSTREAM_TIMEOUT_KEYS) {
    const stored = STORED_KEYS[key];
    const entry = raw[stored] ?? raw[key];
    if (entry === undefined || entry === null) continue;
    const text = typeof entry === "string" ? entry.trim() : String(entry);
    if (!text) continue;
    if (!isCaddyDuration(text)) {
      onInvalid(text);
      continue;
    }
    meta[stored] = text;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/** A stored blob: an unreadable value is dropped rather than failing the whole Caddy config. */
export function sanitizeHostUpstreamTimeouts(value: unknown): HostUpstreamTimeoutsMeta | undefined {
  return build(value, () => {});
}

/** From the editor or the API: a value that is not a duration is refused. */
export function normalizeHostUpstreamTimeoutsInput(
  value: unknown,
): HostUpstreamTimeoutsMeta | undefined {
  return build(value, (text) => {
    throw domainError("hostUpstreamTimeoutInvalid", { value: text }, { status: 400 });
  });
}

export function hydrateHostUpstreamTimeouts(
  meta: HostUpstreamTimeoutsMeta | undefined,
): HostUpstreamTimeoutsConfig | null {
  if (!meta) return null;
  return Object.fromEntries(
    UPSTREAM_TIMEOUT_KEYS.map((key) => [key, meta[STORED_KEYS[key]] ?? null]),
  ) as HostUpstreamTimeoutsConfig;
}

/** The http transport's fields. Caddy fills keep_alive's other fields from its defaults one by one. */
export function transportTimeoutFields(
  meta: HostUpstreamTimeoutsMeta | undefined,
): Record<string, unknown> {
  if (!meta) return {};
  const fields: Record<string, unknown> = {};
  for (const key of [
    "dial_timeout",
    "response_header_timeout",
    "read_timeout",
    "write_timeout",
  ] as const) {
    if (meta[key]) fields[key] = meta[key];
  }
  if (meta.keep_alive_idle_timeout) {
    fields.keep_alive = { idle_timeout: meta.keep_alive_idle_timeout };
  }
  return fields;
}

/** The reverse_proxy handler's own: how long a WebSocket or other stream may stay open. */
export function handlerTimeoutFields(
  meta: HostUpstreamTimeoutsMeta | undefined,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (meta?.stream_timeout) fields.stream_timeout = meta.stream_timeout;
  if (meta?.stream_close_delay) fields.stream_close_delay = meta.stream_close_delay;
  return fields;
}
