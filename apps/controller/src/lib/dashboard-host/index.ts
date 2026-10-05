/**
 * CPM's own dashboard served through its Caddy: a managed host synthesised on every apply, not a
 * `proxy_hosts` row. It goes ahead of stored hosts so it wins a same-domain tie in the route sort.
 * Safe because the controller's published port 3000 still serves the page that turns it off.
 */

import { Resolver } from "node:dns/promises";
import { config } from "../config";
import {
  PROBE_PARAM,
  PROBE_PATH,
  createProbeNonce,
  probeSignatureMatches,
} from "../reachability/probe";
// Type-only, so it cannot close a runtime cycle with caddy/index.ts.
import type { ProxyHostRow } from "../caddy";

/** How CPM serves its own dashboard. Stored as the `dashboard` settings blob. */
export type DashboardHostSettings = {
  enabled: boolean;
  domain: string;
  /** Forces HTTPS, which also asks Caddy for a certificate - so set from a reachability check. */
  tls: boolean;
  /** Absent on settings saved before the dashboard host had options. */
  options?: DashboardHostOptions;
};

/** A proxy host's options minus upstream, websockets and Host header, which the dashboard needs. */
export type DashboardHostOptions = {
  certificateId: number | null;
  accessListId: number | null;
  hstsSubdomains: boolean;
  skipHttpsHostnameValidation: boolean;
  /** Empty means every agent. */
  agentIds: number[];
  /** Same shape as `proxy_hosts.meta`, so the Caddy builder reads it unchanged. */
  meta: string | null;
};

export const EMPTY_DASHBOARD_HOST_OPTIONS: DashboardHostOptions = {
  certificateId: null,
  accessListId: null,
  hstsSubdomains: false,
  skipHttpsHostnameValidation: false,
  agentIds: [],
  meta: null,
};

/**
 * Negative so it never collides with a `proxy_hosts` serial - which is also why features keyed by
 * host id (mTLS rules, forward-auth grants) are not offered for it.
 */
export const DASHBOARD_HOST_ID = -1;

export const DASHBOARD_HOST_NAME = "CPM Dashboard (managed)";

/** Claiming `localhost` in Caddy would take the port escape hatch from installs with no domain. */
const NOT_A_PUBLIC_NAME = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", ""]);

function domainFromBaseUrl(): string {
  try {
    const hostname = new URL(config.baseUrl).hostname.toLowerCase();
    return NOT_A_PUBLIC_NAME.has(hostname) ? "" : hostname;
  } catch {
    return "";
  }
}

/** DASHBOARD_DOMAIN, else BASE_URL's hostname; empty leaves the feature off. */
export function seedDashboardDomain(): string {
  return config.dashboardDomain ?? domainFromBaseUrl();
}

export function defaultDashboardSettings(): DashboardHostSettings {
  return { enabled: false, domain: seedDashboardDomain(), tls: false };
}

/**
 * Always HTTP at setup: the route does not exist yet and Caddy may not be running, so a probe here
 * would say nothing about DNS. Settings -> Dashboard Host offers the HTTPS check once it is live.
 */
export function activateDashboardHost(domain: string): DashboardHostSettings {
  const name = domain.trim().toLowerCase();
  if (!name) return { enabled: false, domain: "", tls: false };
  return { enabled: true, domain: name, tls: false };
}

/** Null when it serves nothing. Built from a validated hostname, so safe in a Location or fetch. */
export function dashboardHostOrigin(settings: DashboardHostSettings | null): string | null {
  if (!settings?.enabled) return null;
  const domain = settings.domain.trim().toLowerCase();
  if (!isHostname(domain)) return null;
  return `${settings.tls ? "https" : "http"}://${domain}`;
}

