import db, { nowIso, toIso } from "../db";
import { applyCaddyConfig } from "../caddy";
import { validateCaddyfileSnippet } from "../caddy/caddyfile";
import {
  type HostWriteOptions,
  auditedRevision,
  runHostWrite,
  setHostAgentsSteps,
  updateOperation,
} from "../host-history/record";
import { pruneHostRevisions } from "../host-history/retention";
import { hostAuditChanges } from "../host-review/audit";
import { accessLists, proxyHosts } from "../db/schema";
import { and, asc, desc, eq, count, inArray, like, or, sql } from "drizzle-orm";
import { parseHostUuid } from "../hosts/ref";
import {
  type GeoBlockSettings,
  type WafSettings,
  getDnsProviderSettings,
  getHostDefaults,
  getTailscaleSettings,
  getWafSettings,
} from "../settings";
import { applyProxyHostDefaults } from "../proxy-hosts/host-defaults";
import { normalizeProxyHostDomains } from "../proxy-hosts/domains";
import { isPlainObject, stripCaddyPlaceholders } from "../caddy/utils";
import { assertNoNewAdminDialTargets, mayReachInstance } from "./admin-dial-targets";
import {
  CORAZA_MAX_BODY_LIMIT,
  CORAZA_MIN_BODY_LIMIT,
  customDirectivesError,
  seclangErrorDetails,
  isValidBodyLimit,
  normalizeWafPluginIds,
  normalizeWafPresetIds,
  wafDirectiveSource,
} from "../waf/caddy";
import { type NodeNameField, nodeNameProblem, normalizeNodeName } from "../caddy/tailscale";
import { domainError } from "../errors/domain-error";
import { SettingsValidationError, validateHostGeoBlock } from "../settings/validation";
import { assertCertificateServable } from "../certificates/placement";
import { seclangErrors } from "../waf/seclang";
import { type WafDryRunTarget, assertWafLoads, wafCandidatesForHost } from "../waf/dry-run";
import { agentIdsForHost } from "./host-agents";
import { assertWafPresetIdsExist } from "./waf-presets";
import { assertCrsPluginIdsExist } from "./crs-plugins";
import { normalizeHostDescription } from "../proxy-hosts/description";
import { collectTags, hasTagClause, normalizeHostTags, parseStoredTags } from "../proxy-hosts/tags";
import {
  type HostCacheConfig,
  type HostCacheMeta,
  hydrateHostCache,
  sanitizeHostCache,
} from "../proxy-hosts/cache";
import { type HostCompressionMode, sanitizeHostCompression } from "../proxy-hosts/compression";
import {
  type HostMaintenanceConfig,
  type HostMaintenanceMeta,
  hydrateHostMaintenance,
  normalizeHostMaintenanceInput,
  sanitizeHostMaintenance,
} from "../proxy-hosts/maintenance";
import { isCaddyDuration } from "../caddy/duration";
import {
  type HostUpstreamTimeoutsConfig,
  type HostUpstreamTimeoutsMeta,
  hydrateHostUpstreamTimeouts,
  normalizeHostUpstreamTimeoutsInput,
  sanitizeHostUpstreamTimeouts,
} from "../proxy-hosts/upstream-timeouts";
import { hasDnsChallengeFor } from "../dns/challenge-delegation";
import {
  type HostRateLimitConfig,
  type HostRateLimitMeta,
  hydrateHostRateLimit,
  normalizeHostRateLimitInput,
  sanitizeHostRateLimit,
} from "../proxy-hosts/rate-limit";
import {
  type HostAnubisConfig,
  type HostAnubisMeta,
  hydrateHostAnubis,
  normalizeHostAnubisInput,
  sanitizeHostAnubis,
} from "../proxy-hosts/anubis";
import {
  type HostCrowdSecMeta,
  hostCrowdSecEnabled,
  sanitizeHostCrowdSec,
  storedHostCrowdSec,
} from "../caddy/crowdsec";

/** A wildcard needs DNS-01: without a DNS provider, auto-managed TLS silently gets no cert. */
export async function assertWildcardIssuable(domains: string[], certificateId: number | null) {
  // An explicitly assigned certificate (imported, or managed with its own provider) is the
  // admin's responsibility - only guard the auto-managed path.
  if (certificateId != null) {
    return;
  }
  const wildcardDomains = domains.filter((domain) => domain.startsWith("*."));
  if (wildcardDomains.length === 0) {
    return;
  }
  const dnsSettings = await getDnsProviderSettings();
  // A delegation naming a provider covers its names even with no default.
  const uncovered = wildcardDomains.find((domain) => !hasDnsChallengeFor(domain, dnsSettings));
  if (uncovered) {
    throw domainError("wildcardDomainNeedsDnsProvider", { domain: uncovered }, { status: 400 });
  }
}

// Only the scheme is checked here: proxying to internal services is the point. Targets that reach
// the Caddy admin API are refused to non-admins separately, in assertDialTargetsAllowed.
function validateUpstreamProtocol(upstream: string): void {
  const trimmed = upstream.trim();
  if (!trimmed) return;
  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== "http" && scheme !== "https") {
      throw domainError("upstreamProtocolInvalid", { scheme }, { status: 400 });
    }
  }
}

const DEFAULT_AUTHENTIK_HEADERS = [
  "X-Authentik-Username",
  "X-Authentik-Groups",
  "X-Authentik-Entitlements",
  "X-Authentik-Email",
  "X-Authentik-Name",
  "X-Authentik-Uid",
  "X-Authentik-Jwt",
  "X-Authentik-Meta-Jwks",
  "X-Authentik-Meta-Outpost",
  "X-Authentik-Meta-Provider",
  "X-Authentik-Meta-App",
  "X-Authentik-Meta-Version",
];

const DEFAULT_AUTHENTIK_TRUSTED_PROXIES = ["private_ranges"];
const VALID_UPSTREAM_DNS_FAMILIES: UpstreamDnsAddressFamily[] = ["ipv6", "ipv4", "both"];

export type GeoBlockMode = "merge" | "override";

export type WafMode = "merge" | "override";

export type RedirectRule = {
  from: string; // path pattern e.g. "/.well-known/carddav"
  to: string; // destination e.g. "/remote.php/dav/"
  status: 301 | 302 | 307 | 308;
  /** Append the request's path and query to `to`: all of it, or what follows `from`'s prefix. */
  preservePath?: RedirectPathMode;
};

export const REDIRECT_PATH_MODES = ["full", "suffix"] as const;
export type RedirectPathMode = (typeof REDIRECT_PATH_MODES)[number];

export type RewriteConfig = {
  path_prefix: string; // e.g. "/recipes"
};

export type LocationRule = {
  path: string; // Caddy path pattern, e.g. "/ws/*", "/api/*"
  upstreams: string[]; // e.g. ["backend:8080", "backend2:8080"]
  loadBalancer: LoadBalancerConfig | null; // optional per-rule load balancing / health checks
  /** Absent: the host's access list applies. null: none. A number: that list instead. */
  accessListId?: number | null;
};

export type LocationRuleInput = {
  path: string;
  upstreams: string[];
  loadBalancer?: LoadBalancerInput | null;
  accessListId?: number | null;
};

// Stored (meta JSON) shape of a location rule. The load balancer uses the same snake_case meta
// shape as the host-level one.
export type LocationRuleMeta = {
  path: string;
  upstreams: string[];
  load_balancer?: LoadBalancerMeta;
  /** No FK behind it: a list named here cannot be deleted (see access-lists.ts). */
  access_list_id?: number | null;
};

export const PATH_BLOCK_STATUS_CODES = [400, 401, 403, 404, 410, 418, 451, 500, 502, 503] as const;
export type PathBlockStatusCode = (typeof PATH_BLOCK_STATUS_CODES)[number];

export type PathBlockRule = {
  path: string; // Caddy path pattern, e.g. "/dns-query"
  status: PathBlockStatusCode; // status code to return, e.g. 403
  body?: string; // optional response body, e.g. "Forbidden"
};

export type PathRewriteRule = {
  from: string; // path pattern, e.g. "/secretpath"
  to: string; // internal target URI, e.g. "/dns-query"
};

// Suggested status codes for the error-page UI. The sanitizer accepts any 4xx/5xx code; this
// list only drives the picker.
export const ERROR_PAGE_STATUS_CODES = [400, 401, 403, 404, 408, 429, 500, 502, 503, 504] as const;

export type ErrorPageRule = {
  statuses: number[]; // error codes this rule handles, e.g. [502, 503, 504]; empty = all errors
  body: string; // response body (HTML/text); the original status code is preserved
  contentType?: string; // optional Content-Type, defaults to "text/html; charset=utf-8"
};

export type PathAllowRule = {
  path: string; // Caddy path pattern, e.g. "/secret"; a match skips every block
};

export type WafHostConfig = {
  enabled?: boolean;
  mode?: "Off" | "On" | "DetectionOnly";
  load_owasp_crs?: boolean;
  custom_directives?: string;
  excluded_rule_ids?: number[];
  preset_ids?: number[];
  plugin_ids?: number[];
  waf_mode?: WafMode;
  // Request body limits in bytes; unset inherits the global WAF setting.
  // Coraza rejects anything above 1 GiB at config-load time.
  request_body_limit?: number;
  request_body_in_memory_limit?: number;
  request_body_limit_action?: "Reject" | "ProcessPartial";
};

export type LoadBalancingPolicy =
  | "random"
  | "random_choose"
  | "round_robin"
  | "weighted_round_robin"
  | "least_conn"
  | "ip_hash"
  | "client_ip_hash"
  | "first"
  | "header"
  | "cookie"
  | "uri_hash"
  | "query";

export type LoadBalancerActiveHealthCheck = {
  enabled: boolean;
  uri: string | null;
  port: number | null;
  interval: string | null;
  timeout: string | null;
  /** Expected response status. Caddy calls this `expect_status`; `status` here predates the rest. */
  status: number | null;
  /** Regexp the response body must match. Caddy's `expect_body`. */
  body: string | null;
  /** Consecutive passes before an upstream is considered healthy again. */
  passes: number | null;
  /** Consecutive failures before an upstream is taken out. */
  fails: number | null;
  /** HTTP method for the probe. GET when unset. */
  method: string | null;
  /** Body to send *with* the probe, as opposed to `body`, which matches the response. */
  requestBody: string | null;
  followRedirects: boolean;
  /** Extra probe headers, one value each - enough for a token or a routing hint. */
  headers: Record<string, string> | null;
};

export type LoadBalancerPassiveHealthCheck = {
  enabled: boolean;
  failDuration: string | null;
  maxFails: number | null;
  unhealthyStatus: number[] | null;
  unhealthyLatency: string | null;
  /** Concurrent requests to one upstream before it counts as unhealthy. */
  unhealthyRequestCount: number | null;
};

export type LoadBalancerConfig = {
  enabled: boolean;
  policy: LoadBalancingPolicy;
  policyHeaderField: string | null;
  policyCookieName: string | null;
  policyCookieSecret: string | null;
  /** Query parameter to hash on, for the `query` policy. */
  policyQueryKey: string | null;
  /** How many upstreams `random_choose` picks between. */
  policyChoose: number | null;
  /**
   * Weights for `weighted_round_robin`, positional against the flat `upstreams` list, as Caddy
   * wants. A list out of step with the upstreams is dropped, not padded: reweighting is worse.
   */
  policyWeights: number[] | null;
  tryDuration: string | null;
  tryInterval: string | null;
  retries: number | null;
  activeHealthCheck: LoadBalancerActiveHealthCheck | null;
  passiveHealthCheck: LoadBalancerPassiveHealthCheck | null;
};

export type LoadBalancerInput = {
  enabled?: boolean;
  policy?: LoadBalancingPolicy;
  policyHeaderField?: string | null;
  policyCookieName?: string | null;
  policyCookieSecret?: string | null;
  policyQueryKey?: string | null;
  policyChoose?: number | null;
  policyWeights?: number[] | null;
  tryDuration?: string | null;
  tryInterval?: string | null;
  retries?: number | null;
  activeHealthCheck?: {
    enabled?: boolean;
    uri?: string | null;
    port?: number | null;
    interval?: string | null;
    timeout?: string | null;
    status?: number | null;
    body?: string | null;
    passes?: number | null;
    fails?: number | null;
    method?: string | null;
    requestBody?: string | null;
    followRedirects?: boolean;
    headers?: Record<string, string> | null;
  } | null;
  passiveHealthCheck?: {
    enabled?: boolean;
    failDuration?: string | null;
    maxFails?: number | null;
    unhealthyStatus?: number[] | null;
    unhealthyLatency?: string | null;
    unhealthyRequestCount?: number | null;
  } | null;
};

type LoadBalancerActiveHealthCheckMeta = {
  enabled?: boolean;
  uri?: string;
  port?: number;
  interval?: string;
  timeout?: string;
  status?: number;
  body?: string;
  passes?: number;
  fails?: number;
  method?: string;
  request_body?: string;
  follow_redirects?: boolean;
  headers?: Record<string, string>;
};

type LoadBalancerPassiveHealthCheckMeta = {
  enabled?: boolean;
  fail_duration?: string;
  max_fails?: number;
  unhealthy_status?: number[];
  unhealthy_latency?: string;
  unhealthy_request_count?: number;
};

type LoadBalancerMeta = {
  enabled?: boolean;
  policy?: string;
  policy_header_field?: string;
  policy_cookie_name?: string;
  policy_cookie_secret?: string;
  policy_query_key?: string;
  policy_choose?: number;
  policy_weights?: number[];
  try_duration?: string;
  try_interval?: string;
  retries?: number;
  active_health_check?: LoadBalancerActiveHealthCheckMeta;
  passive_health_check?: LoadBalancerPassiveHealthCheckMeta;
};

export type DnsResolverConfig = {
  enabled: boolean;
  resolvers: string[];
  fallbacks: string[] | null;
  timeout: string | null;
};

export type DnsResolverInput = {
  enabled?: boolean;
  resolvers?: string[];
  fallbacks?: string[] | null;
  timeout?: string | null;
};

type DnsResolverMeta = {
  enabled?: boolean;
  resolvers?: string[];
  fallbacks?: string[];
  timeout?: string;
};

export type UpstreamDnsAddressFamily = "ipv6" | "ipv4" | "both";

export type UpstreamDnsResolutionConfig = {
  enabled: boolean | null;
  family: UpstreamDnsAddressFamily | null;
};

export type UpstreamDnsResolutionInput = {
  enabled?: boolean | null;
  family?: UpstreamDnsAddressFamily | null;
};

type UpstreamDnsResolutionMeta = {
  enabled?: boolean;
  family?: UpstreamDnsAddressFamily;
};

export type ProxyHostAuthentikConfig = {
  enabled: boolean;
  outpostDomain: string | null;
  outpostUpstream: string | null;
  authEndpoint: string | null;
  copyHeaders: string[];
  trustedProxies: string[];
  setOutpostHostHeader: boolean;
  protectedPaths: string[] | null;
  excludedPaths: string[] | null;
};

export type ProxyHostAuthentikInput = {
  enabled?: boolean;
  outpostDomain?: string | null;
  outpostUpstream?: string | null;
  authEndpoint?: string | null;
  copyHeaders?: string[] | null;
  trustedProxies?: string[] | null;
  setOutpostHostHeader?: boolean | null;
  protectedPaths?: string[] | null;
  excludedPaths?: string[] | null;
};

type ProxyHostAuthentikMeta = {
  enabled?: boolean;
  outpost_domain?: string;
  outpost_upstream?: string;
  auth_endpoint?: string;
  copy_headers?: string[];
  trusted_proxies?: string[];
  set_outpost_host_header?: boolean;
  protected_paths?: string[];
  excluded_paths?: string[];
};

export type MtlsConfig = {
  enabled: boolean;
  /** Trust specific issued client certificates (derives CAs automatically) */
  trusted_client_cert_ids?: number[];
  /** Trust all certificates belonging to these roles */
  trusted_role_ids?: number[];
  protected_paths?: string[] | null;
  excluded_paths?: string[] | null;
  /** @deprecated Old model: trust entire CAs. Kept for backward compat migration. */
  ca_certificate_ids?: number[];
};

/** Merge mode inherits an unset CRS flag, known here only when the global settings are. */
function hostCrsLoaded(waf: WafHostConfig, globalWaf: WafSettings | null): boolean | undefined {
  if (waf.waf_mode === "override") return Boolean(waf.load_owasp_crs);
  return waf.load_owasp_crs ?? globalWaf?.load_owasp_crs;
}

/**
 * Coraza builds its WAF while Caddy loads the config, so one bad body limit rejects the whole
 * document and stalls every host - fail the write with a clear message instead. Directives are
 * judged against `previous`: a stored line a later release started dropping must not block the
 * enable toggle or a PATCH of other fields.
 */
