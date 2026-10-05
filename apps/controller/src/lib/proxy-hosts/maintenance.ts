/**
 * Maintenance mode for a proxy host: a 503 for everyone outside the bypass ranges, answered before
 * anything else in the host's chain. Unlike disabling the host, the domain keeps its certificate
 * and says why it is down. Its settings are kept while it is off, so the quick toggle restores them.
 */
import { normalizeCidr } from "../access-lists/rules";
import { escapeHostPlaceholders } from "../caddy/utils";
import { domainError } from "../errors/domain-error";
import {
  MAINTENANCE_BODY_MAX,
  MAINTENANCE_BYPASS_MAX,
  MAINTENANCE_RETRY_AFTER_MAX,
} from "./maintenance-limits";

/** As stored in the host's meta. */
export type HostMaintenanceMeta = {
  enabled: boolean;
  retry_after?: number;
  bypass_cidrs?: string[];
  body?: string;
};

/** As the API and the editor see it. */
export type HostMaintenanceConfig = {
  enabled: boolean;
  /** Seconds; null sends no Retry-After. */
  retryAfter: number | null;
  bypassCidrs: string[];
  /** Null falls back to the host's 503 error page, then the global one, then a built-in page. */
  body: string | null;
};

function retryAfterOf(value: unknown): number | undefined {
  const seconds = typeof value === "number" ? value : Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(seconds)) {
    return undefined;
  }
  const whole = Math.round(seconds);
  return whole >= 1 ? Math.min(whole, MAINTENANCE_RETRY_AFTER_MAX) : undefined;
}

function bodyOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.slice(0, MAINTENANCE_BODY_MAX);
}

/** Of `{enabled, retryAfter, bypassCidrs, body}` or the stored shape; a bad range is skipped. */
function build(
  value: unknown,
  onBadRange: (range: string) => void,
): HostMaintenanceMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const ranges = raw.bypass_cidrs ?? raw.bypassCidrs;
  const bypass: string[] = [];
  for (const entry of Array.isArray(ranges) ? ranges : []) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const cidr = normalizeCidr(entry);
    if (!cidr) {
      onBadRange(entry.trim());
      continue;
    }
    if (!bypass.includes(cidr)) bypass.push(cidr);
  }
  const meta: HostMaintenanceMeta = { enabled: raw.enabled === true };
  const retryAfter = retryAfterOf(raw.retry_after ?? raw.retryAfter);
  if (retryAfter) meta.retry_after = retryAfter;
  if (bypass.length > 0) meta.bypass_cidrs = bypass.slice(0, MAINTENANCE_BYPASS_MAX);
  const body = bodyOf(raw.body);
  if (body) meta.body = body;
  // Off with nothing to remember is the same as never set.
  return meta.enabled || Object.keys(meta).length > 1 ? meta : undefined;
}

/** A stored blob: anything unreadable is dropped rather than failing the config. */
export function sanitizeHostMaintenance(value: unknown): HostMaintenanceMeta | undefined {
  return build(value, () => {});
}

/** From the editor or the API: a range that is not an address or CIDR is refused, not dropped. */
export function normalizeHostMaintenanceInput(value: unknown): HostMaintenanceMeta | undefined {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const ranges = raw.bypass_cidrs ?? raw.bypassCidrs;
  if (Array.isArray(ranges) && ranges.length > MAINTENANCE_BYPASS_MAX) {
    throw domainError(
      "hostMaintenanceBypassTooMany",
      { max: MAINTENANCE_BYPASS_MAX },
      { status: 400 },
    );
  }
  return build(value, (range) => {
    throw domainError("hostMaintenanceBypassInvalid", { value: range }, { status: 400 });
  });
}

export function hydrateHostMaintenance(
  meta: HostMaintenanceMeta | undefined,
): HostMaintenanceConfig | null {
  if (!meta) return null;
  return {
    enabled: meta.enabled,
    retryAfter: meta.retry_after ?? null,
    bypassCidrs: meta.bypass_cidrs ?? [],
    body: meta.body ?? null,
  };
}

export type MaintenancePage = { body: string; contentType: string };

type ErrorPageLike = { statuses: number[]; body: string; contentType?: string };

/** Caddy-served, so English like the other built-in responses (see `access-lists/rules.ts`). */
export const BUILT_IN_MAINTENANCE_PAGE: MaintenancePage = {
  body:
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Down for maintenance</title>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>' +
    "<h1>Down for maintenance</h1><p>This site is being worked on and will be back shortly.</p>" +
    "</body></html>",
  contentType: "text/html; charset=utf-8",
};

/** The first error page that would have answered a 503, as `errors.routes` picks it. */
function errorPageFor503(rules: readonly ErrorPageLike[] | undefined): MaintenancePage | null {
  const rule = rules?.find((r) => r.statuses.length === 0 || r.statuses.includes(503));
  return rule
    ? { body: rule.body, contentType: rule.contentType || BUILT_IN_MAINTENANCE_PAGE.contentType }
    : null;
}

/**
 * The host's own body, else its 503 error page, else the global one, else the built-in page.
 * Resolved here because a static_response in the main chain never reaches `errors.routes`.
 */
export function resolveMaintenancePage(
  meta: HostMaintenanceMeta,
  hostErrorPages: readonly ErrorPageLike[] | undefined,
  globalErrorPages: readonly ErrorPageLike[] | undefined,
): MaintenancePage {
  if (meta.body) return { body: meta.body, contentType: BUILT_IN_MAINTENANCE_PAGE.contentType };
  return (
    errorPageFor503(hostErrorPages) ??
    errorPageFor503(globalErrorPages) ??
    BUILT_IN_MAINTENANCE_PAGE
  );
}

/**
 * A subroute rather than a bare static_response, so the bypass ranges can let a request carry on
 * down the host's chain. `client_ip` honours the server's trusted proxies.
 */
export function buildMaintenanceHandler(
  meta: HostMaintenanceMeta,
  page: MaintenancePage,
): Record<string, unknown> {
  const headers: Record<string, string[]> = {
    "Content-Type": [escapeHostPlaceholders(page.contentType)],
    // A cached 503 would outlive the maintenance window.
    "Cache-Control": ["no-store"],
  };
  if (meta.retry_after) headers["Retry-After"] = [String(meta.retry_after)];
  const route: Record<string, unknown> = {
    handle: [
      {
        handler: "static_response",
        status_code: 503,
        headers,
        body: escapeHostPlaceholders(page.body),
      },
    ],
  };
  if (meta.bypass_cidrs?.length) {
    route.match = [{ not: [{ client_ip: { ranges: meta.bypass_cidrs } }] }];
  }
  return { handler: "subroute", routes: [route] };
}