/** A `ProxyHostRow`, not a route, so it takes the same TLS/header/error-page path as any host. */
export function buildDashboardHostRow(
  settings: DashboardHostSettings | null,
  upstream: string | null,
): ProxyHostRow | null {
  if (!settings?.enabled) return null;

  const domain = settings.domain.trim().toLowerCase();
  if (!domain) return null;

  // Claiming the domain with no upstream would only answer proxy errors.
  if (!upstream) return null;

  const options = settings.options ?? EMPTY_DASHBOARD_HOST_OPTIONS;

  return {
    id: DASHBOARD_HOST_ID,
    name: DASHBOARD_HOST_NAME,
    domains: JSON.stringify([domain]),
    // http:// because Caddy reaches the controller on their shared network.
    upstreams: JSON.stringify([`http://${upstream}`]),
    certificateId: options.certificateId,
    accessListId: options.accessListId,
    sslForced: settings.tls ? 1 : 0,
    // HSTS without HTTPS pins browsers to a scheme this host does not serve.
    hstsEnabled: settings.tls ? 1 : 0,
    hstsSubdomains: settings.tls && options.hstsSubdomains ? 1 : 0,
    // The dashboard streams: agent status and the log views are server-sent events.
    allowWebsocket: 1,
    // The controller builds absolute URLs from the request host, and better-auth checks it.
    preserveHostHeader: 1,
    skipHttpsHostnameValidation: options.skipHttpsHostnameValidation ? 1 : 0,
    meta: options.meta,
    enabled: 1,
  };
}

/**
 * Rejects anything that could smuggle a scheme, credentials, port, path or query into a URL.
 * A bare IPv4 literal passes on purpose.
 */
export function isHostname(value: string): boolean {
  const name = value.trim();
  if (name.length === 0 || name.length > 253) return false;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i.test(name);
}

/** `ok` is what the TLS toggle is set from. */
export type DashboardDnsCheck = {
  ok: boolean;
  resolved: string[];
  reason: "reached" | "otherServer" | "unreachable" | "unresolved" | "noDomain";
};

/** Bounded so a slow resolver or an unreachable domain cannot hold a form submission open. */
const CHECK_TIMEOUT_MS = 5_000;

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    return await work(controller.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveAddresses(name: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: CHECK_TIMEOUT_MS, tries: 1 });
  const [v4, v6] = await Promise.all([
    resolver.resolve4(name).catch(() => [] as string[]),
    resolver.resolve6(name).catch(() => [] as string[]),
  ]);
  return [...v4, ...v6];
}

/**
 * True only for a correctly signed nonce: another server can return 200 or echo it, not sign it.
 * A host already on HTTPS must be probed over HTTPS - it redirects plain requests away.
 */
async function probeSelf(domain: string, scheme: "http" | "https" = "http"): Promise<boolean> {
  // The CodeQL URL-injection gate. Private and loopback addresses are deliberately allowed: LAN
  // and NAT-hairpin installs probe their own domain there.
  if (!isHostname(domain)) return false;

  const nonce = createProbeNonce();
  const url = `${scheme}://${domain}${PROBE_PATH}?${PROBE_PARAM}=${encodeURIComponent(nonce)}`;

  const answered = await withTimeout(async (signal) => {
    // Following a redirect could hand the nonce to a third party.
    const response = await fetch(url, { signal, redirect: "manual", cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as { probe?: unknown };
    return typeof body.probe === "string" ? body.probe : null;
  });

  return answered !== null && probeSignatureMatches(nonce, answered);
}

/**
 * Never throws: the caller renders a warning. DNS is resolved only to tell "no record" from
 * "resolves but does not arrive here".
 */
export async function checkDashboardDns(
  domain: string,
  // Test seam; real callers pass nothing.
  deps: {
    resolveAddresses?: (name: string) => Promise<string[]>;
    probe?: (name: string) => Promise<boolean>;
  } = {},
): Promise<DashboardDnsCheck> {
  const name = domain.trim().toLowerCase();
  if (!name) return { ok: false, resolved: [], reason: "noDomain" };

  const [resolved, reachedSelf] = await Promise.all([
    withTimeout(async () =>
      deps.resolveAddresses ? await deps.resolveAddresses(name) : await resolveAddresses(name),
    ),
    (deps.probe ?? probeSelf)(name),
  ]);

  const addresses = resolved ?? [];
  if (reachedSelf) return { ok: true, resolved: addresses, reason: "reached" };
  if (addresses.length === 0) return { ok: false, resolved: [], reason: "unresolved" };

  // A wrong server and a closed port look alike to the probe, so both report otherServer.
  return { ok: false, resolved: addresses, reason: "otherServer" };
}

/** Only decides whether to redirect a browser there; a false is not a diagnosis. */
export async function dashboardHostAnswers(
  settings: DashboardHostSettings | null,
): Promise<boolean> {
  if (!settings?.enabled) return false;
  const domain = settings.domain.trim().toLowerCase();
  if (!isHostname(domain)) return false;
  return await probeSelf(domain, settings.tls ? "https" : "http");
}