function validateWafMeta(
  waf: WafHostConfig,
  previous: WafHostConfig | undefined,
  globalWaf: WafSettings | null,
): WafHostConfig {
  // Codes rather than sentences: the host form reaches these too, while `/api/v1` keeps its 400.
  // Bounds go as strings, or the catalog would format 1073741824 with separators.
  const bounds = { min: String(CORAZA_MIN_BODY_LIMIT), max: String(CORAZA_MAX_BODY_LIMIT) };
  const outOfRange = {
    request_body_limit: "hostWafRequestBodyLimitOutOfRange",
    request_body_in_memory_limit: "hostWafInMemoryBodyLimitOutOfRange",
  } as const;
  for (const key of ["request_body_limit", "request_body_in_memory_limit"] as const) {
    const value = waf[key];
    if (value === undefined || value === null) continue;
    if (!isValidBodyLimit(value)) throw domainError(outOfRange[key], bounds, { status: 400 });
  }
  const action = waf.request_body_limit_action;
  if (action !== undefined && action !== "Reject" && action !== "ProcessPartial") {
    throw domainError("hostWafBodyLimitActionInvalid", {}, { status: 400 });
  }
  if (
    typeof waf.request_body_limit === "number" &&
    typeof waf.request_body_in_memory_limit === "number" &&
    waf.request_body_in_memory_limit > waf.request_body_limit
  ) {
    throw domainError("hostWafInMemoryBodyLimitExceedsLimit", {}, { status: 400 });
  }
  if (waf.preset_ids !== undefined) {
    // undefined rather than [] so an emptied selection leaves the stored JSON as it was before presets.
    const presetIds = normalizeWafPresetIds(waf.preset_ids);
    waf = { ...waf, preset_ids: presetIds.length > 0 ? presetIds : undefined };
  }
  if (waf.plugin_ids !== undefined) {
    const pluginIds = normalizeWafPluginIds(waf.plugin_ids);
    waf = { ...waf, plugin_ids: pluginIds.length > 0 ? pluginIds : undefined };
  }
  // Only lines the allowlist is about to discard are echoed, and a discarded line that says nothing
  // is what makes a WAF rule look like it does nothing. A merge-mode host follows the global lines.
  const strictDirectives = globalWaf?.strict_directives === true;
  const directiveError = customDirectivesError(
    waf.custom_directives,
    {
      crsLoaded: hostCrsLoaded(waf, globalWaf),
      precedingDirectives: wafDirectiveSource(globalWaf, waf, "").globalDirectives,
      strictDirectives,
    },
    previous && {
      directives: previous.custom_directives,
      options: {
        crsLoaded: hostCrsLoaded(previous, globalWaf),
        precedingDirectives: wafDirectiveSource(globalWaf, previous, "").globalDirectives,
        strictDirectives,
      },
    },
    "host",
  );
  if (directiveError) throw directiveError;
  const lintErrors = seclangErrors(waf.custom_directives ?? "", {
    crsLoaded: waf.load_owasp_crs === true,
  });
  if (lintErrors.length > 0) {
    throw domainError(
      "wafDirectivesInvalid",
      { count: lintErrors.length, details: seclangErrorDetails(lintErrors) },
      { status: 400 },
    );
  }
  return waf;
}

function sanitizeMtlsMeta(meta: MtlsConfig | undefined): MtlsConfig | undefined {
  if (!meta?.enabled) {
    return undefined;
  }

  const normalized: MtlsConfig = { enabled: true };

  if (Array.isArray(meta.trusted_client_cert_ids)) {
    const certIds = meta.trusted_client_cert_ids.filter(
      (id): id is number => Number.isFinite(id) && id > 0,
    );
    if (certIds.length > 0) {
      normalized.trusted_client_cert_ids = certIds;
    }
  }

  if (Array.isArray(meta.trusted_role_ids)) {
    const roleIds = meta.trusted_role_ids.filter(
      (id): id is number => Number.isFinite(id) && id > 0,
    );
    if (roleIds.length > 0) {
      normalized.trusted_role_ids = roleIds;
    }
  }

  if (Array.isArray(meta.protected_paths)) {
    const paths = meta.protected_paths
      .map((path) => stripCaddyPlaceholders(path?.trim() ?? ""))
      .filter((path): path is string => Boolean(path));
    if (paths.length > 0) {
      normalized.protected_paths = paths;
    }
  }

  if (Array.isArray(meta.excluded_paths)) {
    const paths = meta.excluded_paths
      .map((path) => stripCaddyPlaceholders(path?.trim() ?? ""))
      .filter((path): path is string => Boolean(path));
    if (paths.length > 0) {
      normalized.excluded_paths = paths;
    }
  }

  if (Array.isArray(meta.ca_certificate_ids)) {
    const caIds = meta.ca_certificate_ids.filter(
      (id): id is number => Number.isFinite(id) && id > 0,
    );
    if (caIds.length > 0) {
      normalized.ca_certificate_ids = caIds;
    }
  }

  // No trust material would fail open, since no client_authentication block is emitted. A role
  // emptied later by revocation still passes here, so config generation also fails closed.
  if (
    !normalized.trusted_client_cert_ids &&
    !normalized.trusted_role_ids &&
    !normalized.ca_certificate_ids
  ) {
    throw domainError("mtlsNoTrustMaterial", {}, { status: 400 });
  }

  return normalized;
}

// ─── Tailscale ───────────────────────────────────────────────────────────────

/**
 * `serve` puts the routes on a `tailscale/<node>` listener, `auth` gates them on tailnet identity,
 * `upstreamNode` dials upstreams through a node. `auth` implies `serve`: with no tsnet listener the
 * authenticator falls back to a tailscaled socket this image lacks, so every request would fail.
 */
export type TailscaleHostConfig = {
  serve: boolean;
  /** Tailnet machine name. Empty means the node named in Settings → Network → Tailscale. */
  node: string;
  /** Keep the host off the public :80/:443 listener, so it exists only on the tailnet. */
  tailnetOnly: boolean;
  auth: boolean;
  /** Paths the identity gate covers. Null gates the whole host. */
  protected_paths: string[] | null;
  /** Paths that bypass the gate. Ignored when protected_paths is set. */
  excluded_paths: string[] | null;
  /** Pass the caller's identity upstream as X-Tailscale-* request headers. */
  forwardIdentity: boolean;
  /** Node to dial upstreams through. Null leaves upstreams on the container's own network. */
  upstreamNode: string | null;
};

export type TailscaleHostInput = {
  serve?: boolean;
  node?: string | null;
  tailnetOnly?: boolean;
  auth?: boolean;
  protected_paths?: string[] | null;
  excluded_paths?: string[] | null;
  forwardIdentity?: boolean;
  upstreamNode?: string | null;
};

type TailscaleMeta = {
  serve?: boolean;
  node?: string;
  tailnet_only?: boolean;
  auth?: boolean;
  protected_paths?: string[];
  excluded_paths?: string[];
  forward_identity?: boolean;
  upstream_node?: string;
};

function assertNodeName(name: string, field: NodeNameField): void {
  // A 400 with the same English for `/api/v1`, and a code the proxy host actions can translate.
  const problem = nodeNameProblem(name, field);
  if (problem) throw problem;
}

/** Path patterns reach a Caddy matcher verbatim, so they are stripped like every other path list. */
function sanitizeTailscalePaths(paths: string[]): string[] {
  return paths
    .map((path) => stripCaddyPlaceholders(path?.trim() ?? ""))
    .filter((path): path is string => Boolean(path));
}

/**
 * Merges over what is stored, like the other normalizers: a form sending only the fields it renders
 * must not clear the rest. Everything depending on `serve` is dropped when it is off.
 */
function normalizeTailscaleInput(
  input: TailscaleHostInput | null | undefined,
  existing: TailscaleMeta | undefined,
): TailscaleMeta | undefined {
  if (input === null) return undefined;
  if (input === undefined) return existing;

  const serve = input.serve ?? existing?.serve ?? false;

  const node = input.node !== undefined ? normalizeNodeName(input.node) : (existing?.node ?? "");
  if (node) assertNodeName(node, "node");

  const upstreamNode =
    input.upstreamNode !== undefined
      ? normalizeNodeName(input.upstreamNode)
      : (existing?.upstream_node ?? "");
  if (upstreamNode) assertNodeName(upstreamNode, "upstreamNode");

  const next: TailscaleMeta = {};
  if (serve) {
    next.serve = true;
    if (node) next.node = node;
    // Tailnet-only is the default a new host gets: someone turning this on is asking for a private
    // service, and the surprising direction to guess wrong in is "also published to the internet".
    if (input.tailnetOnly ?? existing?.tailnet_only ?? true) next.tailnet_only = true;

    if (input.auth ?? existing?.auth ?? false) {
      next.auth = true;
      const protectedPaths = sanitizeTailscalePaths(
        input.protected_paths !== undefined
          ? (input.protected_paths ?? [])
          : (existing?.protected_paths ?? []),
      );
      const excludedPaths = sanitizeTailscalePaths(
        input.excluded_paths !== undefined
          ? (input.excluded_paths ?? [])
          : (existing?.excluded_paths ?? []),
      );
      if (protectedPaths.length > 0) next.protected_paths = protectedPaths;
      if (excludedPaths.length > 0) next.excluded_paths = excludedPaths;
      if (input.forwardIdentity ?? existing?.forward_identity ?? false) {
        next.forward_identity = true;
      }
    }
  }
  if (upstreamNode) next.upstream_node = upstreamNode;

  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Re-normalizes a stored blob so a hand-edited row cannot put a node name into a listener address.
 * Must not throw - a failed read takes the whole page down - so a bad block is dropped instead.
 */
function sanitizeTailscaleMeta(meta: TailscaleMeta | undefined): TailscaleMeta | undefined {
  if (!meta) return undefined;
  try {
    return normalizeTailscaleInput(
      {
        serve: meta.serve,
        node: meta.node ?? "",
        // Boolean, not the raw field: undefined would re-apply the new-host tailnet-only default
        // and pull a host published in both places off the public listener.
        tailnetOnly: Boolean(meta.tailnet_only),
        auth: meta.auth,
        protected_paths: meta.protected_paths ?? null,
        excluded_paths: meta.excluded_paths ?? null,
        forwardIdentity: meta.forward_identity,
        upstreamNode: meta.upstream_node ?? "",
      },
      undefined,
    );
  } catch (error) {
    console.warn("Dropping invalid Tailscale host config", error);
    return undefined;
  }
}

/**
 * A node that cannot register never comes up, and Caddy refuses a config it cannot start - failing
 * the apply for every host on every agent. Reads the serialized meta to see the merged result; a
 * stored Caddy placeholder counts as a key, since only the Caddy container can resolve it.
 */
export async function assertTailscaleServable(meta: string | null): Promise<void> {
  if (!meta) return;
  let parsed: ProxyHostMeta;
  try {
    parsed = JSON.parse(meta) as ProxyHostMeta;
  } catch {
    return;
  }
  const tailscale = parsed.tailscale;
  if (!tailscale?.serve && !tailscale?.upstream_node) return;

  const settings = await getTailscaleSettings();
  if (settings?.authKey.trim()) return;

  throw domainError("tailscaleAuthKeyMissingForHost", {}, { status: 400 });
}

function hydrateTailscale(meta: TailscaleMeta | undefined): TailscaleHostConfig | null {
  if (!meta) return null;
  return {
    serve: Boolean(meta.serve),
    node: meta.node ?? "",
    tailnetOnly: Boolean(meta.tailnet_only),
    auth: Boolean(meta.auth),
    protected_paths: meta.protected_paths?.length ? meta.protected_paths : null,
    excluded_paths: meta.excluded_paths?.length ? meta.excluded_paths : null,
    forwardIdentity: Boolean(meta.forward_identity),
    upstreamNode: meta.upstream_node || null,
  };
}

function dehydrateTailscale(config: TailscaleHostConfig | null): TailscaleMeta | undefined {
  if (!config) return undefined;
  return normalizeTailscaleInput(
    {
      serve: config.serve,
      node: config.node,
      tailnetOnly: config.tailnetOnly,
      auth: config.auth,
      protected_paths: config.protected_paths,
      excluded_paths: config.excluded_paths,
      forwardIdentity: config.forwardIdentity,
      upstreamNode: config.upstreamNode,
    },
    undefined,
  );
}

function hydrateForwardAuth(meta: ForwardAuthMeta | undefined): ProxyHostForwardAuthConfig | null {
  if (!meta) return null;

  const provider: ForwardAuthProvider = meta.provider ?? "authelia";
  const copyHeaders =
    meta.copy_headers && meta.copy_headers.length > 0
      ? meta.copy_headers
      : provider === "authelia"
        ? [...DEFAULT_AUTHELIA_FORWARD_AUTH_HEADERS]
        : [];

  return {
    enabled: Boolean(meta.enabled),
    provider,
    authUpstream: normalizeMetaValue(meta.auth_upstream ?? null),
    authEndpoint:
      normalizeMetaValue(meta.auth_endpoint ?? null) ??
      (provider === "authelia" ? DEFAULT_AUTHELIA_FORWARD_AUTH_ENDPOINT : null),
    copyHeaders,
    trustedProxies:
      meta.trusted_proxies && meta.trusted_proxies.length > 0
        ? meta.trusted_proxies
        : [...DEFAULT_AUTHENTIK_TRUSTED_PROXIES],
    apiSplit: Boolean(meta.api_split),
    apiBypassHeaders: meta.api_bypass_headers ?? [],
    protectedPaths: meta.protected_paths?.length ? meta.protected_paths : null,
    excludedPaths: meta.excluded_paths?.length ? meta.excluded_paths : null,
  };
}

function dehydrateForwardAuth(
  config: ProxyHostForwardAuthConfig | null,
): ForwardAuthMeta | undefined {
  if (!config) return undefined;
  const meta: ForwardAuthMeta = { enabled: config.enabled, provider: config.provider };
  if (config.authUpstream) meta.auth_upstream = config.authUpstream;
  if (config.authEndpoint) meta.auth_endpoint = config.authEndpoint;
  if (config.copyHeaders.length > 0) meta.copy_headers = [...config.copyHeaders];
  if (config.trustedProxies.length > 0) meta.trusted_proxies = [...config.trustedProxies];
  if (config.apiSplit) meta.api_split = true;
  if (config.apiBypassHeaders.length > 0) meta.api_bypass_headers = [...config.apiBypassHeaders];
  if (config.protectedPaths?.length) meta.protected_paths = [...config.protectedPaths];
  if (config.excludedPaths?.length) meta.excluded_paths = [...config.excludedPaths];
  return meta;
}

export type CpmForwardAuthConfig = {
  enabled: boolean;
  protected_paths: string[] | null;
  excluded_paths: string[] | null;
  /** Whether the portal asks for the sign-in CAPTCHA, when one is configured. */
  require_captcha: boolean;
};

export type CpmForwardAuthInput = {
  enabled?: boolean;
  protected_paths?: string[] | null;
  excluded_paths?: string[] | null;
  require_captcha?: boolean;
};

type CpmForwardAuthMeta = {
  enabled?: boolean;
  protected_paths?: string[];
  excluded_paths?: string[];
  /** Stored only as false: every host that predates the CAPTCHA gets it. */
  require_captcha?: boolean;
};

/** Presets for an auth server this app does not run. "custom" asks for every field by hand. */
export const FORWARD_AUTH_PROVIDERS = ["authelia", "custom"] as const;
export type ForwardAuthProvider = (typeof FORWARD_AUTH_PROVIDERS)[number];

/** What the Authelia preset fills in, so only the server URL has to be typed. */
export const DEFAULT_AUTHELIA_FORWARD_AUTH_ENDPOINT = "/api/authz/forward-auth";
export const DEFAULT_AUTHELIA_FORWARD_AUTH_HEADERS = [
  "Remote-User",
  "Remote-Groups",
  "Remote-Email",
  "Remote-Name",
  "Remote-IP",
];

/**
 * An RFC 7230 header name. A copy or bypass header name reaches a Caddy placeholder and a matcher
 * key, so free-form text is refused rather than escaped.
 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export type ProxyHostForwardAuthConfig = {
  enabled: boolean;
  provider: ForwardAuthProvider;
  /** Base URL of the auth server, e.g. http://authelia:9091 */
  authUpstream: string | null;
  /** URI the auth subrequest is rewritten to. May carry a query string. */
  authEndpoint: string | null;
  /** Headers taken from the auth server's 2xx answer and set on the upstream request. */
  copyHeaders: string[];
  trustedProxies: string[];
  /** Answer non-browsers (WebSockets, API clients) with 401, not a redirect to the login page. */
  apiSplit: boolean;
  /**
   * A request carrying any of these headers skips forward auth entirely and reaches the upstream,
   * which is expected to check the credential itself - Moonraker's X-Api-Key, say.
   */
  apiBypassHeaders: string[];
  protectedPaths: string[] | null;
  excludedPaths: string[] | null;
};

export type ProxyHostForwardAuthInput = {
  enabled?: boolean;
  provider?: ForwardAuthProvider | null;
  authUpstream?: string | null;
  authEndpoint?: string | null;
  copyHeaders?: string[] | null;
  trustedProxies?: string[] | null;
  apiSplit?: boolean | null;
  apiBypassHeaders?: string[] | null;
  protectedPaths?: string[] | null;
  excludedPaths?: string[] | null;
};

type ForwardAuthMeta = {
  enabled?: boolean;
  provider?: ForwardAuthProvider;
  auth_upstream?: string;
  auth_endpoint?: string;
  copy_headers?: string[];
  trusted_proxies?: string[];
  api_split?: boolean;
  api_bypass_headers?: string[];
  protected_paths?: string[];
  excluded_paths?: string[];
};

type ProxyHostMeta = {
  custom_reverse_proxy_json?: string;
  custom_pre_handlers_json?: string;
  /**
   * Raw Caddyfile directives, adapted to JSON handlers at build time. Stored as written so the
   * operator gets their own text back; the adapted JSON is a build artefact.
   */
  custom_caddyfile?: string;
  authentik?: ProxyHostAuthentikMeta;
  load_balancer?: LoadBalancerMeta;
  dns_resolver?: DnsResolverMeta;
  upstream_dns_resolution?: UpstreamDnsResolutionMeta;
  geoblock?: GeoBlockSettings;
  geoblock_mode?: GeoBlockMode;
  waf?: WafHostConfig;
  mtls?: MtlsConfig;
  cpm_forward_auth?: CpmForwardAuthMeta;
  forward_auth?: ForwardAuthMeta;
  tailscale?: TailscaleMeta;
  redirects?: RedirectRule[];
  rewrite?: RewriteConfig;
  location_rules?: LocationRuleMeta[];
  path_allows?: PathAllowRule[];
  path_blocks?: PathBlockRule[];
  path_rewrites?: PathRewriteRule[];
  error_pages?: ErrorPageRule[];
  cache?: HostCacheMeta;
  /** Absent follows the global setting. */
  compression?: "on" | "off";
  discourage_indexing?: boolean;
  skip_access_log?: boolean;
  maintenance?: HostMaintenanceMeta;
  upstream_timeouts?: HostUpstreamTimeoutsMeta;
  rate_limit?: HostRateLimitMeta;
  crowdsec?: HostCrowdSecMeta;
  anubis?: HostAnubisMeta;
};

export type ProxyHost = {
  id: number;
  /** What URLs and the REST API name the host by. */
  uuid: string;
  name: string;
  description: string | null;
  /** Lowercase, sorted; for finding hosts only. */
  tags: string[];
  domains: string[];
  upstreams: string[];
  certificateId: number | null;
  accessListId: number | null;
  sslForced: boolean;
  hstsEnabled: boolean;
  hstsSubdomains: boolean;
  allowWebsocket: boolean;
  preserveHostHeader: boolean;
  skipHttpsHostnameValidation: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  customReverseProxyJson: string | null;
  customPreHandlersJson: string | null;
  customCaddyfile: string | null;
  authentik: ProxyHostAuthentikConfig | null;
  loadBalancer: LoadBalancerConfig | null;
  dnsResolver: DnsResolverConfig | null;
  upstreamDnsResolution: UpstreamDnsResolutionConfig | null;
  geoblock: GeoBlockSettings | null;
  geoblockMode: GeoBlockMode;
  waf: WafHostConfig | null;
  mtls: MtlsConfig | null;
  cpmForwardAuth: CpmForwardAuthConfig | null;
  forwardAuth: ProxyHostForwardAuthConfig | null;
  tailscale: TailscaleHostConfig | null;
  redirects: RedirectRule[];
  rewrite: RewriteConfig | null;
  locationRules: LocationRule[];
  pathAllows: PathAllowRule[];
  pathBlocks: PathBlockRule[];
  pathRewrites: PathRewriteRule[];
  errorPages: ErrorPageRule[];
  /** Cache assets; null when off. */
  cache: HostCacheConfig | null;
  compression: HostCompressionMode;
  /** X-Robots-Tag on every response, and a robots.txt that disallows everything. */
  discourageIndexing: boolean;
  /** Caddy writes no access-log line for this host. */
  skipAccessLog: boolean;
  /** Null when never configured; kept while off so turning it back on restores the rest. */
  maintenance: HostMaintenanceConfig | null;
  /** Null keeps Caddy's defaults. Location rules inherit them. */
  upstreamTimeouts: HostUpstreamTimeoutsConfig | null;
  /** Null when never configured; zones are kept while it is off. */
  rateLimit: HostRateLimitConfig | null;
  /** Checked against CrowdSec's decisions when CrowdSec is set up; on unless the host opts out. */
  crowdsec: boolean;
  /** Null when never configured; kept while off. */
  anubis: HostAnubisConfig | null;
};

export type ProxyHostInput = {
  name: string;
  /** Free-text notes; blank clears them. */
  description?: string | null;
  /** Normalised on save; null clears them. */
  tags?: string[] | null;
  domains: string[];
  upstreams: string[];
  /**
   * The `agents.id` rows that serve this host. Empty - and, on update, undefined - means every
   * agent, which is what a host had before it could be assigned at all.
   */
  agentIds?: number[];
  certificateId?: number | null;
  accessListId?: number | null;
  sslForced?: boolean;
  hstsEnabled?: boolean;
  hstsSubdomains?: boolean;
  allowWebsocket?: boolean;
  preserveHostHeader?: boolean;
  skipHttpsHostnameValidation?: boolean;
  enabled?: boolean;
  customReverseProxyJson?: string | null;
  customPreHandlersJson?: string | null;
  customCaddyfile?: string | null;
  authentik?: ProxyHostAuthentikInput | null;
  loadBalancer?: LoadBalancerInput | null;
  dnsResolver?: DnsResolverInput | null;
  upstreamDnsResolution?: UpstreamDnsResolutionInput | null;
  geoblock?: GeoBlockSettings | null;
  geoblockMode?: GeoBlockMode;
  waf?: WafHostConfig | null;
  mtls?: MtlsConfig | null;
  cpmForwardAuth?: CpmForwardAuthInput | null;
  forwardAuth?: ProxyHostForwardAuthInput | null;
  tailscale?: TailscaleHostInput | null;
  redirects?: RedirectRule[] | null;
  rewrite?: RewriteConfig | null;
  locationRules?: LocationRuleInput[] | null;
  pathAllows?: PathAllowRule[] | null;
  pathBlocks?: PathBlockRule[] | null;
  pathRewrites?: PathRewriteRule[] | null;
  errorPages?: ErrorPageRule[] | null;
  /** Null turns it off. */
  cache?: HostCacheConfig | null;
  /** Null follows the global setting, as "inherit" does. */
  compression?: HostCompressionMode | null;
  discourageIndexing?: boolean;
  skipAccessLog?: boolean;
  /** Null forgets it; a bad bypass range is refused. */
  maintenance?: Partial<HostMaintenanceConfig> | null;
  /** The whole set: a field left out keeps Caddy's default. Null clears them all. */
  upstreamTimeouts?: Partial<HostUpstreamTimeoutsConfig> | null;
  /** The whole set of zones. Null forgets them; a zone Caddy would reject is refused. */
  rateLimit?: HostRateLimitConfig | null;
  /** False opts the host out of CrowdSec; true or null follows the global setting. */
  crowdsec?: boolean | null;
  /** Null forgets it. Enabling needs the upstream; a bad upstream or exempt path is refused. */
  anubis?: Partial<HostAnubisConfig> | null;
};

type ProxyHostRow = typeof proxyHosts.$inferSelect;

function normalizeMetaValue(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeAuthentikMeta(
  meta: ProxyHostAuthentikMeta | undefined,
): ProxyHostAuthentikMeta | undefined {
  if (!meta) {
    return undefined;
  }

  const normalized: ProxyHostAuthentikMeta = {};

  if (meta.enabled !== undefined) {
    normalized.enabled = Boolean(meta.enabled);
  }

  const domain = normalizeMetaValue(meta.outpost_domain ?? null);
  if (domain) {
    normalized.outpost_domain = domain;
  }

  const upstream = normalizeMetaValue(meta.outpost_upstream ?? null);
  if (upstream) {
    normalized.outpost_upstream = upstream;
  }

  const authEndpoint = normalizeMetaValue(meta.auth_endpoint ?? null);
  if (authEndpoint) {
    normalized.auth_endpoint = stripCaddyPlaceholders(authEndpoint);
  }

  if (Array.isArray(meta.copy_headers)) {
    const headers = sanitizeHeaderNames(meta.copy_headers);
    if (headers.length > 0) {
      normalized.copy_headers = headers;
    }
  }

  if (Array.isArray(meta.trusted_proxies)) {
    const proxies = meta.trusted_proxies
      .map((proxy) => proxy?.trim())
      .filter((proxy): proxy is string => Boolean(proxy));
    if (proxies.length > 0) {
      normalized.trusted_proxies = proxies;
    }
  }

  if (meta.set_outpost_host_header !== undefined) {
    normalized.set_outpost_host_header = Boolean(meta.set_outpost_host_header);
  }

  if (Array.isArray(meta.protected_paths)) {
    const paths = meta.protected_paths
      .map((path) => stripCaddyPlaceholders(path?.trim() ?? ""))
      .filter((path): path is string => Boolean(path));
    if (paths.length > 0) {
      normalized.protected_paths = paths;
    }
  }

  if (Array.isArray(meta.excluded_paths)) {
    const paths = meta.excluded_paths
      .map((path) => stripCaddyPlaceholders(path?.trim() ?? ""))
      .filter((path): path is string => Boolean(path));
    if (paths.length > 0) {
      normalized.excluded_paths = paths;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

const VALID_LB_POLICIES: LoadBalancingPolicy[] = [
  "random",
  "random_choose",
  "round_robin",
  "weighted_round_robin",
  "least_conn",
  "ip_hash",
  "client_ip_hash",
  "first",
  "header",
  "cookie",
  "uri_hash",
  "query",
];

/** Refused in health-check headers: a newline would forge a second header on every probe. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function sanitizeLoadBalancerMeta(
  meta: LoadBalancerMeta | undefined,
): LoadBalancerMeta | undefined {
  if (!meta) {
    return undefined;
  }

  const normalized: LoadBalancerMeta = {};

  if (meta.enabled !== undefined) {
    normalized.enabled = Boolean(meta.enabled);
  }

  if (meta.policy && VALID_LB_POLICIES.includes(meta.policy as LoadBalancingPolicy)) {
    normalized.policy = meta.policy;
  }

  const headerField = normalizeMetaValue(meta.policy_header_field ?? null);
  if (headerField) {
    normalized.policy_header_field = headerField;
  }

  const cookieName = normalizeMetaValue(meta.policy_cookie_name ?? null);
  if (cookieName) {
    normalized.policy_cookie_name = cookieName;
  }

  const cookieSecret = normalizeMetaValue(meta.policy_cookie_secret ?? null);
  if (cookieSecret) {
    normalized.policy_cookie_secret = cookieSecret;
  }

  const queryKey = normalizeMetaValue(meta.policy_query_key ?? null);
  if (queryKey) {
    normalized.policy_query_key = queryKey;
  }

  // Bounded: `random_choose` picks between this many upstreams, so a value below two is not a
  // choice and an absurd one only wastes work per request.
  if (
    typeof meta.policy_choose === "number" &&
    Number.isInteger(meta.policy_choose) &&
    meta.policy_choose >= 2 &&
    meta.policy_choose <= 16
  ) {
    normalized.policy_choose = meta.policy_choose;
  }

  if (Array.isArray(meta.policy_weights)) {
    const weights = meta.policy_weights.filter(
      (w): w is number => typeof w === "number" && Number.isInteger(w) && w >= 0 && w <= 1000,
    );
    // All or nothing: a partly-valid list would silently reweight the upstreams that survived.
    if (weights.length > 0 && weights.length === meta.policy_weights.length) {
      normalized.policy_weights = weights;
    }
  }

  const tryDuration = normalizeMetaValue(meta.try_duration ?? null);
  if (tryDuration) {
    normalized.try_duration = tryDuration;
  }

  const tryInterval = normalizeMetaValue(meta.try_interval ?? null);
  if (tryInterval) {
    normalized.try_interval = tryInterval;
  }

  if (typeof meta.retries === "number" && Number.isFinite(meta.retries) && meta.retries >= 0) {
    normalized.retries = meta.retries;
  }

  if (meta.active_health_check) {
    const ahc: LoadBalancerActiveHealthCheckMeta = {};
    if (meta.active_health_check.enabled !== undefined) {
      ahc.enabled = Boolean(meta.active_health_check.enabled);
    }
    const uri = normalizeMetaValue(meta.active_health_check.uri ?? null);
    if (uri) {
      ahc.uri = uri;
    }
    if (
      typeof meta.active_health_check.port === "number" &&
      Number.isFinite(meta.active_health_check.port) &&
      meta.active_health_check.port > 0
    ) {
      ahc.port = meta.active_health_check.port;
    }
    const interval = normalizeMetaValue(meta.active_health_check.interval ?? null);
    if (interval) {
      ahc.interval = interval;
    }
    const timeout = normalizeMetaValue(meta.active_health_check.timeout ?? null);
    if (timeout) {
      ahc.timeout = timeout;
    }
    if (
      typeof meta.active_health_check.status === "number" &&
      Number.isFinite(meta.active_health_check.status) &&
      meta.active_health_check.status >= 100
    ) {
      ahc.status = meta.active_health_check.status;
    }
    const body = normalizeMetaValue(meta.active_health_check.body ?? null);
    if (body) {
      ahc.body = body;
    }
    for (const key of ["passes", "fails"] as const) {
      const value = meta.active_health_check[key];
      if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100) {
        ahc[key] = value;
      }
    }
    const method = normalizeMetaValue(meta.active_health_check.method ?? null);
    // Allowlisted rather than pattern-matched: this becomes the method of a request Caddy makes on
    // a timer, and anything outside these is a probe nobody meant to configure.
    if (method && ["GET", "HEAD", "POST", "PUT", "OPTIONS"].includes(method.toUpperCase())) {
      ahc.method = method.toUpperCase();
    }
    const requestBody = normalizeMetaValue(meta.active_health_check.request_body ?? null);
    if (requestBody) {
      ahc.request_body = requestBody;
    }
    if (meta.active_health_check.follow_redirects !== undefined) {
      ahc.follow_redirects = Boolean(meta.active_health_check.follow_redirects);
    }
    if (meta.active_health_check.headers && typeof meta.active_health_check.headers === "object") {
      const headers: Record<string, string> = {};
      for (const [field, value] of Object.entries(meta.active_health_check.headers)) {
        // A newline in either half would forge a second header on every probe.
        if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(field)) continue;
        const cleaned = normalizeMetaValue(typeof value === "string" ? value : null);
        if (!cleaned || CONTROL_CHARS.test(cleaned)) continue;
        headers[field] = cleaned;
      }
      if (Object.keys(headers).length > 0) {
        ahc.headers = headers;
      }
    }
    if (Object.keys(ahc).length > 0) {
      normalized.active_health_check = ahc;
    }
  }

  if (meta.passive_health_check) {
    const phc: LoadBalancerPassiveHealthCheckMeta = {};
    if (meta.passive_health_check.enabled !== undefined) {
      phc.enabled = Boolean(meta.passive_health_check.enabled);
    }
    const failDuration = normalizeMetaValue(meta.passive_health_check.fail_duration ?? null);
    if (failDuration) {
      phc.fail_duration = failDuration;
    }
    if (
      typeof meta.passive_health_check.max_fails === "number" &&
      Number.isFinite(meta.passive_health_check.max_fails) &&
      meta.passive_health_check.max_fails >= 0
    ) {
      phc.max_fails = meta.passive_health_check.max_fails;
    }
    if (Array.isArray(meta.passive_health_check.unhealthy_status)) {
      const statuses = meta.passive_health_check.unhealthy_status.filter(
        (s): s is number => typeof s === "number" && Number.isFinite(s) && s >= 100,
      );
      if (statuses.length > 0) {
        phc.unhealthy_status = statuses;
      }
    }
    const unhealthyLatency = normalizeMetaValue(
      meta.passive_health_check.unhealthy_latency ?? null,
    );
    if (unhealthyLatency) {
      phc.unhealthy_latency = unhealthyLatency;
    }
    if (
      typeof meta.passive_health_check.unhealthy_request_count === "number" &&
      Number.isInteger(meta.passive_health_check.unhealthy_request_count) &&
      meta.passive_health_check.unhealthy_request_count > 0
    ) {
      phc.unhealthy_request_count = meta.passive_health_check.unhealthy_request_count;
    }
    if (Object.keys(phc).length > 0) {
      normalized.passive_health_check = phc;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function sanitizeDnsResolverMeta(meta: DnsResolverMeta | undefined): DnsResolverMeta | undefined {
  if (!meta) {
    return undefined;
  }

  const normalized: DnsResolverMeta = {};

  if (meta.enabled !== undefined) {
    normalized.enabled = Boolean(meta.enabled);
  }

  if (Array.isArray(meta.resolvers)) {
    const resolvers = meta.resolvers
      .map((r) => (typeof r === "string" ? r.trim() : ""))
      .filter((r) => r.length > 0);
    if (resolvers.length > 0) {
      normalized.resolvers = resolvers;
    }
  }

  if (Array.isArray(meta.fallbacks)) {
    const fallbacks = meta.fallbacks
      .map((r) => (typeof r === "string" ? r.trim() : ""))
      .filter((r) => r.length > 0);
    if (fallbacks.length > 0) {
      normalized.fallbacks = fallbacks;
    }
  }

  const timeout = normalizeMetaValue(meta.timeout ?? null);
  if (timeout && isCaddyDuration(timeout)) {
    normalized.timeout = timeout;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function sanitizeUpstreamDnsResolutionMeta(
  meta: UpstreamDnsResolutionMeta | undefined,
): UpstreamDnsResolutionMeta | undefined {
  if (!meta) {
    return undefined;
  }

  const normalized: UpstreamDnsResolutionMeta = {};
  if (meta.enabled !== undefined) {
    normalized.enabled = Boolean(meta.enabled);
  }

  if (meta.family && VALID_UPSTREAM_DNS_FAMILIES.includes(meta.family)) {
    normalized.family = meta.family;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function sanitizeCpmForwardAuthMeta(
  meta: CpmForwardAuthMeta | undefined,
): CpmForwardAuthMeta | undefined {
  if (!meta) return undefined;
  const normalized: CpmForwardAuthMeta = {};
  if (meta.enabled !== undefined) {
    normalized.enabled = Boolean(meta.enabled);
  }
  if (Array.isArray(meta.protected_paths)) {
    const paths = meta.protected_paths
      .map((p) => stripCaddyPlaceholders(p?.trim() ?? ""))
      .filter((p): p is string => Boolean(p));
    if (paths.length > 0) {
      normalized.protected_paths = paths;
    }
  }
  if (Array.isArray(meta.excluded_paths)) {
    const paths = meta.excluded_paths
      .map((p) => stripCaddyPlaceholders(p?.trim() ?? ""))
      .filter((p): p is string => Boolean(p));
    if (paths.length > 0) {
      normalized.excluded_paths = paths;
    }
  }
  if (meta.require_captcha === false) {
    normalized.require_captcha = false;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * Header names are held to RFC 7230 and Caddy placeholders stripped from the endpoint and paths:
 * all three are interpolated into config, where a `{...}` would read as request context.
 */
function sanitizeForwardAuthMeta(meta: ForwardAuthMeta | undefined): ForwardAuthMeta | undefined {
  if (!meta) return undefined;
  const normalized: ForwardAuthMeta = {};

  if (meta.enabled !== undefined) normalized.enabled = Boolean(meta.enabled);
  if (meta.provider && (FORWARD_AUTH_PROVIDERS as readonly string[]).includes(meta.provider)) {
    normalized.provider = meta.provider;
  }

  const upstream = normalizeMetaValue(meta.auth_upstream ?? null);
  if (upstream) normalized.auth_upstream = upstream;

  const endpoint = normalizeMetaValue(meta.auth_endpoint ?? null);
  if (endpoint) {
    const stripped = stripCaddyPlaceholders(endpoint);
    if (stripped) normalized.auth_endpoint = stripped;
  }

  const copyHeaders = sanitizeHeaderNames(meta.copy_headers);
  if (copyHeaders.length > 0) normalized.copy_headers = copyHeaders;

  if (Array.isArray(meta.trusted_proxies)) {
    const proxies = meta.trusted_proxies
      .map((proxy) => proxy?.trim())
      .filter((proxy): proxy is string => Boolean(proxy));
    if (proxies.length > 0) normalized.trusted_proxies = proxies;
  }

  if (meta.api_split !== undefined) normalized.api_split = Boolean(meta.api_split);

  const bypassHeaders = sanitizeHeaderNames(meta.api_bypass_headers);
  if (bypassHeaders.length > 0) normalized.api_bypass_headers = bypassHeaders;

  const protectedPaths = sanitizeForwardAuthPaths(meta.protected_paths);
  if (protectedPaths) normalized.protected_paths = protectedPaths;

  const excludedPaths = sanitizeForwardAuthPaths(meta.excluded_paths);
  if (excludedPaths) normalized.excluded_paths = excludedPaths;

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function sanitizeHeaderNames(values: string[] | null | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value) && HEADER_NAME_PATTERN.test(value));
}

function sanitizeForwardAuthPaths(values: string[] | null | undefined): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const paths = values
    .map((value) => stripCaddyPlaceholders(value?.trim() ?? ""))
    .filter((value): value is string => Boolean(value));
  return paths.length > 0 ? paths : undefined;
}

function serializeMeta(meta: ProxyHostMeta | null | undefined) {
  if (!meta) {
    return null;
  }
  const normalized: ProxyHostMeta = {};
  const reverse = normalizeMetaValue(meta.custom_reverse_proxy_json ?? null);
  const preHandlers = normalizeMetaValue(meta.custom_pre_handlers_json ?? null);
  const caddyfile = normalizeMetaValue(meta.custom_caddyfile ?? null);

  if (reverse) {
    normalized.custom_reverse_proxy_json = reverse;
  }
  if (preHandlers) {
    normalized.custom_pre_handlers_json = preHandlers;
  }
  if (caddyfile) {
    normalized.custom_caddyfile = caddyfile;
  }

  const authentik = sanitizeAuthentikMeta(meta.authentik);
  if (authentik) {
    normalized.authentik = authentik;
  }

  const loadBalancer = sanitizeLoadBalancerMeta(meta.load_balancer);
  if (loadBalancer) {
    normalized.load_balancer = loadBalancer;
  }

  const dnsResolver = sanitizeDnsResolverMeta(meta.dns_resolver);
  if (dnsResolver) {
    normalized.dns_resolver = dnsResolver;
  }

  const upstreamDnsResolution = sanitizeUpstreamDnsResolutionMeta(meta.upstream_dns_resolution);
  if (upstreamDnsResolution) {
    normalized.upstream_dns_resolution = upstreamDnsResolution;
  }

  if (meta.geoblock) {
    normalized.geoblock = meta.geoblock;
  }

  if (meta.geoblock_mode) {
    normalized.geoblock_mode = meta.geoblock_mode;
  }

  // Validated in buildMeta, and only when the caller supplies `waf`.
  if (meta.waf) {
    normalized.waf = meta.waf;
  }

  if (meta.mtls) {
    const mtls = sanitizeMtlsMeta(meta.mtls);
    if (mtls) {
      normalized.mtls = mtls;
    }
  }

  if (meta.cpm_forward_auth) {
    const cfa = sanitizeCpmForwardAuthMeta(meta.cpm_forward_auth);
    if (cfa) {
      normalized.cpm_forward_auth = cfa;
    }
  }

  if (meta.forward_auth) {
    const forwardAuth = sanitizeForwardAuthMeta(meta.forward_auth);
    if (forwardAuth) {
      normalized.forward_auth = forwardAuth;
    }
  }

  if (meta.tailscale) {
    const tailscale = sanitizeTailscaleMeta(meta.tailscale);
    if (tailscale) {
      normalized.tailscale = tailscale;
    }
  }

  if (meta.redirects && meta.redirects.length > 0) {
    normalized.redirects = meta.redirects;
  }
  if (meta.rewrite?.path_prefix) {
    normalized.rewrite = meta.rewrite;
  }

  if (meta.location_rules && meta.location_rules.length > 0) {
    normalized.location_rules = meta.location_rules;
  }

  if (meta.path_allows && meta.path_allows.length > 0) {
    normalized.path_allows = meta.path_allows;
  }

  if (meta.path_blocks && meta.path_blocks.length > 0) {
    normalized.path_blocks = meta.path_blocks;
  }

  if (meta.path_rewrites && meta.path_rewrites.length > 0) {
    normalized.path_rewrites = meta.path_rewrites;
  }

  const cache = sanitizeHostCache(meta.cache);
  if (cache) normalized.cache = cache;

  const compression = sanitizeHostCompression(meta.compression);
  if (compression !== "inherit") normalized.compression = compression;

  if (meta.discourage_indexing === true) normalized.discourage_indexing = true;
  if (meta.skip_access_log === true) normalized.skip_access_log = true;

  const maintenance = sanitizeHostMaintenance(meta.maintenance);
  if (maintenance) normalized.maintenance = maintenance;

  const upstreamTimeouts = sanitizeHostUpstreamTimeouts(meta.upstream_timeouts);
  if (upstreamTimeouts) normalized.upstream_timeouts = upstreamTimeouts;

  const rateLimit = sanitizeHostRateLimit(meta.rate_limit);
  if (rateLimit) normalized.rate_limit = rateLimit;

  const crowdsec = sanitizeHostCrowdSec(meta.crowdsec);
  if (crowdsec) normalized.crowdsec = crowdsec;

  const anubis = sanitizeHostAnubis(meta.anubis);
  if (anubis) normalized.anubis = anubis;

  if (meta.error_pages && meta.error_pages.length > 0) {
    const errorPages = sanitizeErrorPageRules(meta.error_pages);
    if (errorPages.length > 0) {
      normalized.error_pages = errorPages;
    }
  }

  return Object.keys(normalized).length > 0 ? JSON.stringify(normalized) : null;
}

function sanitizeRedirectRules(value: unknown): RedirectRule[] {
  if (!Array.isArray(value)) return [];
  const valid: RedirectRule[] = [];
  for (const item of value) {
    if (
      item &&
      typeof item === "object" &&
      typeof item.from === "string" &&
      item.from.trim() &&
      typeof item.to === "string" &&
      item.to.trim() &&
      [301, 302, 307, 308].includes(item.status)
    ) {
      valid.push({
        from: stripCaddyPlaceholders(item.from.trim()),
        to: stripCaddyPlaceholders(item.to.trim()),
        status: item.status,
        ...(REDIRECT_PATH_MODES.includes(item.preservePath) && { preservePath: item.preservePath }),
      });
    }
  }
  return valid;
}

function sanitizeRewriteConfig(value: unknown): RewriteConfig | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const prefix = typeof v.path_prefix === "string" ? v.path_prefix.trim() : null;
  if (!prefix) return null;
  return { path_prefix: prefix };
}

function sanitizePathAllows(value: unknown): PathAllowRule[] {
  if (!Array.isArray(value)) return [];
  const valid: PathAllowRule[] = [];
  for (const item of value) {
    if (item && typeof item === "object" && typeof item.path === "string" && item.path.trim()) {
      const path = stripCaddyPlaceholders(item.path.trim());
      if (path) {
        valid.push({ path });
      }
    }
  }
  return valid;
}

function sanitizePathBlocks(value: unknown): PathBlockRule[] {
  if (!Array.isArray(value)) return [];
  const valid: PathBlockRule[] = [];
  for (const item of value) {
    if (
      item &&
      typeof item === "object" &&
      typeof item.path === "string" &&
      item.path.trim() &&
      typeof item.status === "number" &&
      (PATH_BLOCK_STATUS_CODES as readonly number[]).includes(item.status)
    ) {
      const rule: PathBlockRule = {
        path: stripCaddyPlaceholders(item.path.trim()),
        status: item.status as PathBlockStatusCode,
      };
      if (typeof item.body === "string" && item.body.length > 0) {
        rule.body = item.body.slice(0, 4096);
      }
      if (rule.path) {
        valid.push(rule);
      }
    }
  }
  return valid;
}

function sanitizePathRewrites(value: unknown): PathRewriteRule[] {
  if (!Array.isArray(value)) return [];
  const valid: PathRewriteRule[] = [];
  for (const item of value) {
    if (
      item &&
      typeof item === "object" &&
      typeof item.from === "string" &&
      item.from.trim() &&
      typeof item.to === "string" &&
      item.to.trim()
    ) {
      const from = stripCaddyPlaceholders(item.from.trim());
      const to = stripCaddyPlaceholders(item.to.trim());
      if (from && to) {
        valid.push({ from, to });
      }
    }
  }
  return valid;
}

const ERROR_PAGE_BODY_MAX = 65536;
const ERROR_PAGE_CONTENT_TYPE_MAX = 128;

export function sanitizeErrorPageRules(value: unknown): ErrorPageRule[] {
  if (!Array.isArray(value)) return [];
  const valid: ErrorPageRule[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const body = typeof item.body === "string" ? item.body : "";
    if (!body) continue; // a rule with no body would do nothing
    const rawStatuses: unknown[] = Array.isArray(item.statuses) ? item.statuses : [];
    const statuses = [
      ...new Set(
        rawStatuses.filter(
          (s): s is number => typeof s === "number" && Number.isInteger(s) && s >= 400 && s <= 599,
        ),
      ),
    ];
    const rule: ErrorPageRule = { statuses, body: body.slice(0, ERROR_PAGE_BODY_MAX) };
    if (typeof item.contentType === "string") {
      // Strip CR/LF to prevent response header injection.
      const ct = item.contentType
        .replace(/[\r\n]/g, "")
        .trim()
        .slice(0, ERROR_PAGE_CONTENT_TYPE_MAX);
      if (ct) rule.contentType = ct;
    }
    valid.push(rule);
  }
  return valid;
}

/** A rule's own access list as stored: absent inherits the host's, null is none. */
function parseLocationAccessListId(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseLocationRuleBase(item: unknown): { path: string; upstreams: string[] } | null {
  if (
    item &&
    typeof item === "object" &&
    typeof (item as { path?: unknown }).path === "string" &&
    (item as { path: string }).path.trim() &&
    Array.isArray((item as { upstreams?: unknown }).upstreams)
  ) {
    const upstreams = (item as { upstreams: unknown[] }).upstreams
      .filter((u): u is string => typeof u === "string" && Boolean(u.trim()))
      .map((u) => u.trim());
    if (upstreams.length > 0) {
      return { path: (item as { path: string }).path.trim(), upstreams };
    }
  }
  return null;
}

// Sanitize location rules read from stored meta (snake_case load_balancer).
function sanitizeLocationRuleMetas(value: unknown): LocationRuleMeta[] {
  if (!Array.isArray(value)) return [];
  const valid: LocationRuleMeta[] = [];
  for (const item of value) {
    const base = parseLocationRuleBase(item);
    if (!base) continue;
    const rule: LocationRuleMeta = base;
    const lb = sanitizeLoadBalancerMeta(
      (item as { load_balancer?: LoadBalancerMeta }).load_balancer,
    );
    if (lb) rule.load_balancer = lb;
    const accessListId = parseLocationAccessListId(
      (item as { access_list_id?: unknown }).access_list_id,
    );
    if (accessListId !== undefined) rule.access_list_id = accessListId;
    valid.push(rule);
  }
  return valid;
}

// Normalize location rules supplied as input (camelCase loadBalancer) into the stored meta
// shape, reusing the host-level load-balancer input normalizer.
function normalizeLocationRulesInput(value: unknown): LocationRuleMeta[] {
  if (!Array.isArray(value)) return [];
  const valid: LocationRuleMeta[] = [];
  for (const item of value) {
    const base = parseLocationRuleBase(item);
    if (!base) continue;
    const rule: LocationRuleMeta = base;
    const lbInput = (item as { loadBalancer?: LoadBalancerInput | null }).loadBalancer;
    const lb = normalizeLoadBalancerInput(lbInput ?? null, undefined);
    if (lb) rule.load_balancer = lb;
    const accessListId = parseLocationAccessListId(
      (item as { accessListId?: unknown }).accessListId,
    );
    if (accessListId !== undefined) rule.access_list_id = accessListId;
    valid.push(rule);
  }
  return valid;
}

function hydrateLocationRules(metaRules: LocationRuleMeta[] | undefined): LocationRule[] {
  if (!metaRules) return [];
  return metaRules.map((rule) => ({
    path: rule.path,
    upstreams: rule.upstreams,
    loadBalancer: hydrateLoadBalancer(rule.load_balancer),
    ...(rule.access_list_id !== undefined && { accessListId: rule.access_list_id }),
  }));
}

function dehydrateLocationRules(rules: LocationRule[]): LocationRuleMeta[] {
  return rules.map((rule) => {
    const meta: LocationRuleMeta = { path: rule.path, upstreams: rule.upstreams };
    const lb = dehydrateLoadBalancer(rule.loadBalancer);
    if (lb) meta.load_balancer = lb;
    if (rule.accessListId !== undefined) meta.access_list_id = rule.accessListId;
    return meta;
  });
}

/** A location rule's own list must exist; a dangling id would quietly refuse the path. */
async function assertLocationAccessListsExist(rules: LocationRuleMeta[] | undefined) {
  const ids = [
    ...new Set(
      (rules ?? [])
        .map((rule) => rule.access_list_id)
        .filter((id): id is number => typeof id === "number"),
    ),
  ];
  if (ids.length === 0) return;
  const found = await db
    .select({ id: accessLists.id })
    .from(accessLists)
    .where(inArray(accessLists.id, ids));
  if (found.length !== ids.length) throw domainError("accessListNotFound", {}, { status: 400 });
}

function storedCompression(value: unknown): ProxyHostMeta["compression"] {
  const mode = sanitizeHostCompression(value);
  return mode === "inherit" ? undefined : mode;
}

function parseMeta(value: string | null): ProxyHostMeta {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as ProxyHostMeta;
    return {
      custom_reverse_proxy_json:
        normalizeMetaValue(parsed.custom_reverse_proxy_json ?? null) ?? undefined,
      custom_pre_handlers_json:
        normalizeMetaValue(parsed.custom_pre_handlers_json ?? null) ?? undefined,
      custom_caddyfile: normalizeMetaValue(parsed.custom_caddyfile ?? null) ?? undefined,
      authentik: sanitizeAuthentikMeta(parsed.authentik),
      load_balancer: sanitizeLoadBalancerMeta(parsed.load_balancer),
      dns_resolver: sanitizeDnsResolverMeta(parsed.dns_resolver),
      upstream_dns_resolution: sanitizeUpstreamDnsResolutionMeta(parsed.upstream_dns_resolution),
      geoblock: parsed.geoblock,
      geoblock_mode: parsed.geoblock_mode,
      waf: parsed.waf,
      mtls: parsed.mtls,
      cpm_forward_auth: sanitizeCpmForwardAuthMeta(parsed.cpm_forward_auth),
      forward_auth: sanitizeForwardAuthMeta(parsed.forward_auth),
      tailscale: sanitizeTailscaleMeta(parsed.tailscale),
      redirects: sanitizeRedirectRules(parsed.redirects),
      rewrite: sanitizeRewriteConfig(parsed.rewrite) ?? undefined,
      location_rules: sanitizeLocationRuleMetas(parsed.location_rules),
      path_allows: sanitizePathAllows(parsed.path_allows),
      path_blocks: sanitizePathBlocks(parsed.path_blocks),
      path_rewrites: sanitizePathRewrites(parsed.path_rewrites),
      error_pages: sanitizeErrorPageRules(parsed.error_pages),
      cache: sanitizeHostCache(parsed.cache),
      compression: storedCompression(parsed.compression),
      discourage_indexing: parsed.discourage_indexing === true || undefined,
      skip_access_log: parsed.skip_access_log === true || undefined,
      maintenance: sanitizeHostMaintenance(parsed.maintenance),
      upstream_timeouts: sanitizeHostUpstreamTimeouts(parsed.upstream_timeouts),
      rate_limit: sanitizeHostRateLimit(parsed.rate_limit),
      crowdsec: sanitizeHostCrowdSec(parsed.crowdsec),
      anubis: sanitizeHostAnubis(parsed.anubis),
    };
  } catch (error) {
    console.warn("Failed to parse proxy host meta", error);
    return {};
  }
}

function normalizeAuthentikInput(
  input: ProxyHostAuthentikInput | null | undefined,
  existing: ProxyHostAuthentikMeta | undefined,
): ProxyHostAuthentikMeta | undefined {
  if (input === undefined) {
    return existing;
  }
  if (input === null) {
    return undefined;
  }

  const next: ProxyHostAuthentikMeta = { ...(existing ?? {}) };

  if (input.enabled !== undefined) {
    next.enabled = Boolean(input.enabled);
  }

  if (input.outpostDomain !== undefined) {
    const domain = normalizeMetaValue(input.outpostDomain ?? null);
    if (domain) {
      next.outpost_domain = domain;
    } else {
      delete next.outpost_domain;
    }
  }

  if (input.outpostUpstream !== undefined) {
    const upstream = normalizeMetaValue(input.outpostUpstream ?? null);
    if (upstream) {
      next.outpost_upstream = upstream;
    } else {
      delete next.outpost_upstream;
    }
  }

  if (input.authEndpoint !== undefined) {
    const endpoint = normalizeMetaValue(input.authEndpoint ?? null);
    if (endpoint) {
      next.auth_endpoint = endpoint;
    } else {
      delete next.auth_endpoint;
    }
  }

  if (input.copyHeaders !== undefined) {
    const headers = sanitizeHeaderNames(input.copyHeaders);
    if (headers.length > 0) {
      next.copy_headers = headers;
    } else {
      delete next.copy_headers;
    }
  }

  if (input.trustedProxies !== undefined) {
    const proxies = (input.trustedProxies ?? [])
      .map((proxy) => proxy?.trim())
      .filter((proxy): proxy is string => Boolean(proxy));
    if (proxies.length > 0) {
      next.trusted_proxies = proxies;
    } else {
      delete next.trusted_proxies;
    }
  }

  if (input.setOutpostHostHeader !== undefined) {
    next.set_outpost_host_header = Boolean(input.setOutpostHostHeader);
  }

  if (input.protectedPaths !== undefined) {
    const paths = (input.protectedPaths ?? [])
      .map((path) => path?.trim())
      .filter((path): path is string => Boolean(path));
    if (paths.length > 0) {
      next.protected_paths = paths;
    } else {
      delete next.protected_paths;
    }
  }

  if (input.excludedPaths !== undefined) {
    const paths = (input.excludedPaths ?? [])
      .map((path) => path?.trim())
      .filter((path): path is string => Boolean(path));
    if (paths.length > 0) {
      next.excluded_paths = paths;
    } else {
      delete next.excluded_paths;
    }
  }

  if ((next.enabled ?? false) && next.outpost_domain && !next.auth_endpoint) {
    next.auth_endpoint = `/${next.outpost_domain}/auth/caddy`;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Enabling validates: generation treats an unreadable block as absent, which publishes the host
 * with no authentication - so a half-filled block would open a host the operator just protected.
 */
function normalizeForwardAuthInput(
  input: ProxyHostForwardAuthInput | null | undefined,
  existing: ForwardAuthMeta | undefined,
): ForwardAuthMeta | undefined {
  if (input === undefined) return existing;
  if (input === null) return undefined;

  const next: ForwardAuthMeta = { ...(existing ?? {}) };

  if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);

  if (input.provider !== undefined) {
    if (input.provider && (FORWARD_AUTH_PROVIDERS as readonly string[]).includes(input.provider)) {
      next.provider = input.provider;
    } else {
      delete next.provider;
    }
  }

  if (input.authUpstream !== undefined) {
    const upstream = normalizeMetaValue(input.authUpstream ?? null);
    if (upstream) next.auth_upstream = upstream;
    else delete next.auth_upstream;
  }

  if (input.authEndpoint !== undefined) {
    const endpoint = normalizeMetaValue(input.authEndpoint ?? null);
    const stripped = endpoint ? stripCaddyPlaceholders(endpoint) : "";
    if (stripped) next.auth_endpoint = stripped;
    else delete next.auth_endpoint;
  }

  if (input.copyHeaders !== undefined) {
    const headers = sanitizeHeaderNames(input.copyHeaders);
    if (headers.length > 0) next.copy_headers = headers;
    else delete next.copy_headers;
  }

  if (input.trustedProxies !== undefined) {
    const proxies = (input.trustedProxies ?? [])
      .map((proxy) => proxy?.trim())
      .filter((proxy): proxy is string => Boolean(proxy));
    if (proxies.length > 0) next.trusted_proxies = proxies;
    else delete next.trusted_proxies;
  }

  if (input.apiSplit !== undefined) next.api_split = Boolean(input.apiSplit);

  if (input.apiBypassHeaders !== undefined) {
    const headers = sanitizeHeaderNames(input.apiBypassHeaders);
    if (headers.length > 0) next.api_bypass_headers = headers;
    else delete next.api_bypass_headers;
  }

  if (input.protectedPaths !== undefined) {
    const paths = sanitizeForwardAuthPaths(input.protectedPaths);
    if (paths) next.protected_paths = paths;
    else delete next.protected_paths;
  }

  if (input.excludedPaths !== undefined) {
    const paths = sanitizeForwardAuthPaths(input.excludedPaths);
    if (paths) next.excluded_paths = paths;
    else delete next.excluded_paths;
  }

  // The preset fills in what the request left blank, and only when the request named a provider:
  // a later edit that clears a field on purpose keeps it cleared.
  if (
    input.provider !== undefined &&
    next.enabled &&
    (next.provider ?? "authelia") === "authelia"
  ) {
    if (!next.auth_endpoint) next.auth_endpoint = DEFAULT_AUTHELIA_FORWARD_AUTH_ENDPOINT;
    if (!next.copy_headers) next.copy_headers = [...DEFAULT_AUTHELIA_FORWARD_AUTH_HEADERS];
  }

  if (next.enabled) {
    const provider = next.provider ?? "authelia";
    const upstream = next.auth_upstream;
    if (!upstream) throw domainError("hostForwardAuthUpstreamRequired", {}, { status: 400 });
    let parsed: URL;
    try {
      parsed = new URL(upstream);
    } catch {
      throw domainError("hostForwardAuthUpstreamInvalid", {}, { status: 400 });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw domainError("hostForwardAuthUpstreamInvalid", {}, { status: 400 });
    }
    if (provider === "custom" && !next.auth_endpoint) {
      throw domainError("hostForwardAuthEndpointRequired", {}, { status: 400 });
    }
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Generation picks one authenticator by precedence (Authentik, this, the portal), so a second would
 * look active while doing nothing. Raised only when this request turns one on, so a row that
 * already has both stays editable.
 */
function assertSingleForwardAuthProvider(
  meta: ProxyHostMeta,
  input: Partial<ProxyHostInput>,
): void {
  const enabled: string[] = [];
  if (meta.authentik?.enabled) enabled.push("Authentik");
  if (meta.forward_auth?.enabled) enabled.push("forward auth");
  if (meta.cpm_forward_auth?.enabled) enabled.push("the built-in portal");
  if (enabled.length < 2) return;

  const touched =
    input.authentik !== undefined ||
    input.forwardAuth !== undefined ||
    input.cpmForwardAuth !== undefined;
  if (!touched) return;

  throw domainError("hostForwardAuthProviderConflict", { providers: enabled }, { status: 400 });
}

function normalizeLoadBalancerInput(
  input: LoadBalancerInput | null | undefined,
  existing: LoadBalancerMeta | undefined,
): LoadBalancerMeta | undefined {
  if (input === undefined) {
    return existing;
  }
  if (input === null) {
    return undefined;
  }

  const next: LoadBalancerMeta = { ...(existing ?? {}) };

  if (input.enabled !== undefined) {
    next.enabled = Boolean(input.enabled);
  }

  if (input.policy !== undefined) {
    if (input.policy && VALID_LB_POLICIES.includes(input.policy)) {
      next.policy = input.policy;
    } else {
      delete next.policy;
    }
  }

  if (input.policyHeaderField !== undefined) {
    const val = normalizeMetaValue(input.policyHeaderField ?? null);
    if (val) {
      next.policy_header_field = val;
    } else {
      delete next.policy_header_field;
    }
  }

  if (input.policyQueryKey !== undefined) {
    const val = normalizeMetaValue(input.policyQueryKey ?? null);
    if (val) {
      next.policy_query_key = val;
    } else {
      delete next.policy_query_key;
    }
  }

  if (input.policyChoose !== undefined) {
    if (typeof input.policyChoose === "number" && Number.isInteger(input.policyChoose)) {
      next.policy_choose = input.policyChoose;
    } else {
      delete next.policy_choose;
    }
  }

  if (input.policyWeights !== undefined) {
    if (Array.isArray(input.policyWeights) && input.policyWeights.length > 0) {
      next.policy_weights = input.policyWeights;
    } else {
      delete next.policy_weights;
    }
  }

  if (input.policyCookieName !== undefined) {
    const val = normalizeMetaValue(input.policyCookieName ?? null);
    if (val) {
      next.policy_cookie_name = val;
    } else {
      delete next.policy_cookie_name;
    }
  }

  if (input.policyCookieSecret !== undefined) {
    const val = normalizeMetaValue(input.policyCookieSecret ?? null);
    if (val) {
      next.policy_cookie_secret = val;
    } else {
      delete next.policy_cookie_secret;
    }
  }

  if (input.tryDuration !== undefined) {
    const val = normalizeMetaValue(input.tryDuration ?? null);
    if (val) {
      next.try_duration = val;
    } else {
      delete next.try_duration;
    }
  }

  if (input.tryInterval !== undefined) {
    const val = normalizeMetaValue(input.tryInterval ?? null);
    if (val) {
      next.try_interval = val;
    } else {
      delete next.try_interval;
    }
  }

  if (input.retries !== undefined) {
    if (typeof input.retries === "number" && Number.isFinite(input.retries) && input.retries >= 0) {
      next.retries = input.retries;
    } else {
      delete next.retries;
    }
  }

  if (input.activeHealthCheck !== undefined) {
    if (input.activeHealthCheck === null) {
      delete next.active_health_check;
    } else {
      const ahc: LoadBalancerActiveHealthCheckMeta = { ...(existing?.active_health_check ?? {}) };

      if (input.activeHealthCheck.enabled !== undefined) {
        ahc.enabled = Boolean(input.activeHealthCheck.enabled);
      }
      if (input.activeHealthCheck.uri !== undefined) {
        const val = normalizeMetaValue(input.activeHealthCheck.uri ?? null);
        if (val) {
          ahc.uri = val;
        } else {
          delete ahc.uri;
        }
      }
      if (input.activeHealthCheck.port !== undefined) {
        if (
          typeof input.activeHealthCheck.port === "number" &&
          Number.isFinite(input.activeHealthCheck.port) &&
          input.activeHealthCheck.port > 0
        ) {
          ahc.port = input.activeHealthCheck.port;
        } else {
          delete ahc.port;
        }
      }
      if (input.activeHealthCheck.interval !== undefined) {
        const val = normalizeMetaValue(input.activeHealthCheck.interval ?? null);
        if (val) {
          ahc.interval = val;
        } else {
          delete ahc.interval;
        }
      }
      if (input.activeHealthCheck.timeout !== undefined) {
        const val = normalizeMetaValue(input.activeHealthCheck.timeout ?? null);
        if (val) {
          ahc.timeout = val;
        } else {
          delete ahc.timeout;
        }
      }
      if (input.activeHealthCheck.status !== undefined) {
        if (
          typeof input.activeHealthCheck.status === "number" &&
          Number.isFinite(input.activeHealthCheck.status) &&
          input.activeHealthCheck.status >= 100
        ) {
          ahc.status = input.activeHealthCheck.status;
        } else {
          delete ahc.status;
        }
      }
      if (input.activeHealthCheck.body !== undefined) {
        const val = normalizeMetaValue(input.activeHealthCheck.body ?? null);
        if (val) {
          ahc.body = val;
        } else {
          delete ahc.body;
        }
      }

      for (const key of ["passes", "fails"] as const) {
        const value = input.activeHealthCheck[key];
        if (value !== undefined) {
          if (typeof value === "number" && Number.isInteger(value)) ahc[key] = value;
          else delete ahc[key];
        }
      }
      if (input.activeHealthCheck.method !== undefined) {
        const val = normalizeMetaValue(input.activeHealthCheck.method ?? null);
        if (val) ahc.method = val;
        else delete ahc.method;
      }
      if (input.activeHealthCheck.requestBody !== undefined) {
        const val = normalizeMetaValue(input.activeHealthCheck.requestBody ?? null);
        if (val) ahc.request_body = val;
        else delete ahc.request_body;
      }
      if (input.activeHealthCheck.followRedirects !== undefined) {
        ahc.follow_redirects = Boolean(input.activeHealthCheck.followRedirects);
      }
      if (input.activeHealthCheck.headers !== undefined) {
        if (input.activeHealthCheck.headers) ahc.headers = input.activeHealthCheck.headers;
        else delete ahc.headers;
      }

      if (Object.keys(ahc).length > 0) {
        next.active_health_check = ahc;
      } else {
        delete next.active_health_check;
      }
    }
  }

  if (input.passiveHealthCheck !== undefined) {
    if (input.passiveHealthCheck === null) {
      delete next.passive_health_check;
    } else {
      const phc: LoadBalancerPassiveHealthCheckMeta = { ...(existing?.passive_health_check ?? {}) };

      if (input.passiveHealthCheck.enabled !== undefined) {
        phc.enabled = Boolean(input.passiveHealthCheck.enabled);
      }
      if (input.passiveHealthCheck.failDuration !== undefined) {
        const val = normalizeMetaValue(input.passiveHealthCheck.failDuration ?? null);
        if (val) {
          phc.fail_duration = val;
        } else {
          delete phc.fail_duration;
        }
      }
      if (input.passiveHealthCheck.maxFails !== undefined) {
        if (
          typeof input.passiveHealthCheck.maxFails === "number" &&
          Number.isFinite(input.passiveHealthCheck.maxFails) &&
          input.passiveHealthCheck.maxFails >= 0
        ) {
          phc.max_fails = input.passiveHealthCheck.maxFails;
        } else {
          delete phc.max_fails;
        }
      }
      if (input.passiveHealthCheck.unhealthyStatus !== undefined) {
        if (Array.isArray(input.passiveHealthCheck.unhealthyStatus)) {
          const statuses = input.passiveHealthCheck.unhealthyStatus.filter(
            (s): s is number => typeof s === "number" && Number.isFinite(s) && s >= 100,
          );
          if (statuses.length > 0) {
            phc.unhealthy_status = statuses;
          } else {
            delete phc.unhealthy_status;
          }
        } else {
          delete phc.unhealthy_status;
        }
      }
      if (input.passiveHealthCheck.unhealthyLatency !== undefined) {
        const val = normalizeMetaValue(input.passiveHealthCheck.unhealthyLatency ?? null);
        if (val) {
          phc.unhealthy_latency = val;
        } else {
          delete phc.unhealthy_latency;
        }
      }

      if (input.passiveHealthCheck.unhealthyRequestCount !== undefined) {
        const value = input.passiveHealthCheck.unhealthyRequestCount;
        if (typeof value === "number" && Number.isInteger(value)) {
          phc.unhealthy_request_count = value;
        } else {
          delete phc.unhealthy_request_count;
        }
      }

      if (Object.keys(phc).length > 0) {
        next.passive_health_check = phc;
      } else {
        delete next.passive_health_check;
      }
    }
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeDnsResolverInput(
  input: DnsResolverInput | null | undefined,
  existing: DnsResolverMeta | undefined,
): DnsResolverMeta | undefined {
  if (input === undefined) {
    return existing;
  }
  if (input === null) {
    return undefined;
  }

  const next: DnsResolverMeta = { ...(existing ?? {}) };

  if (input.enabled !== undefined) {
    next.enabled = Boolean(input.enabled);
  }

  if (input.resolvers !== undefined) {
    if (Array.isArray(input.resolvers)) {
      const resolvers = input.resolvers
        .map((r) => (typeof r === "string" ? r.trim() : ""))
        .filter((r) => r.length > 0);
      if (resolvers.length > 0) {
        next.resolvers = resolvers;
      } else {
        delete next.resolvers;
      }
    } else {
      delete next.resolvers;
    }
  }

  if (input.fallbacks !== undefined) {
    if (Array.isArray(input.fallbacks)) {
      const fallbacks = input.fallbacks
        .map((r) => (typeof r === "string" ? r.trim() : ""))
        .filter((r) => r.length > 0);
      if (fallbacks.length > 0) {
        next.fallbacks = fallbacks;
      } else {
        delete next.fallbacks;
      }
    } else {
      delete next.fallbacks;
    }
  }

  if (input.timeout !== undefined) {
    const val = normalizeMetaValue(input.timeout ?? null);
    if (val && !isCaddyDuration(val)) {
      throw domainError("hostDnsResolverTimeoutInvalid", { value: val }, { status: 400 });
    }
    if (val) {
      next.timeout = val;
    } else {
      delete next.timeout;
    }
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeUpstreamDnsResolutionInput(
  input: UpstreamDnsResolutionInput | null | undefined,
  existing: UpstreamDnsResolutionMeta | undefined,
): UpstreamDnsResolutionMeta | undefined {
  if (input === undefined) {
    return existing;
  }
  if (input === null) {
    return undefined;
  }

  const next: UpstreamDnsResolutionMeta = { ...(existing ?? {}) };

  if (input.enabled !== undefined) {
    if (input.enabled === null) {
      delete next.enabled;
    } else {
      next.enabled = Boolean(input.enabled);
    }
  }

  if (input.family !== undefined) {
    if (input.family && VALID_UPSTREAM_DNS_FAMILIES.includes(input.family)) {
      next.family = input.family;
    } else {
      delete next.family;
    }
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * The builder drops raw JSON it cannot use, so a typo would quietly remove the handlers it replaced.
 * A stored value resubmitted unchanged passes, so an older host can still be saved.
 */
function assertRawJsonUsable(
  value: string | null,
  stored: string | undefined,
  kind: "preHandlers" | "reverseProxy",
): void {
  if (!value || value === stored) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  const usable =
    kind === "reverseProxy"
      ? isPlainObject(parsed)
      : isPlainObject(parsed) || (Array.isArray(parsed) && parsed.every(isPlainObject));
  if (!usable) {
    throw domainError(
      kind === "reverseProxy" ? "customReverseProxyJsonInvalid" : "customPreHandlersJsonInvalid",
      {},
      { status: 400 },
    );
  }
}

function buildMeta(
  existing: ProxyHostMeta,
  input: Partial<ProxyHostInput>,
  globalWaf: WafSettings | null = null,
): string | null {
  const next: ProxyHostMeta = { ...existing };

  if (input.customReverseProxyJson !== undefined) {
    const reverse = normalizeMetaValue(input.customReverseProxyJson ?? null);
    assertRawJsonUsable(reverse, existing.custom_reverse_proxy_json, "reverseProxy");
    if (reverse) {
      next.custom_reverse_proxy_json = reverse;
    } else {
      delete next.custom_reverse_proxy_json;
    }
  }

  if (input.customPreHandlersJson !== undefined) {
    const pre = normalizeMetaValue(input.customPreHandlersJson ?? null);
    assertRawJsonUsable(pre, existing.custom_pre_handlers_json, "preHandlers");
    if (pre) {
      next.custom_pre_handlers_json = pre;
    } else {
      delete next.custom_pre_handlers_json;
    }
  }

  if (input.customCaddyfile !== undefined) {
    const caddyfile = normalizeMetaValue(input.customCaddyfile ?? null);
    if (caddyfile) {
      next.custom_caddyfile = caddyfile;
    } else {
      delete next.custom_caddyfile;
    }
  }

  if (input.authentik !== undefined) {
    const authentik = normalizeAuthentikInput(input.authentik, existing.authentik);
    if (authentik) {
      next.authentik = authentik;
    } else {
      delete next.authentik;
    }
  }

  if (input.loadBalancer !== undefined) {
    const loadBalancer = normalizeLoadBalancerInput(input.loadBalancer, existing.load_balancer);
    if (loadBalancer) {
      next.load_balancer = loadBalancer;
    } else {
      delete next.load_balancer;
    }
  }

  if (input.dnsResolver !== undefined) {
    const dnsResolver = normalizeDnsResolverInput(input.dnsResolver, existing.dns_resolver);
    if (dnsResolver) {
      next.dns_resolver = dnsResolver;
    } else {
      delete next.dns_resolver;
    }
  }

  if (input.upstreamDnsResolution !== undefined) {
    const upstreamDnsResolution = normalizeUpstreamDnsResolutionInput(
      input.upstreamDnsResolution,
      existing.upstream_dns_resolution,
    );
    if (upstreamDnsResolution) {
      next.upstream_dns_resolution = upstreamDnsResolution;
    } else {
      delete next.upstream_dns_resolution;
    }
  }

  if (input.geoblock !== undefined) {
    if (input.geoblock) validateGeoBlockMeta(input.geoblock);
    const geoblockMeta = dehydrateGeoBlock(input.geoblock ?? null);
    if (geoblockMeta) {
      next.geoblock = geoblockMeta;
    } else {
      delete next.geoblock;
      delete next.geoblock_mode;
    }
  }

  if (input.geoblockMode !== undefined) {
    next.geoblock_mode = input.geoblockMode;
  }

  if (input.waf !== undefined) {
    if (input.waf) {
      next.waf = validateWafMeta(input.waf, existing.waf, globalWaf);
    } else {
      delete next.waf;
    }
  }

  if (input.mtls !== undefined) {
    if (input.mtls?.enabled) {
      const mtls = sanitizeMtlsMeta(input.mtls);
      if (mtls) {
        next.mtls = mtls;
      }
    } else {
      delete next.mtls;
    }
  }

  if (input.cpmForwardAuth !== undefined) {
    if (input.cpmForwardAuth?.enabled) {
      const cfa: CpmForwardAuthMeta = { enabled: true };
      if (input.cpmForwardAuth.protected_paths && input.cpmForwardAuth.protected_paths.length > 0) {
        cfa.protected_paths = input.cpmForwardAuth.protected_paths;
      }
      if (input.cpmForwardAuth.excluded_paths && input.cpmForwardAuth.excluded_paths.length > 0) {
        cfa.excluded_paths = input.cpmForwardAuth.excluded_paths;
      }
      // Left out of an update, the host keeps what it had.
      const requireCaptcha =
        input.cpmForwardAuth.require_captcha ?? next.cpm_forward_auth?.require_captcha;
      if (requireCaptcha === false) {
        cfa.require_captcha = false;
      }
      next.cpm_forward_auth = cfa;
    } else {
      delete next.cpm_forward_auth;
    }
  }

  if (input.forwardAuth !== undefined) {
    const forwardAuth = normalizeForwardAuthInput(input.forwardAuth, existing.forward_auth);
    if (forwardAuth) {
      next.forward_auth = forwardAuth;
    } else {
      delete next.forward_auth;
    }
  }

  assertSingleForwardAuthProvider(next, input);

  if (input.tailscale !== undefined) {
    const tailscale = normalizeTailscaleInput(input.tailscale, existing.tailscale);
    if (tailscale) {
      next.tailscale = tailscale;
    } else {
      delete next.tailscale;
    }
  }

  if (input.redirects !== undefined) {
    const rules = sanitizeRedirectRules(input.redirects ?? []);
    if (rules.length > 0) {
      next.redirects = rules;
    } else {
      delete next.redirects;
    }
  }

  if (input.rewrite !== undefined) {
    const rw = sanitizeRewriteConfig(input.rewrite);
    if (rw) {
      next.rewrite = rw;
    } else {
      delete next.rewrite;
    }
  }

  if (input.locationRules !== undefined) {
    const rules = normalizeLocationRulesInput(input.locationRules ?? []);
    if (rules.length > 0) {
      next.location_rules = rules;
    } else {
      delete next.location_rules;
    }
  }

  if (input.pathAllows !== undefined) {
    const rules = sanitizePathAllows(input.pathAllows ?? []);
    if (rules.length > 0) {
      next.path_allows = rules;
    } else {
      delete next.path_allows;
    }
  }

  if (input.pathBlocks !== undefined) {
    const rules = sanitizePathBlocks(input.pathBlocks ?? []);
    if (rules.length > 0) {
      next.path_blocks = rules;
    } else {
      delete next.path_blocks;
    }
  }

  if (input.pathRewrites !== undefined) {
    const rules = sanitizePathRewrites(input.pathRewrites ?? []);
    if (rules.length > 0) {
      next.path_rewrites = rules;
    } else {
      delete next.path_rewrites;
    }
  }

  if (input.errorPages !== undefined) {
    const rules = sanitizeErrorPageRules(input.errorPages ?? []);
    if (rules.length > 0) {
      next.error_pages = rules;
    } else {
      delete next.error_pages;
    }
  }

  if (input.cache !== undefined) {
    const cache = sanitizeHostCache(input.cache);
    if (cache) next.cache = cache;
    else delete next.cache;
  }

  if (input.compression !== undefined) {
    const compression = storedCompression(input.compression);
    if (compression) next.compression = compression;
    else delete next.compression;
  }

  if (input.discourageIndexing !== undefined) {
    if (input.discourageIndexing) next.discourage_indexing = true;
    else delete next.discourage_indexing;
  }

  if (input.skipAccessLog !== undefined) {
    if (input.skipAccessLog) next.skip_access_log = true;
    else delete next.skip_access_log;
  }

  if (input.maintenance !== undefined) {
    const maintenance = input.maintenance
      ? normalizeHostMaintenanceInput(input.maintenance)
      : undefined;
    if (maintenance) next.maintenance = maintenance;
    else delete next.maintenance;
  }

  if (input.upstreamTimeouts !== undefined) {
    const timeouts = input.upstreamTimeouts
      ? normalizeHostUpstreamTimeoutsInput(input.upstreamTimeouts)
      : undefined;
    if (timeouts) next.upstream_timeouts = timeouts;
    else delete next.upstream_timeouts;
  }

  if (input.rateLimit !== undefined) {
    const rateLimit = input.rateLimit ? normalizeHostRateLimitInput(input.rateLimit) : undefined;
    if (rateLimit) next.rate_limit = rateLimit;
    else delete next.rate_limit;
  }

  if (input.crowdsec !== undefined) {
    const crowdsec = storedHostCrowdSec(input.crowdsec !== false);
    if (crowdsec) next.crowdsec = crowdsec;
    else delete next.crowdsec;
  }

  if (input.anubis !== undefined) {
    const anubis = input.anubis ? normalizeHostAnubisInput(input.anubis) : undefined;
    if (anubis) next.anubis = anubis;
    else delete next.anubis;
  }

  return serializeMeta(next);
}

function hydrateAuthentik(
  meta: ProxyHostAuthentikMeta | undefined,
): ProxyHostAuthentikConfig | null {
  if (!meta) {
    return null;
  }

  const enabled = Boolean(meta.enabled);
  const outpostDomain = normalizeMetaValue(meta.outpost_domain ?? null);
  const outpostUpstream = normalizeMetaValue(meta.outpost_upstream ?? null);
  const authEndpoint =
    normalizeMetaValue(meta.auth_endpoint ?? null) ??
    (outpostDomain ? `/${outpostDomain}/auth/caddy` : null);
  const copyHeaders =
    Array.isArray(meta.copy_headers) && meta.copy_headers.length > 0
      ? meta.copy_headers
      : DEFAULT_AUTHENTIK_HEADERS;
  const trustedProxies =
    Array.isArray(meta.trusted_proxies) && meta.trusted_proxies.length > 0
      ? meta.trusted_proxies
      : DEFAULT_AUTHENTIK_TRUSTED_PROXIES;
  const setOutpostHostHeader =
    meta.set_outpost_host_header !== undefined ? Boolean(meta.set_outpost_host_header) : true;
  const protectedPaths =
    Array.isArray(meta.protected_paths) && meta.protected_paths.length > 0
      ? meta.protected_paths
      : null;
  const excludedPaths =
    Array.isArray(meta.excluded_paths) && meta.excluded_paths.length > 0
      ? meta.excluded_paths
      : null;

  return {
    enabled,
    outpostDomain,
    outpostUpstream,
    authEndpoint,
    copyHeaders,
    trustedProxies,
    setOutpostHostHeader,
    protectedPaths,
    excludedPaths,
  };
}

function dehydrateAuthentik(
  config: ProxyHostAuthentikConfig | null,
): ProxyHostAuthentikMeta | undefined {
  if (!config) {
    return undefined;
  }

  const meta: ProxyHostAuthentikMeta = {
    enabled: config.enabled,
  };

  if (config.outpostDomain) {
    meta.outpost_domain = config.outpostDomain;
  }
  if (config.outpostUpstream) {
    meta.outpost_upstream = config.outpostUpstream;
  }
  if (config.authEndpoint) {
    meta.auth_endpoint = config.authEndpoint;
  }
  if (config.copyHeaders.length > 0) {
    meta.copy_headers = [...config.copyHeaders];
  }
  if (config.trustedProxies.length > 0) {
    meta.trusted_proxies = [...config.trustedProxies];
  }
  meta.set_outpost_host_header = config.setOutpostHostHeader;
  if (config.protectedPaths && config.protectedPaths.length > 0) {
    meta.protected_paths = [...config.protectedPaths];
  }
  if (config.excludedPaths && config.excludedPaths.length > 0) {
    meta.excluded_paths = [...config.excludedPaths];
  }

  return meta;
}

/** A stored count, or null. The sanitizer already bounded these; this only re-reads them. */
function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function hydrateLoadBalancer(meta: LoadBalancerMeta | undefined): LoadBalancerConfig | null {
  if (!meta) {
    return null;
  }

  const enabled = Boolean(meta.enabled);
  const policy: LoadBalancingPolicy =
    meta.policy && VALID_LB_POLICIES.includes(meta.policy as LoadBalancingPolicy)
      ? (meta.policy as LoadBalancingPolicy)
      : "random";

  const policyHeaderField = normalizeMetaValue(meta.policy_header_field ?? null);
  const policyCookieName = normalizeMetaValue(meta.policy_cookie_name ?? null);
  const policyCookieSecret = normalizeMetaValue(meta.policy_cookie_secret ?? null);
  const tryDuration = normalizeMetaValue(meta.try_duration ?? null);
  const tryInterval = normalizeMetaValue(meta.try_interval ?? null);
  const retries =
    typeof meta.retries === "number" && Number.isFinite(meta.retries) && meta.retries >= 0
      ? meta.retries
      : null;

  let activeHealthCheck: LoadBalancerActiveHealthCheck | null = null;
  if (meta.active_health_check) {
    activeHealthCheck = {
      enabled: Boolean(meta.active_health_check.enabled),
      uri: normalizeMetaValue(meta.active_health_check.uri ?? null),
      port:
        typeof meta.active_health_check.port === "number" &&
        Number.isFinite(meta.active_health_check.port) &&
        meta.active_health_check.port > 0
          ? meta.active_health_check.port
          : null,
      interval: normalizeMetaValue(meta.active_health_check.interval ?? null),
      timeout: normalizeMetaValue(meta.active_health_check.timeout ?? null),
      status:
        typeof meta.active_health_check.status === "number" &&
        Number.isFinite(meta.active_health_check.status) &&
        meta.active_health_check.status >= 100
          ? meta.active_health_check.status
          : null,
      body: normalizeMetaValue(meta.active_health_check.body ?? null),
      passes: positiveInt(meta.active_health_check.passes),
      fails: positiveInt(meta.active_health_check.fails),
      method: normalizeMetaValue(meta.active_health_check.method ?? null),
      requestBody: normalizeMetaValue(meta.active_health_check.request_body ?? null),
      followRedirects: Boolean(meta.active_health_check.follow_redirects),
      headers:
        meta.active_health_check.headers && Object.keys(meta.active_health_check.headers).length > 0
          ? meta.active_health_check.headers
          : null,
    };
  }

  let passiveHealthCheck: LoadBalancerPassiveHealthCheck | null = null;
  if (meta.passive_health_check) {
    const unhealthyStatus = Array.isArray(meta.passive_health_check.unhealthy_status)
      ? meta.passive_health_check.unhealthy_status.filter(
          (s): s is number => typeof s === "number" && Number.isFinite(s) && s >= 100,
        )
      : null;

    passiveHealthCheck = {
      enabled: Boolean(meta.passive_health_check.enabled),
      failDuration: normalizeMetaValue(meta.passive_health_check.fail_duration ?? null),
      maxFails:
        typeof meta.passive_health_check.max_fails === "number" &&
        Number.isFinite(meta.passive_health_check.max_fails) &&
        meta.passive_health_check.max_fails >= 0
          ? meta.passive_health_check.max_fails
          : null,
      unhealthyStatus: unhealthyStatus && unhealthyStatus.length > 0 ? unhealthyStatus : null,
      unhealthyLatency: normalizeMetaValue(meta.passive_health_check.unhealthy_latency ?? null),
      unhealthyRequestCount: positiveInt(meta.passive_health_check.unhealthy_request_count),
    };
  }

  return {
    enabled,
    policy,
    policyHeaderField,
    policyCookieName,
    policyCookieSecret,
    policyQueryKey: normalizeMetaValue(meta.policy_query_key ?? null),
    policyChoose: positiveInt(meta.policy_choose),
    policyWeights:
      Array.isArray(meta.policy_weights) && meta.policy_weights.length > 0
        ? meta.policy_weights
        : null,
    tryDuration,
    tryInterval,
    retries,
    activeHealthCheck,
    passiveHealthCheck,
  };
}

function dehydrateLoadBalancer(config: LoadBalancerConfig | null): LoadBalancerMeta | undefined {
  if (!config) {
    return undefined;
  }

  const meta: LoadBalancerMeta = {
    enabled: config.enabled,
  };

  if (config.policy) {
    meta.policy = config.policy;
  }
  if (config.policyHeaderField) {
    meta.policy_header_field = config.policyHeaderField;
  }
  if (config.policyCookieName) {
    meta.policy_cookie_name = config.policyCookieName;
  }
  if (config.policyCookieSecret) {
    meta.policy_cookie_secret = config.policyCookieSecret;
  }
  if (config.tryDuration) {
    meta.try_duration = config.tryDuration;
  }
  if (config.tryInterval) {
    meta.try_interval = config.tryInterval;
  }
  if (config.retries !== null) {
    meta.retries = config.retries;
  }

  if (config.activeHealthCheck) {
    const ahc: LoadBalancerActiveHealthCheckMeta = {
      enabled: config.activeHealthCheck.enabled,
    };
    if (config.activeHealthCheck.uri) {
      ahc.uri = config.activeHealthCheck.uri;
    }
    if (config.activeHealthCheck.port !== null) {
      ahc.port = config.activeHealthCheck.port;
    }
    if (config.activeHealthCheck.interval) {
      ahc.interval = config.activeHealthCheck.interval;
    }
    if (config.activeHealthCheck.timeout) {
      ahc.timeout = config.activeHealthCheck.timeout;
    }
    if (config.activeHealthCheck.status !== null) {
      ahc.status = config.activeHealthCheck.status;
    }
    if (config.activeHealthCheck.body) {
      ahc.body = config.activeHealthCheck.body;
    }
    meta.active_health_check = ahc;
  }

  if (config.passiveHealthCheck) {
    const phc: LoadBalancerPassiveHealthCheckMeta = {
      enabled: config.passiveHealthCheck.enabled,
    };
    if (config.passiveHealthCheck.failDuration) {
      phc.fail_duration = config.passiveHealthCheck.failDuration;
    }
    if (config.passiveHealthCheck.maxFails !== null) {
      phc.max_fails = config.passiveHealthCheck.maxFails;
    }
    if (
      config.passiveHealthCheck.unhealthyStatus &&
      config.passiveHealthCheck.unhealthyStatus.length > 0
    ) {
      phc.unhealthy_status = [...config.passiveHealthCheck.unhealthyStatus];
    }
    if (config.passiveHealthCheck.unhealthyLatency) {
      phc.unhealthy_latency = config.passiveHealthCheck.unhealthyLatency;
    }
    meta.passive_health_check = phc;
  }

  return meta;
}

function hydrateDnsResolver(meta: DnsResolverMeta | undefined): DnsResolverConfig | null {
  if (!meta) {
    return null;
  }

  const enabled = Boolean(meta.enabled);

  const resolvers = Array.isArray(meta.resolvers)
    ? meta.resolvers.map((r) => (typeof r === "string" ? r.trim() : "")).filter((r) => r.length > 0)
    : [];

  const fallbacks = Array.isArray(meta.fallbacks)
    ? meta.fallbacks.map((r) => (typeof r === "string" ? r.trim() : "")).filter((r) => r.length > 0)
    : null;

  const timeout = normalizeMetaValue(meta.timeout ?? null);

  return {
    enabled,
    resolvers,
    fallbacks: fallbacks && fallbacks.length > 0 ? fallbacks : null,
    timeout,
  };
}

function dehydrateDnsResolver(config: DnsResolverConfig | null): DnsResolverMeta | undefined {
  if (!config) {
    return undefined;
  }

  const meta: DnsResolverMeta = {
    enabled: config.enabled,
  };

  if (config.resolvers && config.resolvers.length > 0) {
    meta.resolvers = [...config.resolvers];
  }
  if (config.fallbacks && config.fallbacks.length > 0) {
    meta.fallbacks = [...config.fallbacks];
  }
  if (config.timeout) {
    meta.timeout = config.timeout;
  }

  return meta;
}

function hydrateUpstreamDnsResolution(
  meta: UpstreamDnsResolutionMeta | undefined,
): UpstreamDnsResolutionConfig | null {
  if (!meta) {
    return null;
  }

  const enabled = meta.enabled === undefined ? null : Boolean(meta.enabled);
  const family =
    meta.family && VALID_UPSTREAM_DNS_FAMILIES.includes(meta.family) ? meta.family : null;

  return {
    enabled,
    family,
  };
}

function dehydrateUpstreamDnsResolution(
  config: UpstreamDnsResolutionConfig | null,
): UpstreamDnsResolutionMeta | undefined {
  if (!config) {
    return undefined;
  }

  const meta: UpstreamDnsResolutionMeta = {};
  if (config.enabled !== null) {
    meta.enabled = Boolean(config.enabled);
  }
  if (config.family && VALID_UPSTREAM_DNS_FAMILIES.includes(config.family)) {
    meta.family = config.family;
  }

  return Object.keys(meta).length > 0 ? meta : undefined;
}

function hydrateGeoBlock(meta: GeoBlockSettings | undefined): GeoBlockSettings | null {
  return meta ?? null;
}

/** The global validator's rules; the host form never sends a bad value, the API can. */
function validateGeoBlockMeta(geoblock: GeoBlockSettings): void {
  try {
    validateHostGeoBlock(geoblock);
  } catch (error) {
    if (!(error instanceof SettingsValidationError)) throw error;
    throw domainError("hostGeoBlockInvalid", { detail: error.message }, { status: 400 });
  }
}

function dehydrateGeoBlock(geoblock: GeoBlockSettings | null): GeoBlockSettings | undefined {
  if (!geoblock) return undefined;
  return geoblock;
}

/** The part of a `ProxyHost` that lives in the `meta` blob rather than in its own column. */
export type ProxyHostMetaView = Pick<
  ProxyHost,
  | "customReverseProxyJson"
  | "customPreHandlersJson"
  | "customCaddyfile"
  | "authentik"
  | "loadBalancer"
  | "dnsResolver"
  | "upstreamDnsResolution"
  | "geoblock"
  | "geoblockMode"
  | "waf"
  | "mtls"
  | "forwardAuth"
  | "cpmForwardAuth"
  | "tailscale"
  | "redirects"
  | "rewrite"
  | "locationRules"
  | "pathAllows"
  | "pathBlocks"
  | "pathRewrites"
  | "errorPages"
  | "cache"
  | "compression"
  | "discourageIndexing"
  | "skipAccessLog"
  | "maintenance"
  | "upstreamTimeouts"
  | "rateLimit"
  | "crowdsec"
  | "anubis"
>;

/**
 * A stored `meta` blob, hydrated as the host form reads it. Exported for the dashboard host, which
 * carries the same blob in its settings.
 */
export function proxyHostMetaView(value: string | null): ProxyHostMetaView {
  const meta = parseMeta(value);
  return {
    customReverseProxyJson: meta.custom_reverse_proxy_json ?? null,
    customPreHandlersJson: meta.custom_pre_handlers_json ?? null,
    customCaddyfile: meta.custom_caddyfile ?? null,
    authentik: hydrateAuthentik(meta.authentik),
    loadBalancer: hydrateLoadBalancer(meta.load_balancer),
    dnsResolver: hydrateDnsResolver(meta.dns_resolver),
    upstreamDnsResolution: hydrateUpstreamDnsResolution(meta.upstream_dns_resolution),
    geoblock: hydrateGeoBlock(meta.geoblock),
    geoblockMode: meta.geoblock_mode ?? "merge",
    // Absent is merge, and the editor always sends one: filled here so the two read alike.
    waf: meta.waf ? { ...meta.waf, waf_mode: meta.waf.waf_mode ?? "merge" } : null,
    mtls: meta.mtls ?? null,
    forwardAuth: hydrateForwardAuth(meta.forward_auth),
    cpmForwardAuth: meta.cpm_forward_auth?.enabled
      ? {
          enabled: true,
          protected_paths: meta.cpm_forward_auth.protected_paths ?? null,
          excluded_paths: meta.cpm_forward_auth.excluded_paths ?? null,
          require_captcha: meta.cpm_forward_auth.require_captcha !== false,
        }
      : null,
    tailscale: hydrateTailscale(meta.tailscale),
    redirects: meta.redirects ?? [],
    rewrite: meta.rewrite ?? null,
    locationRules: hydrateLocationRules(meta.location_rules),
    pathAllows: meta.path_allows ?? [],
    pathBlocks: meta.path_blocks ?? [],
    pathRewrites: meta.path_rewrites ?? [],
    errorPages: meta.error_pages ?? [],
    cache: hydrateHostCache(meta.cache),
    compression: sanitizeHostCompression(meta.compression),
    discourageIndexing: meta.discourage_indexing === true,
    skipAccessLog: meta.skip_access_log === true,
    maintenance: hydrateHostMaintenance(meta.maintenance),
    upstreamTimeouts: hydrateHostUpstreamTimeouts(meta.upstream_timeouts),
    rateLimit: hydrateHostRateLimit(meta.rate_limit),
    crowdsec: hostCrowdSecEnabled(sanitizeHostCrowdSec(meta.crowdsec)),
    anubis: hydrateHostAnubis(meta.anubis),
  };
}

function jsonStringList(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * A host's stored columns from somewhere other than the form (a config import), checked as a save
 * checks them: names and upstreams normalised, and the meta put through the editor's checks (the
 * WAF lint, raw JSON, one forward-auth provider) before the read sanitizers decide what is kept.
 * Throws the save's domain errors.
 */
export function normalizeImportedProxyHost(
  row: { domains: unknown; upstreams: unknown; meta: unknown },
  globalWaf: WafSettings | null,
): { domains: string; upstreams: string; meta: string | null } {
  const domains = jsonStringList(row.domains);
  if (!domains) throw domainError("proxyHostDomainsRequired", {}, { status: 400 });
  const upstreams = jsonStringList(row.upstreams)?.map((upstream) => upstream.trim());
  if (!upstreams || upstreams.filter(Boolean).length === 0) {
    throw domainError("upstreamsRequired", {}, { status: 400 });
  }
  upstreams.forEach(validateUpstreamProtocol);
  let meta: string | null = null;
  if (row.meta !== null && row.meta !== undefined && row.meta !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(row.meta));
    } catch {
      parsed = undefined;
    }
    if (!isPlainObject(parsed)) throw domainError("proxyHostMetaInvalid", {}, { status: 400 });
    buildMeta({}, proxyHostMetaView(String(row.meta)) as Partial<ProxyHostInput>, globalWaf);
    meta = serializeMeta(parseMeta(String(row.meta)));
  }
  return {
    domains: JSON.stringify(normalizeProxyHostDomains(domains)),
    upstreams: JSON.stringify(Array.from(new Set(upstreams.filter(Boolean)))),
    meta,
  };
}

/**
 * Apply a host form's meta fields to a stored blob: `undefined` leaves a field alone, `null` or
 * empty clears it. The same merge `updateProxyHost` does, for a blob that is not in `proxy_hosts`.
 */
export function mergeProxyHostMeta(
  existing: string | null,
  input: Partial<ProxyHostInput>,
  globalWaf: WafSettings | null = null,
): string | null {
  return buildMeta(parseMeta(existing), input, globalWaf);
}

/**
 * The checks `createProxyHost` and `updateProxyHost` make before storing a host's options, for a
 * caller storing them somewhere else. Throws the same domain errors.
 */
export async function assertProxyHostOptionsStorable(options: {
  domains: string[];
  certificateId: number | null;
  agentIds: readonly number[];
  meta: string | null;
  customCaddyfileChanged: boolean;
  /** The WAF block as stored before, so an unchanged one skips the dry run. */
  previousMeta?: string | null;
  target?: WafDryRunTarget;
}): Promise<void> {
  await assertWildcardIssuable(options.domains, options.certificateId);
  await assertCertificateServable(options.certificateId, options.agentIds);
  if (options.customCaddyfileChanged) {
    await assertCaddyfileAdapts(parseMeta(options.meta).custom_caddyfile, options.agentIds);
  }
  await assertTailscaleServable(options.meta);
  await assertWafPresetIdsExist(parseMeta(options.meta).waf?.preset_ids);
  await assertCrsPluginIdsExist(parseMeta(options.meta).waf?.plugin_ids);
  if (options.target) {
    await assertHostWafLoads(
      options.target,
      parseMeta(options.previousMeta ?? null).waf,
      parseMeta(options.meta).waf,
    );
  }
}

/**
 * Has Caddy compile the host's WAF as it will be emitted, when the save changes it. After the
 * id checks, so a missing preset is reported as that rather than as whatever Coraza makes of it.
 */
async function assertHostWafLoads(
  target: WafDryRunTarget,
  before: WafHostConfig | undefined,
  after: WafHostConfig | undefined,
): Promise<void> {
  if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) return;
  await assertWafLoads(await wafCandidatesForHost(target, after));
}

function parseProxyHost(row: ProxyHostRow): ProxyHost {
  return {
    id: row.id,
    // Nullable only for a row inserted by raw SQL; the migration and the column default fill the rest.
    uuid: row.uuid ?? "",
    name: row.name,
    description: row.description ?? null,
    tags: parseStoredTags(row.tags),
    domains: JSON.parse(row.domains),
    upstreams: JSON.parse(row.upstreams),
    certificateId: row.certificateId ?? null,
    accessListId: row.accessListId ?? null,
    sslForced: row.sslForced,
    hstsEnabled: row.hstsEnabled,
    hstsSubdomains: row.hstsSubdomains,
    allowWebsocket: row.allowWebsocket,
    preserveHostHeader: row.preserveHostHeader,
    skipHttpsHostnameValidation: row.skipHttpsHostnameValidation,
    enabled: row.enabled,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
    ...proxyHostMetaView(row.meta ?? null),
  };
}

export async function listProxyHosts(): Promise<ProxyHost[]> {
  const hosts = await db.select().from(proxyHosts).orderBy(desc(proxyHosts.createdAt));
  return hosts.map(parseProxyHost);
}

/**
 * `visibleIds` null means unrestricted (admin). An empty array means the viewer sees nothing and
 * must not be dropped, or the query would list the whole fleet.
 */
function proxyHostListFilter(
  search?: string,
  visibleIds?: number[] | null,
  enabled?: boolean,
  tag?: string,
) {
  const clauses = [];
  if (enabled !== undefined) {
    clauses.push(eq(proxyHosts.enabled, enabled));
  }
  if (tag) {
    clauses.push(hasTagClause(proxyHosts.tags, tag));
  }
  if (search) {
    clauses.push(
      or(
        like(proxyHosts.name, `%${search}%`),
        like(proxyHosts.description, `%${search}%`),
        like(proxyHosts.tags, `%${search}%`),
        like(proxyHosts.domains, `%${search}%`),
        like(proxyHosts.upstreams, `%${search}%`),
      ),
    );
  }
  if (visibleIds != null) {
    clauses.push(visibleIds.length > 0 ? inArray(proxyHosts.id, visibleIds) : sql`false`);
  }
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : and(...clauses);
}

export async function countProxyHosts(
  search?: string,
  visibleIds?: number[] | null,
  enabled?: boolean,
  tag?: string,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(proxyHosts)
    .where(proxyHostListFilter(search, visibleIds, enabled, tag));
  return row?.value ?? 0;
}

export type ProxyHostCounts = { total: number; enabled: number; disabled: number };

/**
 * Counts across everything the viewer can see, not the page: paging must not change the header's
 * numbers but the search must, hence the list's own filter.
 */
export async function countProxyHostsByState(
  search?: string,
  visibleIds?: number[] | null,
  tag?: string,
): Promise<ProxyHostCounts> {
  const [row] = await db
    .select({
      total: count(),
      enabled: sql<number>`sum(case when ${proxyHosts.enabled} then 1 else 0 end)`.mapWith(Number),
    })
    .from(proxyHosts)
    .where(proxyHostListFilter(search, visibleIds, undefined, tag));
  const total = row?.total ?? 0;
  const enabled = row?.enabled ?? 0;
  return { total, enabled, disabled: total - enabled };
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous drizzle columns have no useful union
const PROXY_HOST_SORT_COLUMNS: Record<string, any> = {
  name: proxyHosts.name,
  domains: proxyHosts.domains,
  upstreams: proxyHosts.upstreams,
  enabled: proxyHosts.enabled,
  createdAt: proxyHosts.createdAt,
};

export async function listProxyHostsPaginated(
  limit: number,
  offset: number,
  search?: string,
  sortBy?: string,
  sortDir?: "asc" | "desc",
  visibleIds?: number[] | null,
  enabled?: boolean,
  tag?: string,
): Promise<ProxyHost[]> {
  const where = proxyHostListFilter(search, visibleIds, enabled, tag);
  const col = (sortBy && PROXY_HOST_SORT_COLUMNS[sortBy]) || proxyHosts.createdAt;
  const dir = sortDir === "asc" ? asc : desc;
  const hosts = await db
    .select()
    .from(proxyHosts)
    .where(where)
    .orderBy(dir(col))
    .limit(limit)
    .offset(offset);
  return hosts.map(parseProxyHost);
}

/**
 * Id and names of every host the list's filters match, newest first: the whole set, for traffic
 * the database cannot sort by. Paging is the caller's.
 */
export async function listProxyHostDomainRefs(
  search?: string,
  visibleIds?: number[] | null,
  enabled?: boolean,
  tag?: string,
): Promise<{ id: number; domains: string[] }[]> {
  const rows = await db
    .select({ id: proxyHosts.id, domains: proxyHosts.domains })
    .from(proxyHosts)
    .where(proxyHostListFilter(search, visibleIds, enabled, tag))
    .orderBy(desc(proxyHosts.createdAt));
  return rows.map((row) => ({ id: row.id, domains: parseStoredDomains(row.domains) }));
}

function parseStoredDomains(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

/** In the order asked for; ids that no longer exist are left out. */
export async function getProxyHostsByIds(ids: readonly number[]): Promise<ProxyHost[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(proxyHosts)
    .where(inArray(proxyHosts.id, [...ids]));
  const byId = new Map(rows.map((row) => [row.id, parseProxyHost(row)]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** Every tag on the hosts the viewer can see, for the list's tag filter. */
export async function listProxyHostTags(visibleIds?: number[] | null): Promise<string[]> {
  const rows = await db
    .select({ tags: proxyHosts.tags })
    .from(proxyHosts)
    .where(proxyHostListFilter(undefined, visibleIds));
  return collectTags(rows);
}

/**
 * In the model so the REST API meets it too: the builder would skip an unadaptable snippet with a
 * warning, quietly dropping whatever it was for.
 */
async function assertCaddyfileAdapts(
  snippet: string | null | undefined,
  agentRowIds: readonly number[],
): Promise<void> {
  if (!snippet?.trim()) return;
  const error = await validateCaddyfileSnippet(snippet, agentRowIds);
  if (error) throw error;
}

const RAW_CONFIG_FIELDS = [
  "customReverseProxyJson",
  "customPreHandlersJson",
  "customCaddyfile",
] as const;

/**
 * Raw-config fields go in unchecked - a reverse_proxy to the admin API is one object away -
 * so only an admin may change them, enforced here for every API. Resubmitting the stored value is
 * not a change, so an operator can still save a host an admin gave a snippet.
 */
async function assertRawConfigChangeAllowed(
  existing: Pick<ProxyHost, (typeof RAW_CONFIG_FIELDS)[number]> | null,
  input: Partial<ProxyHostInput>,
  actorUserId: number,
): Promise<void> {
  const changed = RAW_CONFIG_FIELDS.some(
    (field) =>
      input[field] !== undefined &&
      normalizeMetaValue(input[field]) !== normalizeMetaValue(existing?.[field]),
  );
  if (!changed) return;
  if (!(await mayReachInstance(actorUserId))) {
    throw domainError("rawCaddyConfigAdminOnly");
  }
}

/**
 * The raw-config guard's twin for every address a host makes Caddy dial: its upstreams, each
 * location rule's, and the Authentik, Anubis and forward-auth servers.
 */
async function assertDialTargetsAllowed(
  existing: Pick<
    ProxyHost,
    "upstreams" | "authentik" | "anubis" | "locationRules" | "forwardAuth"
  > | null,
  input: Partial<ProxyHostInput>,
  actorUserId: number,
): Promise<void> {
  await assertNoNewAdminDialTargets(
    [
      ...(existing?.upstreams ?? []),
      ...(existing?.locationRules ?? []).flatMap((rule) => rule.upstreams),
      existing?.authentik?.outpostUpstream ?? "",
      existing?.anubis?.upstream ?? "",
      existing?.forwardAuth?.authUpstream ?? "",
    ],
    [
      ...(input.upstreams ?? []),
      ...(input.locationRules ?? []).flatMap((rule) => rule.upstreams ?? []),
      input.authentik?.outpostUpstream ?? "",
      input.anubis?.upstream ?? "",
      input.forwardAuth?.authUpstream ?? "",
    ],
    actorUserId,
  );
}

type ProxyHostInsert = typeof proxyHosts.$inferInsert;

/** Every check a create runs, and the row it would insert; nothing is written. */
async function prepareProxyHostCreate(
  body: ProxyHostInput,
  actorUserId: number,
): Promise<Omit<ProxyHostInsert, "createdAt" | "updatedAt">> {
  const input = applyProxyHostDefaults(body, (await getHostDefaults()).proxyHost);
  const domains = normalizeProxyHostDomains(input.domains ?? []);

  if (!input.upstreams || input.upstreams.length === 0) {
    throw domainError("upstreamsRequired");
  }
  input.upstreams.forEach(validateUpstreamProtocol);
  await assertRawConfigChangeAllowed(null, input, actorUserId);
  await assertDialTargetsAllowed(null, input, actorUserId);
  await assertWildcardIssuable(domains, input.certificateId ?? null);
  await assertCertificateServable(input.certificateId ?? null, input.agentIds ?? []);
  await assertCaddyfileAdapts(input.customCaddyfile, input.agentIds ?? []);

  const meta = buildMeta({}, input, input.waf ? await getWafSettings() : null);
  await assertTailscaleServable(meta);
  await assertWafPresetIdsExist(parseMeta(meta).waf?.preset_ids);
  await assertLocationAccessListsExist(parseMeta(meta).location_rules);
  await assertCrsPluginIdsExist(parseMeta(meta).waf?.plugin_ids);
  await assertHostWafLoads(
    { kind: "host", name: input.name.trim() },
    undefined,
    parseMeta(meta).waf,
  );
  return {
    name: input.name.trim(),
    description: normalizeHostDescription(input.description) ?? null,
    tags: JSON.stringify(normalizeHostTags(input.tags) ?? []),
    domains: JSON.stringify(domains),
    upstreams: JSON.stringify(Array.from(new Set(input.upstreams.map((u) => u.trim())))),
    certificateId: input.certificateId ?? null,
    accessListId: input.accessListId ?? null,
    ownerUserId: actorUserId,
    sslForced: input.sslForced ?? true,
    hstsEnabled: input.hstsEnabled ?? true,
    hstsSubdomains: input.hstsSubdomains ?? false,
    allowWebsocket: input.allowWebsocket ?? true,
    preserveHostHeader: input.preserveHostHeader ?? true,
    meta,
    skipHttpsHostnameValidation: input.skipHttpsHostnameValidation ?? false,
    enabled: input.enabled ?? true,
  };
}

/** A new host as the defaults leave it, for diffing a create against. */
export function blankProxyHost(): ProxyHost {
  const now = nowIso();
  return parseProxyHost({
    id: 0,
    uuid: null,
    name: "",
    description: null,
    tags: "[]",
    domains: "[]",
    upstreams: "[]",
    certificateId: null,
    accessListId: null,
    ownerUserId: null,
    sslForced: true,
    hstsEnabled: true,
    hstsSubdomains: false,
    allowWebsocket: true,
    preserveHostHeader: true,
    meta: null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    skipHttpsHostnameValidation: false,
  });
}

/**
 * The host a create or update would leave, after every check the save runs - but nothing stored,
 * audited or applied. The review step's source, so what it shows is what the save writes.
 */
export async function planProxyHostChange(
  id: number | null,
  input: Partial<ProxyHostInput>,
  actorUserId: number,
): Promise<{ before: ProxyHost | null; after: ProxyHost; agentIdsBefore: number[] }> {
  if (id === null) {
    const values = await prepareProxyHostCreate(input as ProxyHostInput, actorUserId);
    return { before: null, after: plannedProxyHost(values, actorUserId), agentIdsBefore: [] };
  }
  const { existing, row, set } = await prepareProxyHostUpdate(id, input, actorUserId);
  return {
    before: existing,
    after: parseProxyHost({ ...row, ...set } as ProxyHostRow),
    agentIdsBefore: await agentIdsForHost("http", id),
  };
}

/** The host a create's values parse to, before it has an id. */
function plannedProxyHost(
  values: Omit<ProxyHostInsert, "createdAt" | "updatedAt">,
  actorUserId: number,
): ProxyHost {
  const now = nowIso();
  return parseProxyHost({
    ...values,
    id: 0,
    description: values.description ?? null,
    tags: values.tags ?? "[]",
    certificateId: values.certificateId ?? null,
    accessListId: values.accessListId ?? null,
    ownerUserId: actorUserId,
    meta: values.meta ?? null,
    createdAt: now,
    updatedAt: now,
  } as ProxyHostRow);
}

/** A stored row as the model reads it, for a revision's snapshot. */
export function proxyHostFromRow(row: Record<string, unknown>): ProxyHost {
  return parseProxyHost(row as ProxyHostRow);
}

export async function createProxyHost(input: ProxyHostInput, actorUserId: number) {
  const values = await prepareProxyHostCreate(input, actorUserId);
  const changes = await hostAuditChanges(
    "http",
    null,
    { host: plannedProxyHost(values, actorUserId), agentIds: input.agentIds ?? [] },
    blankProxyHost(),
  );
  const now = nowIso();
  const id = await runHostWrite(function* (tx) {
    const [record] = (yield {
      all: tx
        .insert(proxyHosts)
        .values({ ...values, createdAt: now, updatedAt: now })
        .returning({ id: proxyHosts.id }),
    }) as { id: number }[];
    if (!record) {
      throw domainError("failedToCreateProxyHost");
    }
    // Before the apply, so the first document each agent is sent already reflects the placement.
    if (input.agentIds !== undefined) {
      yield* setHostAgentsSteps(tx, "http", record.id, input.agentIds);
    }
    yield* auditedRevision(
      tx,
      { kind: "http", hostId: record.id, operation: "create", userId: actorUserId },
      {
        userId: actorUserId,
        action: "create",
        entityType: "proxy_host",
        entityId: record.id,
        summary: `Created proxy host ${input.name}`,
        changes,
      },
    );
    return record.id;
  });

  await applyCaddyConfig();
  return (await getProxyHost(id))!;
}

/** A host's `meta` blob as stored, for copying it somewhere that stores the same blob. */
export async function getProxyHostMeta(id: number): Promise<string | null> {
  const [row] = await db
    .select({ meta: proxyHosts.meta })
    .from(proxyHosts)
    .where(eq(proxyHosts.id, id))
    .limit(1);
  return row?.meta ?? null;
}

export async function getProxyHost(id: number): Promise<ProxyHost | null> {
  const host = await db.query.proxyHosts.findFirst({
    where: (table, { eq }) => eq(table.id, id),
  });
  return host ? parseProxyHost(host) : null;
}

/** The serial id of the host a URL or REST path names by uuid; null when there is no such host. */
export async function resolveProxyHostId(raw: string): Promise<number | null> {
  const uuid = parseHostUuid(raw);
  if (!uuid) return null;
  const [row] = await db
    .select({ id: proxyHosts.id })
    .from(proxyHosts)
    .where(eq(proxyHosts.uuid, uuid))
    .limit(1);
  return row?.id ?? null;
}

/** Every check an update runs, and the columns it would set; nothing is written. */
async function prepareProxyHostUpdate(
  id: number,
  input: Partial<ProxyHostInput>,
  actorUserId: number,
): Promise<{ existing: ProxyHost; row: ProxyHostRow; set: Partial<ProxyHostRow> }> {
  const row = await db.query.proxyHosts.findFirst({
    where: (table, { eq }) => eq(table.id, id),
  });
  if (!row) {
    throw domainError("proxyHostNotFound");
  }
  const existing = parseProxyHost(row);
  const tags = normalizeHostTags(input.tags);
  await assertRawConfigChangeAllowed(existing, input, actorUserId);
  await assertDialTargetsAllowed(existing, input, actorUserId);

  const domainList = input.domains ? normalizeProxyHostDomains(input.domains) : existing.domains;
  const domains = JSON.stringify(domainList);
  if (input.upstreams) {
    input.upstreams.forEach(validateUpstreamProtocol);
  }
  const effectiveCertificateId =
    input.certificateId !== undefined ? input.certificateId : existing.certificateId;
  await assertWildcardIssuable(domainList, effectiveCertificateId);
  if (input.certificateId !== undefined || input.agentIds !== undefined) {
    await assertCertificateServable(
      effectiveCertificateId,
      input.agentIds ?? (await agentIdsForHost("http", id)),
    );
  }
  if (input.customCaddyfile !== undefined) {
    await assertCaddyfileAdapts(
      input.customCaddyfile,
      input.agentIds ?? (await agentIdsForHost("http", id)),
    );
  }
  const upstreams = input.upstreams
    ? JSON.stringify(Array.from(new Set(input.upstreams)))
    : JSON.stringify(existing.upstreams);
  const existingMeta: ProxyHostMeta = {
    custom_reverse_proxy_json: existing.customReverseProxyJson ?? undefined,
    custom_pre_handlers_json: existing.customPreHandlersJson ?? undefined,
    custom_caddyfile: existing.customCaddyfile ?? undefined,
    authentik: dehydrateAuthentik(existing.authentik),
    load_balancer: dehydrateLoadBalancer(existing.loadBalancer),
    dns_resolver: dehydrateDnsResolver(existing.dnsResolver),
    upstream_dns_resolution: dehydrateUpstreamDnsResolution(existing.upstreamDnsResolution),
    geoblock: dehydrateGeoBlock(existing.geoblock),
    ...(existing.geoblockMode !== "merge" ? { geoblock_mode: existing.geoblockMode } : {}),
    ...(existing.waf ? { waf: existing.waf } : {}),
    ...(existing.mtls ? { mtls: existing.mtls } : {}),
    ...(existing.cpmForwardAuth?.enabled
      ? {
          cpm_forward_auth: {
            enabled: true,
            ...(existing.cpmForwardAuth.protected_paths
              ? { protected_paths: existing.cpmForwardAuth.protected_paths }
              : {}),
            ...(existing.cpmForwardAuth.excluded_paths
              ? { excluded_paths: existing.cpmForwardAuth.excluded_paths }
              : {}),
            ...(existing.cpmForwardAuth.require_captcha === false
              ? { require_captcha: false }
              : {}),
          },
        }
      : {}),
    ...(existing.forwardAuth ? { forward_auth: dehydrateForwardAuth(existing.forwardAuth) } : {}),
    tailscale: dehydrateTailscale(existing.tailscale),
    ...(existing.redirects && existing.redirects.length > 0
      ? { redirects: existing.redirects }
      : {}),
    ...(existing.rewrite ? { rewrite: existing.rewrite } : {}),
    ...(existing.locationRules && existing.locationRules.length > 0
      ? { location_rules: dehydrateLocationRules(existing.locationRules) }
      : {}),
    ...(existing.pathAllows && existing.pathAllows.length > 0
      ? { path_allows: existing.pathAllows }
      : {}),
    ...(existing.pathBlocks && existing.pathBlocks.length > 0
      ? { path_blocks: existing.pathBlocks }
      : {}),
    ...(existing.pathRewrites && existing.pathRewrites.length > 0
      ? { path_rewrites: existing.pathRewrites }
      : {}),
    ...(existing.errorPages && existing.errorPages.length > 0
      ? { error_pages: existing.errorPages }
      : {}),
    ...(existing.cache ? { cache: sanitizeHostCache(existing.cache) } : {}),
    compression: storedCompression(existing.compression),
    ...(existing.discourageIndexing ? { discourage_indexing: true } : {}),
    ...(existing.skipAccessLog ? { skip_access_log: true } : {}),
    maintenance: sanitizeHostMaintenance(existing.maintenance),
    upstream_timeouts: sanitizeHostUpstreamTimeouts(existing.upstreamTimeouts),
    rate_limit: sanitizeHostRateLimit(existing.rateLimit),
    crowdsec: storedHostCrowdSec(existing.crowdsec),
    anubis: sanitizeHostAnubis(existing.anubis),
  };
  const meta = buildMeta(existingMeta, input, input.waf ? await getWafSettings() : null);
  await assertTailscaleServable(meta);
  await assertWafPresetIdsExist(parseMeta(meta).waf?.preset_ids);
  await assertLocationAccessListsExist(parseMeta(meta).location_rules);
  await assertCrsPluginIdsExist(parseMeta(meta).waf?.plugin_ids);
  await assertHostWafLoads(
    { kind: "host", name: input.name ?? existing.name, id },
    existingMeta.waf,
    parseMeta(meta).waf,
  );

  return {
    existing,
    row,
    set: {
      name: input.name ?? existing.name,
      description:
        input.description !== undefined
          ? normalizeHostDescription(input.description)
          : existing.description,
      tags: JSON.stringify(tags ?? existing.tags),
      domains,
      upstreams,
      certificateId: effectiveCertificateId,
      accessListId: input.accessListId !== undefined ? input.accessListId : existing.accessListId,
      sslForced: input.sslForced ?? existing.sslForced,
      hstsEnabled: input.hstsEnabled ?? existing.hstsEnabled,
      hstsSubdomains: input.hstsSubdomains ?? existing.hstsSubdomains,
      allowWebsocket: input.allowWebsocket ?? existing.allowWebsocket,
      preserveHostHeader: input.preserveHostHeader ?? existing.preserveHostHeader,
      meta,
      skipHttpsHostnameValidation:
        input.skipHttpsHostnameValidation ?? existing.skipHttpsHostnameValidation,
      enabled: input.enabled ?? existing.enabled,
    },
  };
}

export async function updateProxyHost(
  id: number,
  input: Partial<ProxyHostInput>,
  actorUserId: number,
  options: HostWriteOptions = {},
) {
  const { existing, row, set } = await prepareProxyHostUpdate(id, input, actorUserId);
  const agentIdsBefore = await agentIdsForHost("http", id);
  const changes = await hostAuditChanges(
    "http",
    { host: existing, agentIds: agentIdsBefore },
    {
      host: parseProxyHost({ ...row, ...set } as ProxyHostRow),
      agentIds: input.agentIds ?? agentIdsBefore,
    },
    blankProxyHost(),
  );
  const now = nowIso();
  await runHostWrite(function* (tx) {
    yield {
      run: tx
        .update(proxyHosts)
        .set({ ...set, updatedAt: now })
        .where(eq(proxyHosts.id, id)),
    };
    if (input.agentIds !== undefined) {
      yield* setHostAgentsSteps(tx, "http", id, input.agentIds);
    }
    yield* auditedRevision(
      tx,
      { kind: "http", hostId: id, userId: actorUserId, ...updateOperation(options) },
      {
        userId: actorUserId,
        action: "update",
        entityType: "proxy_host",
        entityId: id,
        summary:
          options.rollbackFrom !== undefined
            ? `Rolled back proxy host ${input.name ?? existing.name} to revision ${options.rollbackFrom}`
            : `Updated proxy host ${input.name ?? existing.name}`,
        changes,
      },
    );
  });
  await pruneHostRevisions("http", [id]);

  await applyCaddyConfig();
  return (await getProxyHost(id))!;
}

/** A stored `meta` with maintenance switched, keeping the host's bypass ranges and page. */
export function withMaintenance(meta: string | null, enabled: boolean): string | null {
  const parsed = parseMeta(meta);
  parsed.maintenance = { ...(parsed.maintenance ?? { enabled }), enabled };
  return serializeMeta(parsed);
}

/**
 * The row menu's quick toggle: flips only `enabled`, keeping the host's bypass ranges and page, and
 * audits the switch itself rather than a generic update.
 */
export async function setProxyHostMaintenance(
  id: number,
  enabled: boolean,
  actorUserId: number,
): Promise<ProxyHost> {
  const existing = await getProxyHost(id);
  if (!existing) {
    throw domainError("proxyHostNotFound");
  }
  const meta = withMaintenance(await getProxyHostMeta(id), enabled);
  const now = nowIso();
  await runHostWrite(function* (tx) {
    yield {
      run: tx.update(proxyHosts).set({ meta, updatedAt: now }).where(eq(proxyHosts.id, id)),
    };
    yield* auditedRevision(
      tx,
      { kind: "http", hostId: id, operation: "maintenance", userId: actorUserId },
      {
        userId: actorUserId,
        action: "update",
        entityType: "proxy_host",
        entityId: id,
        summary: `${enabled ? "Turned on" : "Turned off"} maintenance mode for proxy host ${existing.name}`,
        data: { maintenance: { enabled } },
      },
    );
  });
  await pruneHostRevisions("http", [id]);
  await applyCaddyConfig();
  return (await getProxyHost(id))!;
}

export async function deleteProxyHost(id: number, actorUserId: number) {
  const existing = await getProxyHost(id);
  if (!existing) {
    throw domainError("proxyHostNotFound");
  }

  const agentIdsBefore = await agentIdsForHost("http", id);
  const changes = await hostAuditChanges(
    "http",
    { host: existing, agentIds: agentIdsBefore },
    null,
    blankProxyHost(),
  );
  await runHostWrite(function* (tx) {
    // Before the row goes: a deleted host's last state is what restoring it brings back.
    yield* auditedRevision(
      tx,
      { kind: "http", hostId: id, operation: "delete", userId: actorUserId },
      {
        userId: actorUserId,
        action: "delete",
        entityType: "proxy_host",
        entityId: id,
        summary: `Deleted proxy host ${existing.name}`,
        changes,
      },
    );
    yield { run: tx.delete(proxyHosts).where(eq(proxyHosts.id, id)) };
  });
  await pruneHostRevisions("http", [id]);
  await applyCaddyConfig();
}
