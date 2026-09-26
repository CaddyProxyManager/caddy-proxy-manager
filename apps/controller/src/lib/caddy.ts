import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { Resolver } from "node:dns/promises";
import { buildDashboardHostRow } from "./dashboard-host";
import { join, dirname } from "node:path";
import { isIP } from "node:net";
import { isConnectionError } from "./net-errors";
import {
  expandPrivateRanges,
  isPlainObject,
  mergeDeep,
  parseJson,
  parseOptionalJson,
  parseCustomHandlers,
  formatDialAddress,
  parseUpstreamTarget,
  toDurationMs,
  canonicalHeaderName,
  upstreamHeaderPlaceholder,
  stripCaddyPlaceholders,
  isReservedL4ListenAddress,
} from "./caddy-utils";
import {
  groupHostPatternsByPriority,
  sortAutomationPoliciesBySubjectPriority,
  sortRoutesByHostPriority,
  sortTlsPoliciesBySniPriority,
} from "./host-pattern-priority";
import db from "./db";
import { asc, eq, isNull } from "drizzle-orm";
import { config } from "./config";
import {
  getDashboardSettings,
  getGeneralSettings,
  getAcmeSettings,
  getMetricsSettings,
  getLoggingSettings,
  getDnsSettings,
  getDnsProviderSettings,
  getUpstreamDnsResolutionSettings,
  getGeoBlockSettings,
  getWafSettings,
  getErrorPagesSettings,
  getDefaultResponseSettings,
  getTrustedProxiesSettings,
  getHttpProtocolsSettings,
  type HttpProtocolsSettings,
  getTailscaleSettings,
  defaultTailscaleSettings,
  type AcmeSettings,
  type DnsProviderSettings,
  type DnsSettings,
  type UpstreamDnsAddressFamily,
  type UpstreamDnsResolutionSettings,
  type GeoBlockSettings,
  type WafSettings,
  type TrustedProxiesSettings,
  type TailscaleSettings,
} from "./settings";
import { buildDefaultResponseRoute } from "./caddy-default-response";
import {
  buildTailscaleApp,
  buildTailscaleAuthSubroute,
  buildTailscaleAutomationPolicy,
  buildTailscaleIdentityStripHandler,
  buildTailscaleTransport,
  isTailscaleDomain,
  tailscaleListenAddresses,
  TAILSCALE_DEFAULT_NODE,
} from "./caddy-tailscale";
import type { DnsProviderCredentials } from "./dns-providers";
import { buildDnsChallengeConfig } from "./dns-provider-credentials";
import { caddyAdminRequest } from "./caddy-admin";
import { getPublicBaseUrl } from "./public-url";
import {
  accessListEntries,
  accessListIpRules,
  accessLists,
  certificates,
  caCertificates,
  issuedClientCertificates,
  proxyHosts,
  l4ProxyHosts,
} from "./db/schema";
import type {
  GeoBlockMode,
  WafHostConfig,
  MtlsConfig,
  RedirectRule,
  RewriteConfig,
  LocationRuleMeta,
  PathAllowRule,
  PathBlockRule,
  PathRewriteRule,
  ErrorPageRule,
} from "./models/proxy-hosts";
import {
  buildClientAuthentication,
  groupMtlsDomainsByCaSet,
  buildMtlsRbacSubroutes,
  buildFingerprintCelExpression,
  buildValidClientCertCelExpression,
  isCertificateUnexpired,
  normalizeFingerprint,
  resolveAllowedFingerprints,
  resolveLegacyCaFingerprints,
  type MtlsAccessRuleLike,
} from "./caddy-mtls";
import { buildRoleMaps } from "./models/mtls-roles";
import { getAccessRulesForHosts } from "./models/mtls-access-rules";
import { getWafPresetDirectives } from "./models/waf-presets";
import { getCrsPluginRules } from "./models/crs-plugins";
import { loadWithCrsPluginRecovery } from "./crs-plugins/recovery";
import {
  type CrsPluginRules,
  WEBSOCKET_ATTEMPT_MATCHERS,
  buildWafHandlerEntry,
  resolveEffectiveWaf,
} from "./caddy-waf";
import { adaptCaddyfileSnippet, buildCaddyfileSubrouteHandler } from "./caddy-caddyfile";
import { buildRedirectRoute } from "./caddy-redirects";
import { evictedNames, withRenewalOverrides } from "./certificate-renewals";
import { reachabilityRoute } from "./domain-reachability";
import { type AccessListRuntime, buildAccessListHandlers, type IpRule } from "./access-list-rules";
import {
  type CaddyModuleAvailability,
  getCaddyModuleAvailability,
  isDnsProviderUsable,
  isFeatureUsable,
} from "./caddy-build";
import { listHostAssignments, servedByAgent } from "./models/host-agents";
import { FORWARD_AUTH_PROXY_PROOF_HEADER, getForwardAuthProxyProof } from "./forward-auth-trust";
import { decryptSecret } from "./secret";
import {
  CaddyApplyError,
  describeCaddyRejection,
  describeWafRejection,
  logCaddyApplyFailure,
} from "./caddy-apply-error";
import { currentStagingScope } from "./settings/staging-context";

const CERTS_DIR = process.env.CERTS_DIRECTORY || join(process.cwd(), "data", "certs");
mkdirSync(CERTS_DIR, { recursive: true, mode: 0o700 });

// Shared with the Caddy container via a Docker volume, so a custom ACME CA root PEM written
// here is readable by Caddy at the same path for `trusted_roots_pem_files`. Read lazily so
// tests and non-Docker deployments can override ACME_CA_ROOT_DIR at runtime.
function acmeCaRootFile(): string {
  return join(process.env.ACME_CA_ROOT_DIR || "/acme-ca", "custom-ca-root.pem");
}

/**
 * Persist (or clear) the custom ACME CA root PEM and return the path Caddy should reference, or
 * null - leaving the issuer without `trusted_roots_pem_files` rather than a missing file.
 */
function syncAcmeCaRootFile(caRootPem: string | undefined): string | null {
  const file = acmeCaRootFile();
  const pem = caRootPem?.trim();
  if (!pem) {
    try {
      rmSync(file, { force: true });
    } catch {
      // best-effort cleanup
    }
    return null;
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, pem.endsWith("\n") ? pem : `${pem}\n`, { mode: 0o644 });
    return file;
  } catch (error) {
    console.error(`Failed to write ACME CA root PEM to ${file}`, error);
    return null;
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

/**
 * The Authelia preset for the generic forward-auth provider. Mirrored in models/proxy-hosts.ts,
 * which is where a stored block gets them; this file reads the stored blob, never the model.
 */
const DEFAULT_AUTHELIA_FORWARD_AUTH_ENDPOINT = "/api/authz/forward-auth";
const DEFAULT_AUTHELIA_FORWARD_AUTH_HEADERS = [
  "Remote-User",
  "Remote-Groups",
  "Remote-Email",
  "Remote-Name",
  "Remote-IP",
];

/**
 * An RFC 7230 header name. Copy and bypass header names are interpolated into Caddy placeholders
 * and into matcher keys, so nothing free-form may reach them.
 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export type ProxyHostRow = {
  id: number;
  name: string;
  domains: string;
  upstreams: string;
  certificateId: number | null;
  accessListId: number | null;
  sslForced: number;
  hstsEnabled: number;
  hstsSubdomains: number;
  allowWebsocket: number;
  preserveHostHeader: number;
  skipHttpsHostnameValidation: number;
  meta: string | null;
  enabled: number;
};

type DnsResolverMeta = {
  enabled?: boolean;
  resolvers?: string[];
  fallbacks?: string[];
  timeout?: string;
};

type UpstreamDnsResolutionMeta = {
  enabled?: boolean;
  family?: UpstreamDnsAddressFamily;
};

type CpmForwardAuthMeta = {
  enabled?: boolean;
  protected_paths?: string[];
  excluded_paths?: string[];
};

/** Mirror of the model's ForwardAuthMeta for an auth server this app does not run itself. */
type ForwardAuthMeta = {
  enabled?: boolean;
  provider?: string;
  auth_upstream?: string;
  auth_endpoint?: string;
  copy_headers?: string[];
  trusted_proxies?: string[];
  api_split?: boolean;
  api_bypass_headers?: string[];
  protected_paths?: string[];
  excluded_paths?: string[];
};

/** Mirror of the model's TailscaleMeta; this file reads the stored blob, never the model. */
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

type MtlsMeta = {
  enabled?: boolean;
  trusted_client_cert_ids?: number[];
  trusted_role_ids?: number[];
  protected_paths?: string[];
  excluded_paths?: string[];
  ca_certificate_ids?: number[];
};

type ProxyHostMeta = {
  custom_reverse_proxy_json?: string;
  custom_pre_handlers_json?: string;
  custom_caddyfile?: string;
  authentik?: ProxyHostAuthentikMeta;
  cpm_forward_auth?: CpmForwardAuthMeta;
  forward_auth?: ForwardAuthMeta;
  tailscale?: TailscaleMeta;
  load_balancer?: LoadBalancerMeta;
  dns_resolver?: DnsResolverMeta;
  upstream_dns_resolution?: UpstreamDnsResolutionMeta;
  geoblock?: GeoBlockSettings;
  geoblock_mode?: GeoBlockMode;
  waf?: WafHostConfig;
  mtls?: MtlsMeta;
  redirects?: RedirectRule[];
  rewrite?: RewriteConfig;
  location_rules?: LocationRuleMeta[];
  path_allows?: PathAllowRule[];
  path_blocks?: PathBlockRule[];
  path_rewrites?: PathRewriteRule[];
  error_pages?: ErrorPageRule[];
};

type L4Meta = {
  load_balancer?: LoadBalancerMeta;
  dns_resolver?: DnsResolverMeta;
  upstream_dns_resolution?: UpstreamDnsResolutionMeta;
  geoblock?: GeoBlockSettings;
  geoblock_mode?: GeoBlockMode;
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

type AuthentikRouteConfig = {
  enabled: boolean;
  outpostDomain: string;
  outpostUpstream: string;
  authEndpoint: string;
  copyHeaders: string[];
  trustedProxies: string[];
  setOutpostHostHeader: boolean;
  protectedPaths: string[] | null;
  excludedPaths: string[] | null;
};

type ForwardAuthRouteConfig = {
  provider: "authelia" | "custom";
  /** host:port the auth subrequest dials, taken from the auth server's URL. */
  dialAddress: string;
  /** URI the auth subrequest is rewritten to. May carry a query string. */
  authEndpoint: string;
  copyHeaders: string[];
  trustedProxies: string[];
  /** Answer a non-browser caller with 401 rather than the auth server's portal redirect. */
  apiSplit: boolean;
  /** A request carrying any of these headers skips forward auth entirely. */
  apiBypassHeaders: string[];
  protectedPaths: string[] | null;
  excludedPaths: string[] | null;
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

type LoadBalancerRouteConfig = {
  enabled: boolean;
  policy: string;
  policyHeaderField: string | null;
  policyCookieName: string | null;
  policyCookieSecret: string | null;
  policyQueryKey: string | null;
  policyChoose: number | null;
  policyWeights: number[] | null;
  tryDuration: string | null;
  tryInterval: string | null;
  retries: number | null;
  activeHealthCheck: {
    enabled: boolean;
    uri: string | null;
    port: number | null;
    interval: string | null;
    timeout: string | null;
    status: number | null;
    body: string | null;
    passes: number | null;
    fails: number | null;
    method: string | null;
    requestBody: string | null;
    followRedirects: boolean;
    headers: Record<string, string> | null;
  } | null;
  passiveHealthCheck: {
    enabled: boolean;
    failDuration: string | null;
    maxFails: number | null;
    unhealthyStatus: number[] | null;
    unhealthyLatency: string | null;
    unhealthyRequestCount: number | null;
  } | null;
};

type AccessListEntryRow = {
  accessListId: number;
  username: string;
  passwordHash: string;
};

type CertificateRow = {
  id: number;
  name: string;
  type: string;
  domainNames: string;
  certificatePem: string | null;
  privateKeyPem: string | null;
  autoRenew: number;
  providerOptions: string | null;
};

type CaddyHttpRoute = Record<string, unknown>;

type CertificateUsage = {
  certificate: CertificateRow;
  domains: Set<string>;
};

const VALID_UPSTREAM_DNS_FAMILIES: UpstreamDnsAddressFamily[] = ["ipv6", "ipv4", "both"];

type UpstreamDnsResolutionRouteConfig = {
  enabled: boolean | null;
  family: UpstreamDnsAddressFamily | null;
};

type EffectiveUpstreamDnsResolution = {
  enabled: boolean;
  family: UpstreamDnsAddressFamily;
};

function parseUpstreamDnsResolutionConfig(
  meta: UpstreamDnsResolutionMeta | undefined | null,
): UpstreamDnsResolutionRouteConfig | null {
  if (!meta) {
    return null;
  }

  const enabled = typeof meta.enabled === "boolean" ? meta.enabled : null;
  const family =
    meta.family && VALID_UPSTREAM_DNS_FAMILIES.includes(meta.family) ? meta.family : null;

  if (enabled === null && family === null) {
    return null;
  }

  return {
    enabled,
    family,
  };
}

function resolveEffectiveUpstreamDnsResolution(
  globalSetting: UpstreamDnsResolutionSettings | null,
  hostSetting: UpstreamDnsResolutionRouteConfig | null,
): EffectiveUpstreamDnsResolution {
  const globalFamily =
    globalSetting?.family && VALID_UPSTREAM_DNS_FAMILIES.includes(globalSetting.family)
      ? globalSetting.family
      : "both";
  const globalEnabled = Boolean(globalSetting?.enabled);

  return {
    enabled: hostSetting?.enabled ?? globalEnabled,
    family: hostSetting?.family ?? globalFamily,
  };
}

function getLookupServers(
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

function getLookupTimeoutMs(
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

async function withTimeout<T>(
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

async function resolveHostnameAddresses(
  resolver: Resolver,
  hostname: string,
  family: UpstreamDnsAddressFamily,
  timeoutMs: number | null,
): Promise<string[]> {
  // Each lookup reports its own failure so the two can run together and still join errors in
  // AAAA-then-A order.
  const lookup = async (
    query: () => Promise<string[]>,
    label: string,
  ): Promise<{ addresses: string[]; error: string | null }> => {
    try {
      return { addresses: await withTimeout(query(), timeoutMs, label), error: null };
    } catch (error) {
      return { addresses: [], error: error instanceof Error ? error.message : String(error) };
    }
  };

  const resolve6 = () => lookup(() => resolver.resolve6(hostname), `AAAA lookup for ${hostname}`);
  const resolve4 = () => lookup(() => resolver.resolve4(hostname), `A lookup for ${hostname}`);

  const results =
    family === "ipv6"
      ? [await resolve6()]
      : family === "ipv4"
        ? [await resolve4()]
        : await Promise.all([resolve6(), resolve4()]);

  const resolved: string[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const result of results) {
    if (result.error !== null) errors.push(result.error);
    for (const address of result.addresses) {
      if (!seen.has(address)) {
        seen.add(address);
        resolved.push(address);
      }
    }
  }

  if (resolved.length === 0 && errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  return resolved;
}

type ResolveUpstreamsResult = {
  upstreams: Array<{ dial: string }>;
  hasHttpsUpstream: boolean;
  httpsTlsServerName: string | null;
};

async function resolveUpstreamDials(
  row: ProxyHostRow,
  upstreams: string[],
  dnsConfig: DnsResolverRouteConfig | null,
  globalDnsSettings: DnsSettings | null,
  dnsResolution: EffectiveUpstreamDnsResolution,
): Promise<ResolveUpstreamsResult> {
  const parsedTargets = upstreams.map(parseUpstreamTarget);
  const hasHttpsUpstream = parsedTargets.some((target) => target.scheme === "https");

  if (!dnsResolution.enabled) {
    return {
      upstreams: parsedTargets.map((target) => ({ dial: target.dial })),
      hasHttpsUpstream,
      httpsTlsServerName: null,
    };
  }

  const httpsHostnames = Array.from(
    new Set(
      parsedTargets
        .filter(
          (target) =>
            target.scheme === "https" && target.host && target.port && isIP(target.host) === 0,
        )
        .map((target) => target.host as string),
    ),
  );
  const canResolveHttps = httpsHostnames.length <= 1;
  if (!canResolveHttps) {
    console.warn(
      `[caddy] Skipping DNS pinning for HTTPS upstreams on host "${row.name}" because multiple TLS server names are configured.`,
    );
  }

  const resolver = new Resolver();
  const lookupServers = getLookupServers(dnsConfig, globalDnsSettings);
  if (lookupServers.length > 0) {
    try {
      resolver.setServers(lookupServers);
    } catch (error) {
      console.warn(`[caddy] Failed to set custom DNS servers for upstream pinning`, error);
    }
  }
  const timeoutMs = getLookupTimeoutMs(dnsConfig, globalDnsSettings);

  // Targets are looked up together and flattened in list order, so the dial order is what the
  // operator wrote and the wait is the slowest lookup rather than the sum.
  const dialsPerTarget = await Promise.all(
    parsedTargets.map(async (target): Promise<string[]> => {
      if (!target.host || !target.port || isIP(target.host) !== 0) {
        return [target.dial];
      }

      if (target.scheme === "https" && !canResolveHttps) {
        return [target.dial];
      }

      try {
        const addresses = await resolveHostnameAddresses(
          resolver,
          target.host,
          dnsResolution.family,
          timeoutMs,
        );
        if (addresses.length === 0) {
          return [target.dial];
        }
        return addresses.map((address) => formatDialAddress(address, target.port as string));
      } catch (error) {
        console.warn(
          `[caddy] Failed to resolve upstream "${target.original}" for host "${row.name}", falling back to hostname dial.`,
          error,
        );
        return [target.dial];
      }
    }),
  );

  const dedupedDials: Array<{ dial: string }> = [];
  const seen = new Set<string>();
  for (const dial of dialsPerTarget.flat()) {
    if (!seen.has(dial)) {
      seen.add(dial);
      dedupedDials.push({ dial });
    }
  }

  return {
    upstreams: dedupedDials,
    hasHttpsUpstream,
    httpsTlsServerName: canResolveHttps && httpsHostnames.length === 1 ? httpsHostnames[0] : null,
  };
}

function collectCertificateUsage(rows: ProxyHostRow[], certificates: Map<number, CertificateRow>) {
  const usage = new Map<number, CertificateUsage>();
  const autoManagedDomains = new Set<string>();

  for (const row of rows) {
    if (!row.enabled) {
      continue;
    }

    const domains = parseJson<string[]>(row.domains, []).map((domain) =>
      domain?.trim().toLowerCase(),
    );
    const filteredDomains = domains.filter((domain): domain is string => Boolean(domain));
    if (filteredDomains.length === 0) {
      continue;
    }

    // Handle auto-managed certificates (certificateId is null)
    if (!row.certificateId) {
      for (const domain of filteredDomains) {
        autoManagedDomains.add(domain);
      }
      continue;
    }

    const cert = certificates.get(row.certificateId);
    if (!cert) {
      continue;
    }

    if (!usage.has(cert.id)) {
      usage.set(cert.id, {
        certificate: cert,
        domains: new Set(),
      });
    }

    const entry = usage.get(cert.id)!;
    for (const domain of filteredDomains) {
      entry.domains.add(domain);
    }
  }

  return { usage, autoManagedDomains };
}

function mergeGeoBlockSettings(global: GeoBlockSettings, host: GeoBlockSettings): GeoBlockSettings {
  return {
    enabled: host.enabled || global.enabled,
    block_countries: [...(global.block_countries ?? []), ...(host.block_countries ?? [])],
    block_continents: [...(global.block_continents ?? []), ...(host.block_continents ?? [])],
    block_asns: [...(global.block_asns ?? []), ...(host.block_asns ?? [])],
    block_cidrs: [...(global.block_cidrs ?? []), ...(host.block_cidrs ?? [])],
    block_ips: [...(global.block_ips ?? []), ...(host.block_ips ?? [])],
    allow_countries: [...(global.allow_countries ?? []), ...(host.allow_countries ?? [])],
    allow_continents: [...(global.allow_continents ?? []), ...(host.allow_continents ?? [])],
    allow_asns: [...(global.allow_asns ?? []), ...(host.allow_asns ?? [])],
    allow_cidrs: [...(global.allow_cidrs ?? []), ...(host.allow_cidrs ?? [])],
    allow_ips: [...(global.allow_ips ?? []), ...(host.allow_ips ?? [])],
    trusted_proxies: [...(global.trusted_proxies ?? []), ...(host.trusted_proxies ?? [])],
    // Host config wins for scalar fields
    fail_closed: host.fail_closed || global.fail_closed || false,
    response_status: host.response_status ?? global.response_status ?? 403,
    response_body: host.response_body ?? global.response_body ?? "Forbidden",
    response_headers: { ...(global.response_headers ?? {}), ...(host.response_headers ?? {}) },
    redirect_url: host.redirect_url ?? global.redirect_url ?? "",
  };
}

export function resolveEffectiveGeoBlock(
  global: GeoBlockSettings | null,
  host: { geoblock: GeoBlockSettings | null; geoblock_mode: GeoBlockMode },
): GeoBlockSettings | null {
  const hostConfig = host.geoblock;
  const globalConfig = global;

  // Neither configured or enabled
  if (!hostConfig?.enabled && !globalConfig?.enabled) return null;

  // Host override mode: use host config only
  if (hostConfig && host.geoblock_mode === "override") {
    return hostConfig.enabled ? hostConfig : null;
  }

  // Host merge mode: only enabled host config alters global behavior - a disabled host
  // geoblock means "no per-host geoblock".
  if (hostConfig?.enabled && globalConfig) {
    return mergeGeoBlockSettings(globalConfig, hostConfig);
  }

  // Only one configured
  if (hostConfig?.enabled) return hostConfig;
  if (globalConfig?.enabled) return globalConfig;

  return null;
}

export function buildBlockerHandler(config: GeoBlockSettings): Record<string, unknown> {
  const handler: Record<string, unknown> = {
    handler: "blocker",
    geoip_db: "/usr/share/GeoIP/GeoLite2-Country.mmdb",
    asn_db: "/usr/share/GeoIP/GeoLite2-ASN.mmdb",
  };

  if (config.block_countries?.length) handler.block_countries = config.block_countries;
  if (config.block_continents?.length) handler.block_continents = config.block_continents;
  if (config.block_asns?.length) handler.block_asns = config.block_asns;
  if (config.block_cidrs?.length) handler.block_cidrs = config.block_cidrs;
  if (config.block_ips?.length) handler.block_ips = config.block_ips;

  if (config.allow_countries?.length) handler.allow_countries = config.allow_countries;
  if (config.allow_continents?.length) handler.allow_continents = config.allow_continents;
  if (config.allow_asns?.length) handler.allow_asns = config.allow_asns;
  if (config.allow_cidrs?.length) handler.allow_cidrs = config.allow_cidrs;
  if (config.allow_ips?.length) handler.allow_ips = config.allow_ips;

  if (config.trusted_proxies?.length)
    handler.trusted_proxies = expandPrivateRanges(config.trusted_proxies);
  if (config.fail_closed) handler.fail_closed = true;

  if (config.redirect_url) {
    handler.redirect_url = config.redirect_url;
  } else {
    if (config.response_status) handler.response_status = config.response_status;
    if (config.response_body) handler.response_body = config.response_body;
    if (config.response_headers && Object.keys(config.response_headers).length) {
      handler.response_headers = config.response_headers;
    }
  }

  return handler;
}

function buildGeoBlockMatcher(config: GeoBlockSettings): Record<string, unknown> {
  const matcher: Record<string, unknown> = {
    geoip_db: "/usr/share/GeoIP/GeoLite2-Country.mmdb",
    asn_db: "/usr/share/GeoIP/GeoLite2-ASN.mmdb",
  };

  if (config.block_countries?.length) matcher.block_countries = config.block_countries;
  if (config.block_continents?.length) matcher.block_continents = config.block_continents;
  if (config.block_asns?.length) matcher.block_asns = config.block_asns;
  if (config.block_cidrs?.length) matcher.block_cidrs = config.block_cidrs;
  if (config.block_ips?.length) matcher.block_ips = config.block_ips;

  if (config.allow_countries?.length) matcher.allow_countries = config.allow_countries;
  if (config.allow_continents?.length) matcher.allow_continents = config.allow_continents;
  if (config.allow_asns?.length) matcher.allow_asns = config.allow_asns;
  if (config.allow_cidrs?.length) matcher.allow_cidrs = config.allow_cidrs;
  if (config.allow_ips?.length) matcher.allow_ips = config.allow_ips;

  return matcher;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function attachHostToRoute(route: CaddyHttpRoute, host: string | string[]): CaddyHttpRoute {
  const routeMatches = (route.match as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    ...route,
    match: routeMatches.map((match) => ({
      ...match,
      host,
    })),
  };
}

/** Normalize trusted-proxy ranges: trim, drop blanks, expand the "private_ranges" shorthand. */
export function normalizeTrustedProxyRanges(ranges: string[] | undefined | null): string[] {
  return expandPrivateRanges((ranges ?? []).map((r) => r.trim()).filter(Boolean));
}

/** Omitted while everything is on, so the config keeps following Caddy's own default. */
export function buildServerProtocols(settings: HttpProtocolsSettings): { protocols?: string[] } {
  if (settings.http2 && settings.http3) return {};
  return {
    protocols: ["h1", ...(settings.http2 ? ["h2"] : []), ...(settings.http3 ? ["h3"] : [])],
  };
}

/**
 * Server-level trusted-proxy fields for `servers.cpm`. Caddy resolves client_ip in core, before any
 * handler, so this is the only place a global list fixes IP attribution. Empty unless configured.
 */
export function buildServerTrustedProxies(settings: TrustedProxiesSettings | null | undefined): {
  trusted_proxies?: { source: string; ranges: string[] };
  client_ip_headers?: string[];
  trusted_proxies_strict?: number;
} {
  if (!settings) return {};

  const ranges = normalizeTrustedProxyRanges(settings.ranges);
  if (ranges.length === 0) return {};

  const out: {
    trusted_proxies: { source: string; ranges: string[] };
    client_ip_headers?: string[];
    trusted_proxies_strict?: number;
  } = {
    trusted_proxies: { source: "static", ranges },
  };

  const headers = (settings.client_ip_headers ?? []).map((h) => h.trim()).filter(Boolean);
  if (headers.length > 0) out.client_ip_headers = headers;

  // Caddy's trusted_proxies_strict is an int flag (1 = strict, 0 = off).
  if (settings.strict) out.trusted_proxies_strict = 1;

  return out;
}

/**
 * Tailscale as generation sees it. Resolved once per document because every host asks the same two
 * questions - is the feature on, and is the plugin actually in the running binary - and the answer
 * decides whether a `tailscale/...` listener may appear at all.
 */
type TailscaleRuntime = {
  settings: TailscaleSettings;
  /** Decrypted auth key, ready for the app block. Empty when none is stored. */
  authKey: string;
  /** Enabled by the operator *and* compiled in. False means emit nothing tailscale-shaped. */
  usable: boolean;
};

type TailscaleRouteConfig = {
  serve: boolean;
  node: string;
  tailnetOnly: boolean;
  auth: boolean;
  protectedPaths: string[] | null;
  excludedPaths: string[] | null;
  forwardIdentity: boolean;
  upstreamNode: string | null;
};

/**
 * What one host's stored Tailscale block means once the global settings are applied. Null whenever
 * nothing tailscale-shaped may be emitted for it - the feature is off, the plugin is missing, or
 * the host simply does not use it - so callers have one thing to check rather than three.
 */
function parseTailscaleConfig(
  meta: TailscaleMeta | undefined,
  runtime: TailscaleRuntime | null,
): TailscaleRouteConfig | null {
  if (!meta || !runtime?.usable) return null;

  const serve = Boolean(meta.serve);
  const upstreamNode = meta.upstream_node || null;
  if (!serve && !upstreamNode) return null;

  return {
    serve,
    node: meta.node || runtime.settings.defaultNode || TAILSCALE_DEFAULT_NODE,
    tailnetOnly: serve && Boolean(meta.tailnet_only),
    auth: serve && Boolean(meta.auth),
    protectedPaths: meta.protected_paths?.length ? meta.protected_paths : null,
    excludedPaths: meta.excluded_paths?.length ? meta.excluded_paths : null,
    forwardIdentity: Boolean(meta.forward_identity),
    upstreamNode,
  };
}

type CaddyBuildContext = {
  rows: ProxyHostRow[];
  accessLists: Map<number, AccessListRuntime>;
  tlsReadyCertificates: Set<number>;
  globalDnsSettings: DnsSettings | null;
  globalUpstreamDnsResolutionSettings: UpstreamDnsResolutionSettings | null;
  globalGeoBlock?: GeoBlockSettings | null;
  globalWaf?: WafSettings | null;
  /** waf_presets id -> directives. */
  wafPresets?: ReadonlyMap<number, string>;
  /** crs_plugins id -> rule files. */
  crsPlugins?: ReadonlyMap<number, CrsPluginRules>;
  /**
   * Which plugin-backed features the running binary can serve. Caddy validates a posted config as a
   * whole, so one handler naming an uncompiled module takes every host offline.
   */
  moduleAvailability: CaddyModuleAvailability;
  /** Null outside buildCaddyDocument - callers exercising route shapes have no settings to read. */
  tailscale?: TailscaleRuntime | null;
  /**
   * The agent this document is loaded onto, whose own Caddy adapts its Caddyfile snippets. Unset
   * only for a document no agent loads: a preview, or a controller with no agent attached.
   */
  adaptVia?: string;
  mtlsRbac?: {
    roleFingerprintMap: Map<number, Set<string>>;
    certFingerprintMap: Map<number, string>;
    accessRulesByHost: Map<number, MtlsAccessRuleLike[]>;
    /** CA id → fingerprints of its active certs, for legacy whole-CA hosts. */
    caFingerprintMap?: Map<number, Set<string>>;
    /** CAs that have ever had a CPM-issued cert, and so pin to leaves rather than trust the CA. */
    managedCaIds?: Set<number>;
  };
};

export function buildLocationReverseProxy(
  rule: LocationRuleMeta,
  skipHttpsValidation: boolean,
  preserveHostHeader: boolean,
): { safePath: string; reverseProxyHandler: Record<string, unknown> } {
  const parsedTargets = rule.upstreams.map(parseUpstreamTarget);
  const hasHttps = parsedTargets.some((t) => t.scheme === "https");

  // Sanitize path to prevent Caddy placeholder injection
  const safePath = stripCaddyPlaceholders(rule.path);

  const reverseProxyHandler: Record<string, unknown> = {
    handler: "reverse_proxy",
    upstreams: parsedTargets.map((t) => ({ dial: t.dial })),
  };

  if (preserveHostHeader) {
    reverseProxyHandler.headers = {
      request: { set: { Host: ["{http.request.host}"] } },
    };
  }

  if (hasHttps) {
    reverseProxyHandler.transport = {
      protocol: "http",
      tls: skipHttpsValidation ? { insecure_skip_verify: true } : {},
    };
  }

  // Per-rule load balancing / health checks (mirrors the host-level config).
  const lbConfig = parseLoadBalancerConfig(rule.load_balancer);
  if (lbConfig) {
    const loadBalancing = buildLoadBalancingConfig(lbConfig, parsedTargets.length);
    if (loadBalancing) {
      reverseProxyHandler.load_balancing = loadBalancing;
    }
    const healthChecks = buildHealthChecksConfig(lbConfig);
    if (healthChecks) {
      reverseProxyHandler.health_checks = healthChecks;
    }
  }

  return { safePath, reverseProxyHandler };
}

// A Caddy server-level error route (handle_errors equivalent): serves a custom static
// response while preserving the original status code. An empty `statuses` list matches every
// error; `hosts`, when set, scopes the route to a host.
export function buildErrorPageRoute(rule: ErrorPageRule, hosts?: string[]): CaddyHttpRoute {
  const matcher: Record<string, unknown> = {};
  if (hosts && hosts.length > 0) {
    matcher.host = hosts;
  }
  if (rule.statuses.length > 0) {
    // Mirrors Caddy's documented handle_errors form, e.g. {http.error.status_code} == 404
    matcher.expression = rule.statuses.map((s) => `{http.error.status_code} == ${s}`).join(" || ");
  }
  const route: CaddyHttpRoute = {
    handle: [
      {
        handler: "static_response",
        status_code: "{http.error.status_code}",
        body: rule.body,
        headers: { "Content-Type": [rule.contentType || "text/html; charset=utf-8"] },
      },
    ],
    terminal: true,
  };
  if (Object.keys(matcher).length > 0) {
    route.match = [matcher];
  }
  return route;
}

function appendLocationRoutes(options: {
  hostRoutes: CaddyHttpRoute[];
  domainGroup: string[];
  locationRules: LocationRuleMeta[];
  skipHttpsHostnameValidation: boolean;
  preserveHostHeader: boolean;
  handlers: Record<string, unknown>[];
  extraHandlers?: Record<string, unknown>[];
  expression?: string;
}) {
  const {
    hostRoutes,
    domainGroup,
    locationRules,
    skipHttpsHostnameValidation,
    preserveHostHeader,
    handlers,
    extraHandlers = [],
    expression,
  } = options;

  for (const rule of locationRules) {
    const { safePath, reverseProxyHandler: locationProxy } = buildLocationReverseProxy(
      rule,
      skipHttpsHostnameValidation,
      preserveHostHeader,
    );
    if (!safePath) continue;

    const matcher: Record<string, unknown> = {
      host: domainGroup,
      path: [safePath],
    };
    if (expression) matcher.expression = expression;

    hostRoutes.push({
      match: [matcher],
      handle: [...withLocationAccess(handlers, rule), ...extraHandlers, locationProxy],
      terminal: true,
    });
  }
}

/** A list nothing could be loaded for - deleted mid-build, say - admits nobody. */
const EMPTY_ACCESS_LIST: AccessListRuntime = {
  accounts: [],
  ipRules: [],
  ipDefault: "deny",
  satisfy: "all",
  passAuth: false,
};

/** A no-op placeholder: an empty subroute just continues the chain. */
const ACCESS_SLOT = () => ({ handler: "subroute", routes: [] });

/**
 * The host's access-list handlers, by identity: every handler array a path mode builds is a copy
 * with things added around the host's, so the objects themselves are what survives to be found.
 */
const HOST_ACCESS_HANDLERS = new WeakSet<object>();
/** A location rule's own list (or `[]` for none), set while its host's chain is built. */
const LOCATION_ACCESS = new WeakMap<LocationRuleMeta, Record<string, unknown>[]>();

/** The chain with the host's access handlers swapped for the rule's own, when it has one. */
function withLocationAccess(
  handlers: Record<string, unknown>[],
  rule: LocationRuleMeta,
): Record<string, unknown>[] {
  const own = LOCATION_ACCESS.get(rule);
  if (!own) return handlers;
  const at = handlers.findIndex((handler) => HOST_ACCESS_HANDLERS.has(handler));
  const rest = handlers.filter((handler) => !HOST_ACCESS_HANDLERS.has(handler));
  // Every host whose rules override got a slot above, so `at` is only -1 in a chain built
  // elsewhere; the rule's list then goes first rather than being dropped.
  const index = at === -1 ? 0 : at;
  return [...rest.slice(0, index), ...own, ...rest.slice(index)];
}

type PathAuthMode =
  | { type: "protected"; paths: string[] }
  | { type: "excluded"; paths: string[] }
  | { type: "full" };

type MtlsPathMode =
  | { type: "protected"; paths: string[] }
  | { type: "excluded"; paths: string[] }
  | { type: "full" };

function resolvePathAuthMode(
  protectedPaths?: string[] | null,
  excludedPaths?: string[] | null,
): PathAuthMode {
  if (protectedPaths && protectedPaths.length > 0) {
    return { type: "protected", paths: protectedPaths };
  }
  if (excludedPaths && excludedPaths.length > 0) {
    return { type: "excluded", paths: excludedPaths };
  }
  return { type: "full" };
}

function resolveMtlsPathMode(
  protectedPaths?: string[] | null,
  excludedPaths?: string[] | null,
): MtlsPathMode {
  if (protectedPaths && protectedPaths.length > 0) {
    return { type: "protected", paths: protectedPaths };
  }
  if (excludedPaths && excludedPaths.length > 0) {
    return { type: "excluded", paths: excludedPaths };
  }
  return { type: "full" };
}

/**
 * A request a browser made: it asked for HTML, and it is not the XHR an in-page script sends.
 * Everything else - an API client, a WebSocket handshake, curl - falls outside it.
 */
const BROWSER_REQUEST_MATCHER: Record<string, unknown> = {
  header: { Accept: ["*text/html*"] },
  // Caddy's `not` takes an array of matcher sets.
  not: [{ header: { "X-Requested-With": ["*"] } }],
};

function appendForwardAuthPathModeRoutes(options: {
  hostRoutes: CaddyHttpRoute[];
  domainGroups: string[][];
  authMode: PathAuthMode;
  baseHandlers: Record<string, unknown>[];
  authHandler: Record<string, unknown>;
  reverseProxyHandler: Record<string, unknown>;
  locationRules: LocationRuleMeta[];
  skipHttpsHostnameValidation: boolean;
  preserveHostHeader: boolean;
  preDomainRoute?: CaddyHttpRoute | null;
  protectedModePreRoutePlacement?: "before" | "after";
  /**
   * The authenticator for callers that are not browsers. Given one, every gated match is emitted
   * twice - a browser-only route carrying `authHandler`, then an unmatched fallback carrying this
   * one - so the two kinds of caller get the answer each can act on. Without it a single route
   * treats them alike.
   */
  apiAuthHandler?: Record<string, unknown> | null;
  /**
   * Header names whose presence skips authentication entirely: the upstream is expected to check
   * the credential itself. These routes come first, so they win over every gated one.
   */
  bypassHeaders?: string[];
}) {
  const {
    hostRoutes,
    domainGroups,
    authMode,
    baseHandlers,
    authHandler,
    reverseProxyHandler,
    locationRules,
    skipHttpsHostnameValidation,
    preserveHostHeader,
    preDomainRoute,
    protectedModePreRoutePlacement = "before",
    apiAuthHandler = null,
    bypassHeaders = [],
  } = options;

  /**
   * One gated match, as one route or as the browser/non-browser pair. The pair is ordered
   * browser-first: Caddy takes the first route that matches, and the fallback deliberately has no
   * matcher of its own beyond the match being gated.
   */
  const pushGatedRoutes = (matcher: Record<string, unknown>, proxy: Record<string, unknown>) => {
    if (!apiAuthHandler) {
      hostRoutes.push({
        match: [matcher],
        handle: [...baseHandlers, authHandler, proxy],
        terminal: true,
      });
      return;
    }
    hostRoutes.push({
      match: [{ ...matcher, ...BROWSER_REQUEST_MATCHER }],
      handle: [...baseHandlers, authHandler, proxy],
      terminal: true,
    });
    hostRoutes.push({
      match: [{ ...matcher }],
      handle: [...baseHandlers, apiAuthHandler, cloneJson(proxy)],
      terminal: true,
    });
  };

  for (const domainGroup of domainGroups) {
    // Before anything gated, including the pre-domain route: a caller holding the credential the
    // upstream checks must never be sent to the auth server at all.
    for (const bypassHeader of bypassHeaders) {
      hostRoutes.push({
        match: [{ host: domainGroup, header: { [bypassHeader]: ["*"] } }],
        handle: [...baseHandlers, cloneJson(reverseProxyHandler)],
        terminal: true,
      });
    }
    const pushPreDomainRoute = () => {
      if (preDomainRoute) {
        hostRoutes.push(attachHostToRoute(preDomainRoute, domainGroup));
      }
    };

    if (authMode.type === "protected") {
      if (protectedModePreRoutePlacement === "before") pushPreDomainRoute();

      for (const protectedPath of authMode.paths) {
        pushGatedRoutes(
          { host: domainGroup, path: [protectedPath] },
          cloneJson(reverseProxyHandler),
        );
      }

      if (protectedModePreRoutePlacement === "after") pushPreDomainRoute();

      // In whitelist mode, location rules and catch-all stay unprotected.
      appendLocationRoutes({
        hostRoutes,
        domainGroup,
        locationRules,
        skipHttpsHostnameValidation,
        preserveHostHeader,
        handlers: baseHandlers,
      });
      hostRoutes.push({
        match: [{ host: domainGroup }],
        handle: [...baseHandlers, reverseProxyHandler],
        terminal: true,
      });
      continue;
    }

    // Excluded and full-site modes share auth-protected location/catch-all.
    pushPreDomainRoute();

    if (authMode.type === "excluded") {
      for (const excludedPath of authMode.paths) {
        hostRoutes.push({
          match: [{ host: domainGroup, path: [excludedPath] }],
          handle: [...baseHandlers, cloneJson(reverseProxyHandler)],
          terminal: true,
        });
      }
    }

    if (apiAuthHandler) {
      // The same split, one location rule at a time: appendLocationRoutes emits a single route per
      // rule, and each of those needs its own browser and non-browser pair.
      for (const rule of locationRules) {
        const { safePath, reverseProxyHandler: locationProxy } = buildLocationReverseProxy(
          rule,
          skipHttpsHostnameValidation,
          preserveHostHeader,
        );
        if (!safePath) continue;
        pushGatedRoutes({ host: domainGroup, path: [safePath] }, locationProxy);
      }
    } else {
      appendLocationRoutes({
        hostRoutes,
        domainGroup,
        locationRules,
        skipHttpsHostnameValidation,
        preserveHostHeader,
        handlers: baseHandlers,
        extraHandlers: [authHandler],
      });
    }
    pushGatedRoutes({ host: domainGroup }, reverseProxyHandler);
  }
}

function appendMtlsPathModeRoutes(options: {
  hostRoutes: CaddyHttpRoute[];
  domainGroups: string[][];
  authMode: MtlsPathMode;
  locationRules: LocationRuleMeta[];
  handlers: Record<string, unknown>[];
  hostTrustedFingerprintExpression: string;
  skipHttpsHostnameValidation: boolean;
  preserveHostHeader: boolean;
  buildProtectedPathRoute: (domainGroup: string[], path: string) => CaddyHttpRoute[];
  buildExcludedPathRoute: (domainGroup: string[], path: string) => CaddyHttpRoute[];
  /** Excluded-paths mode: anything not excluded needs a trusted client cert. */
  buildProtectedCatchAll: (domainGroup: string[]) => CaddyHttpRoute[];
  /** Whitelist mode: only the listed paths are gated, so the catch-all stays open. */
  buildUnprotectedCatchAll: (domainGroup: string[]) => CaddyHttpRoute[];
  /** Full-site mode: RBAC subroutes when configured, otherwise an open catch-all. */
  buildDefaultCatchAll: (domainGroup: string[]) => CaddyHttpRoute[];
}) {
  const {
    hostRoutes,
    domainGroups,
    authMode,
    locationRules,
    handlers,
    hostTrustedFingerprintExpression,
    skipHttpsHostnameValidation,
    preserveHostHeader,
    buildProtectedPathRoute,
    buildExcludedPathRoute,
    buildProtectedCatchAll,
    buildUnprotectedCatchAll,
    buildDefaultCatchAll,
  } = options;

  for (const domainGroup of domainGroups) {
    if (authMode.type === "protected") {
      for (const protectedPath of authMode.paths) {
        hostRoutes.push(...buildProtectedPathRoute(domainGroup, protectedPath));
      }

      // Whitelist mode: only the explicitly listed paths require a certificate,
      // so location rules and the catch-all are left unprotected.
      appendLocationRoutes({
        hostRoutes,
        domainGroup,
        locationRules,
        skipHttpsHostnameValidation,
        preserveHostHeader,
        handlers,
      });

      hostRoutes.push(...buildUnprotectedCatchAll(domainGroup));
      continue;
    }

    if (authMode.type === "excluded") {
      for (const excludedPath of authMode.paths) {
        hostRoutes.push(...buildExcludedPathRoute(domainGroup, excludedPath));
      }

      // Everything outside the exclusion list is protected, location rules included:
      // an allow route gated on the trusted fingerprints, then a 403 for the rest.
      for (const rule of locationRules) {
        const { safePath, reverseProxyHandler: locationProxy } = buildLocationReverseProxy(
          rule,
          skipHttpsHostnameValidation,
          preserveHostHeader,
        );
        if (!safePath) continue;
        hostRoutes.push({
          match: [
            { host: domainGroup, path: [safePath], expression: hostTrustedFingerprintExpression },
          ],
          handle: [...handlers, locationProxy],
          terminal: true,
        });
        hostRoutes.push({
          match: [{ host: domainGroup, path: [safePath] }],
          handle: [{ handler: "static_response", status_code: "403", body: "mTLS access denied" }],
          terminal: true,
        });
      }

      hostRoutes.push(...buildProtectedCatchAll(domainGroup));
      continue;
    }

    // Full-site mode: no path carve-outs to enforce. Hosts with mTLS disabled land here too,
    // so nothing may be gated ahead of the catch-all - the catch-all (or its RBAC subroutes)
    // decides the requirement.
    appendLocationRoutes({
      hostRoutes,
      domainGroup,
      locationRules,
      skipHttpsHostnameValidation,
      preserveHostHeader,
      handlers,
    });

    hostRoutes.push(...buildDefaultCatchAll(domainGroup));
  }
}

/**
 * Routes, split by which listener serves them.
 *
 * A host on the tailnet is not the same host with an extra address: "tailnet only" means its
 * routes must not exist on the public server at all, so the split has to happen while each host is
 * being built rather than by filtering afterwards.
 */
type ProxyRouteSet = {
  /** Routes for the public :80/:443 server. */
  routes: CaddyHttpRoute[];
  /** Node name → routes served on that node's tailnet listener. */
  tailnetRoutes: Map<string, CaddyHttpRoute[]>;
  /** Every node any host names, whether it serves on it or only dials through it. */
  tailscaleNodes: Set<string>;
  errorRoutes: CaddyHttpRoute[];
};

async function buildProxyRoutes(context: CaddyBuildContext): Promise<ProxyRouteSet> {
  const { rows, accessLists, tlsReadyCertificates } = context;
  const routes: CaddyHttpRoute[] = [];
  const tailnetRoutes = new Map<string, CaddyHttpRoute[]>();
  const tailscaleNodes = new Set<string>();
  const errorRoutes: CaddyHttpRoute[] = [];
  const validClientCertExpression = buildValidClientCertCelExpression();

  // Hoisted out of the per-host loop: same answer for every host, and getting it wrong costs
  // the whole config.
  const geoblockUsable = isFeatureUsable(context.moduleAvailability, "geoblock");
  const wafUsable = isFeatureUsable(context.moduleAvailability, "waf");
  // Where a forward-auth host sends an unauthenticated visitor: the Public URL, so a value stored
  // by setup is honoured. Read once; every host's portal redirect is built from the same address.
  const portalBaseUrl = await getPublicBaseUrl();

  // Parsed once per row: the adapt pre-pass and the per-host loop both read it.
  const metaByRow = new Map<ProxyHostRow, ProxyHostMeta>();
  const metaOf = (row: ProxyHostRow): ProxyHostMeta => {
    let meta = metaByRow.get(row);
    if (!meta) {
      meta = parseJson<ProxyHostMeta>(row.meta, {});
      metaByRow.set(row, meta);
    }
    return meta;
  };

  // Adapt every host's snippet up front, concurrently: each adapt is an admin-API round trip on
  // every config apply, so the cost becomes the slowest rather than the sum. Not cached - a cache
  // outliving a rebuild would hand back routes for a module that is gone.
  const adaptedCaddyfiles = new Map<number, Awaited<ReturnType<typeof adaptCaddyfileSnippet>>>();
  await Promise.all(
    rows
      .filter((row) => row.enabled && metaOf(row).custom_caddyfile?.trim())
      .map(async (row) => {
        const snippet = metaOf(row).custom_caddyfile as string;
        try {
          // On the agent this document is for: adapted routes go into the config unmodified.
          adaptedCaddyfiles.set(row.id, await adaptCaddyfileSnippet(snippet, context.adaptVia));
        } catch (error) {
          // Left absent in the map; the loop below reports it per host.
          console.warn(
            `Skipping the custom Caddyfile for host "${row.name}" - Caddy could not adapt it:`,
            error instanceof Error ? error.message : error,
          );
        }
      }),
  );

  for (const row of rows) {
    if (!row.enabled) {
      continue;
    }

    // Allow hosts with certificateId = null (Caddy Auto) or with valid certificate IDs
    const isAutoManaged = !row.certificateId;
    const hasValidCertificate = row.certificateId && tlsReadyCertificates.has(row.certificateId);

    if (!isAutoManaged && !hasValidCertificate) {
      continue;
    }

    const domains = parseJson<string[]>(row.domains, []);
    if (domains.length === 0) {
      continue;
    }
    const domainGroups = groupHostPatternsByPriority(domains);

    // Require upstreams
    const upstreams = parseJson<string[]>(row.upstreams, []);
    if (upstreams.length === 0) {
      continue;
    }

    const handlers: Record<string, unknown>[] = [];
    const meta = metaOf(row);
    const tailscale = parseTailscaleConfig(meta.tailscale, context.tailscale ?? null);

    // The host was configured to exist only on the tailnet, and it cannot be: Tailscale is off in
    // settings, or the plugin is not in the running binary yet. Publishing it on the public
    // listener instead would expose a service deliberately kept private, so it is left out
    // entirely - the same fail-closed choice mTLS makes when its trust set resolves to nothing.
    if (!tailscale?.serve && meta.tailscale?.serve && meta.tailscale.tailnet_only) {
      console.warn(
        `Skipping proxy host "${row.name}": it is set to serve only on the tailnet, but Tailscale ` +
          "is not usable. Enable it in Settings → Network → Tailscale and make sure the Tailscale module is " +
          "in Settings → Caddy Build, then rebuild Caddy.",
      );
      continue;
    }
    if (tailscale?.upstreamNode) tailscaleNodes.add(tailscale.upstreamNode);

    const authentik = parseAuthentikConfig(meta.authentik);
    const forwardAuth = parseForwardAuthConfig(meta.forward_auth);
    const cpmForwardAuth = meta.cpm_forward_auth?.enabled ? meta.cpm_forward_auth : null;
    const locationRules = meta.location_rules ?? [];
    const hostRoutes: CaddyHttpRoute[] = [];

    const effectiveGeoBlock = resolveEffectiveGeoBlock(context.globalGeoBlock ?? null, {
      geoblock: meta.geoblock ?? null,
      geoblock_mode: meta.geoblock_mode ?? "merge",
    });
    if (effectiveGeoBlock?.enabled && geoblockUsable) {
      handlers.unshift(buildBlockerHandler(effectiveGeoBlock));
    }

    const effectiveWaf = resolveEffectiveWaf(context.globalWaf ?? null, meta.waf);
    if (effectiveWaf?.enabled && effectiveWaf.mode !== "Off" && wafUsable) {
      handlers.unshift(
        buildWafHandlerEntry(
          effectiveWaf,
          Boolean(row.allowWebsocket),
          context.wafPresets,
          context.crsPlugins,
        ),
      );
    }

    // Refused ahead of the WAF: coraza mangles an upgrade it wraps (see buildWafHandlerEntry).
    if (!row.allowWebsocket) {
      handlers.unshift({
        handler: "subroute",
        routes: WEBSOCKET_ATTEMPT_MATCHERS.map((matcher) => ({
          match: [matcher],
          handle: [{ handler: "static_response", status_code: 403 }],
        })),
      });
    }

    if (row.hstsEnabled) {
      const value = row.hstsSubdomains ? "max-age=63072000; includeSubDomains" : "max-age=63072000";
      handlers.push({
        handler: "headers",
        response: {
          set: {
            "Strict-Transport-Security": [value],
          },
        },
      });
    }

    if (row.sslForced) {
      for (const domainGroup of domainGroups) {
        hostRoutes.push({
          match: [
            {
              host: domainGroup,
              expression: '{http.request.scheme} == "http"',
            },
          ],
          handle: [
            {
              handler: "static_response",
              status_code: 308,
              headers: {
                Location: ["https://{http.request.host}{http.request.uri}"],
              },
            },
          ],
          terminal: true,
        });
      }
    }

    // Path blocks (terminal static_response) and rewrites (URI rewrite). Allows are not standalone
    // routes - a terminal match with an empty handle returns an empty 200 - so each allow pattern
    // is folded into every block's matcher as a `not` clause. Rewrites keep their own matchers.
    const pathAllows = meta.path_allows ?? [];
    const pathBlocks = meta.path_blocks ?? [];
    const pathRewrites = meta.path_rewrites ?? [];
    if (pathBlocks.length > 0 || pathRewrites.length > 0) {
      const allowPatterns = pathAllows
        .map((a) => stripCaddyPlaceholders(a.path))
        .filter((p) => p.length > 0);
      const pathRoutes: CaddyHttpRoute[] = [];
      for (const block of pathBlocks) {
        // Sanitize path to prevent Caddy placeholder injection
        const safePath = stripCaddyPlaceholders(block.path);
        if (!safePath) continue;
        const handle: Record<string, unknown> = {
          handler: "static_response",
          status_code: block.status,
        };
        if (block.body) {
          handle.body = block.body;
        }
        const matcher: Record<string, unknown> = { path: [safePath] };
        if (allowPatterns.length > 0) {
          matcher.not = [{ path: allowPatterns }];
        }
        pathRoutes.push({
          match: [matcher],
          handle: [handle],
          terminal: true,
        });
      }
      for (const rw of pathRewrites) {
        const safeFrom = stripCaddyPlaceholders(rw.from);
        const safeTo = stripCaddyPlaceholders(rw.to);
        if (!safeFrom || !safeTo) continue;
        pathRoutes.push({
          match: [{ path: [safeFrom] }],
          handle: [
            {
              handler: "rewrite",
              uri: safeTo,
            },
          ],
        });
      }
      if (pathRoutes.length > 0) {
        handlers.push({
          handler: "subroute",
          routes: pathRoutes,
        });
      }
    }

    // Structured redirects - emitted before auth so .well-known paths work without login
    if (meta.redirects && meta.redirects.length > 0) {
      handlers.push({
        handler: "subroute",
        routes: meta.redirects.map(buildRedirectRoute),
      });
    }

    // In the shared chain, so location rules, forward-auth path modes and mTLS subroutes all
    // inherit it - unless a location rule names a list of its own.
    const hostAccess = row.accessListId
      ? buildAccessListHandlers(accessLists.get(row.accessListId) ?? EMPTY_ACCESS_LIST)
      : [];
    const overridesAccess = (meta.location_rules ?? []).some(
      (rule) => rule.access_list_id !== undefined,
    );
    // A host with no list still needs a place in the chain for a location's own list to go.
    const accessSlot = hostAccess.length > 0 || !overridesAccess ? hostAccess : [ACCESS_SLOT()];
    for (const handler of accessSlot) HOST_ACCESS_HANDLERS.add(handler);
    handlers.push(...accessSlot);
    for (const rule of meta.location_rules ?? []) {
      if (rule.access_list_id === undefined) continue;
      LOCATION_ACCESS.set(
        rule,
        rule.access_list_id === null
          ? []
          : buildAccessListHandlers(accessLists.get(rule.access_list_id) ?? EMPTY_ACCESS_LIST),
      );
    }

    const lbConfig = parseLoadBalancerConfig(meta.load_balancer);
    const dnsConfig = parseDnsResolverConfig(meta.dns_resolver);
    const hostDnsResolutionConfig = parseUpstreamDnsResolutionConfig(meta.upstream_dns_resolution);
    // Pinning resolves the upstream here and writes the address into the config. Through a tailnet
    // node the name has to be resolved by MagicDNS on the other side, and this container's resolver
    // knows nothing about it - so the pin is skipped rather than baked in wrong.
    const effectiveDnsResolution = tailscale?.upstreamNode
      ? { enabled: false as const, family: "both" as const }
      : resolveEffectiveUpstreamDnsResolution(
          context.globalUpstreamDnsResolutionSettings,
          hostDnsResolutionConfig,
        );
    const resolvedUpstreams = await resolveUpstreamDials(
      row,
      upstreams,
      dnsConfig,
      context.globalDnsSettings,
      effectiveDnsResolution,
    );

    const reverseProxyHandler: Record<string, unknown> = {
      handler: "reverse_proxy",
      upstreams: resolvedUpstreams.upstreams,
    };

    // Authentik outpost handler will be added later after protected paths
    let outpostRoute: CaddyHttpRoute | null = null;
    if (authentik) {
      // Parse the outpost upstream URL to extract host:port for Caddy's dial field
      let outpostDial: string;
      try {
        const url = new URL(authentik.outpostUpstream);
        const port = url.port || (url.protocol === "https:" ? "443" : "80");
        outpostDial = `${url.hostname}:${port}`;
      } catch {
        // If URL parsing fails, try to extract host:port from string
        outpostDial = authentik.outpostUpstream.replace(/^https?:\/\//, "").replace(/\/$/, "");
      }

      const outpostHandler: Record<string, unknown> = {
        handler: "reverse_proxy",
        upstreams: [
          {
            dial: outpostDial,
          },
        ],
      };

      if (authentik.setOutpostHostHeader) {
        outpostHandler.headers = {
          request: {
            set: {
              Host: ["{http.reverse_proxy.upstream.host}"],
            },
          },
        };
      }

      // Sanitize outpostDomain to prevent path traversal and placeholder injection
      const safeOutpostPath = stripCaddyPlaceholders(
        authentik.outpostDomain.replace(/\.\./g, ""),
      ).replace(/\/+/g, "/");

      outpostRoute = {
        match: [
          {
            path: [`/${safeOutpostPath}/*`],
          },
        ],
        handle: [outpostHandler],
        terminal: true,
      };
    }

    if (row.preserveHostHeader) {
      reverseProxyHandler.headers = {
        request: {
          set: {
            Host: ["{http.request.host}"],
          },
        },
      };
    }

    // Configure TLS transport for HTTPS upstreams
    if (resolvedUpstreams.hasHttpsUpstream) {
      const tlsTransport: Record<string, unknown> = row.skipHttpsHostnameValidation
        ? {
            insecure_skip_verify: true,
          }
        : {};
      if (resolvedUpstreams.httpsTlsServerName) {
        tlsTransport.server_name = resolvedUpstreams.httpsTlsServerName;
      }

      reverseProxyHandler.transport = {
        protocol: "http",
        tls: tlsTransport,
      };
    }

    // Configure load balancing and health checks. Counted against the *resolved* upstreams, since
    // DNS pinning can expand one hostname into several dials and the weights must match what ships.
    if (lbConfig) {
      const loadBalancing = buildLoadBalancingConfig(lbConfig, resolvedUpstreams.upstreams.length);
      if (loadBalancing) {
        reverseProxyHandler.load_balancing = loadBalancing;
      }
      const healthChecks = buildHealthChecksConfig(lbConfig);
      if (healthChecks) {
        reverseProxyHandler.health_checks = healthChecks;
      }
    }

    // Add transport-level DNS resolver config if enabled
    if (dnsConfig?.enabled && dnsConfig.resolvers.length > 0) {
      const resolverConfig = buildResolverConfig(dnsConfig);
      if (resolverConfig) {
        // Merge resolver into existing transport (preserving TLS settings for HTTPS upstreams)
        if (reverseProxyHandler.transport) {
          (reverseProxyHandler.transport as Record<string, unknown>).resolver = resolverConfig;
          if (dnsConfig.timeout) {
            (reverseProxyHandler.transport as Record<string, unknown>).dial_timeout =
              dnsConfig.timeout;
          }
        } else {
          // No existing transport, create one with resolver
          reverseProxyHandler.transport = {
            protocol: "http",
            resolver: resolverConfig,
            ...(dnsConfig.timeout ? { dial_timeout: dnsConfig.timeout } : {}),
          };
        }
      }
    }

    // Dial the upstreams through a tailnet node. This replaces the http transport rather than
    // extending it: the plugin's transport brings its own dialer and understands only `tls`, so a
    // resolver or dial timeout meant for the http one would be an unknown field and Caddy would
    // reject the whole document. The TLS config carries over untouched, since the plugin treats any
    // non-nil value as "speak https" and reads nothing out of it.
    if (tailscale?.upstreamNode) {
      const httpTransport = reverseProxyHandler.transport as Record<string, unknown> | undefined;
      if (httpTransport?.resolver) {
        console.warn(
          `Ignoring the DNS resolver on host "${row.name}": its upstreams are dialled through the ` +
            `Tailscale node "${tailscale.upstreamNode}", which resolves names on the tailnet itself.`,
        );
      }
      reverseProxyHandler.transport = buildTailscaleTransport(
        tailscale.upstreamNode,
        (httpTransport?.tls as Record<string, unknown> | undefined) ?? null,
      );
    }

    // Security: arbitrary reverse_proxy config, by design. Only an admin can set it - enforced by
    // assertRawConfigChangeAllowed in models/proxy-hosts.ts, which every write path goes through.
    // mergeDeep blocks __proto__/constructor/prototype, so prototype pollution is not reachable.
    const customReverseProxy = parseOptionalJson(meta.custom_reverse_proxy_json);
    if (customReverseProxy) {
      if (isPlainObject(customReverseProxy)) {
        mergeDeep(reverseProxyHandler, customReverseProxy as Record<string, unknown>);
      } else {
        console.warn(
          "Ignoring custom reverse proxy JSON because it is not an object",
          customReverseProxy,
        );
      }
    }

    // Structured path prefix rewrite
    // Sanitize path_prefix to prevent Caddy placeholder injection
    if (meta.rewrite?.path_prefix) {
      const safePrefix = stripCaddyPlaceholders(meta.rewrite.path_prefix);
      if (safePrefix) {
        handlers.push({
          handler: "rewrite",
          uri: `${safePrefix}{http.request.uri}`,
        });
      }
    }

    // Security: arbitrary HTTP handlers before the reverse_proxy (file_server, rewrite, ...), by
    // design. Admin-only, like the Caddyfile below - see assertRawConfigChangeAllowed.
    const customHandlers = parseCustomHandlers(meta.custom_pre_handlers_json);
    if (customHandlers.length > 0) {
      handlers.push(...customHandlers);
    }

    // Per-host Caddyfile directives, adapted by the running Caddy binary. A snippet that no longer
    // adapts (usually a plugin switched off in Settings) is skipped with a warning: failing here
    // would take every other host down, and block the edit needed to fix it.
    const adapted = adaptedCaddyfiles.get(row.id);
    if (adapted) {
      for (const warning of adapted.warnings) {
        console.warn(`Caddyfile warning for host "${row.name}": ${warning}`);
      }
      if (adapted.ignoredApps.length > 0) {
        console.warn(
          `Ignoring non-HTTP directives in the Caddyfile for host "${row.name}": ${adapted.ignoredApps.join(", ")}`,
        );
      }
      const subroute = buildCaddyfileSubrouteHandler(adapted.routes);
      if (subroute) {
        handlers.push(subroute);
      }
    }

    if (authentik) {
      // Build handle_response routes for copying headers on 2xx status
      const handleResponseRoutes: Record<string, unknown>[] = [
        {
          handle: [{ handler: "vars" }],
        },
      ];

      // Add header copying for each configured header. The name is canonicalised because the
      // placeholder that reads the value back is matched literally against Go's canonical
      // header key - see upstreamHeaderPlaceholder.
      for (const rawHeaderName of authentik.copyHeaders) {
        const headerName = canonicalHeaderName(rawHeaderName);
        const placeholder = upstreamHeaderPlaceholder(headerName);
        handleResponseRoutes.push({
          handle: [
            {
              handler: "headers",
              request: {
                set: {
                  [headerName]: [placeholder],
                },
              },
            } as Record<string, unknown>,
          ],
          match: [
            {
              not: [
                {
                  vars: {
                    [placeholder]: [""],
                  },
                },
              ],
            },
          ],
        });
      }

      // Create the forward auth reverse_proxy handler
      // Convert "private_ranges" to actual CIDR blocks for JSON config
      const trustedProxies = expandPrivateRanges(authentik.trustedProxies);

      // Parse the outpost upstream into host:port for dial, dropping scheme and slashes
      let dialAddress = authentik.outpostUpstream.replace(/^https?:\/\//, "").replace(/\/$/, "");
      // Remove any path portion if accidentally included
      dialAddress = dialAddress.split("/")[0];

      const forwardAuthHandler: Record<string, unknown> = {
        handler: "reverse_proxy",
        upstreams: [
          {
            dial: dialAddress,
          },
        ],
        rewrite: {
          method: "GET",
          uri: authentik.authEndpoint,
        },
        headers: {
          request: {
            set: {
              "X-Forwarded-Method": ["{http.request.method}"],
              "X-Forwarded-Uri": ["{http.request.uri}"],
            },
          },
        },
        handle_response: [
          {
            match: {
              status_code: [2],
            },
            routes: handleResponseRoutes,
          },
        ],
      };

      if (trustedProxies.length > 0) {
        forwardAuthHandler.trusted_proxies = trustedProxies;
      }

      const authMode = resolvePathAuthMode(authentik.protectedPaths, authentik.excludedPaths);

      appendForwardAuthPathModeRoutes({
        hostRoutes,
        domainGroups,
        authMode,
        baseHandlers: handlers,
        authHandler: forwardAuthHandler,
        reverseProxyHandler,
        locationRules,
        skipHttpsHostnameValidation: Boolean(row.skipHttpsHostnameValidation),
        preserveHostHeader: Boolean(row.preserveHostHeader),
        preDomainRoute: outpostRoute,
        protectedModePreRoutePlacement: "after",
      });
    } else if (forwardAuth) {
      // ── Generic forward auth ─────────────────────────────────────────
      // An auth server this app does not run: Authelia, tinyauth, anything that answers a
      // forward-auth subrequest. Second of the mutually exclusive integrations, so a host that
      // configured Authentik never reaches here.
      //
      // The strip handler goes on the shared chain, so it runs on excluded and whitelisted paths
      // too. Those authenticate nothing, and the copy step only overwrites a header when the auth
      // server answered with a value - without the strip, a caller could set Remote-User itself
      // and the upstream could not tell the difference. Same reasoning as the X-Cpm-* strip below.
      const forwardAuthHandlers =
        forwardAuth.copyHeaders.length > 0
          ? [
              {
                handler: "headers",
                request: { delete: [...forwardAuth.copyHeaders] },
              } as Record<string, unknown>,
              ...handlers,
            ]
          : handlers;

      appendForwardAuthPathModeRoutes({
        hostRoutes,
        domainGroups,
        authMode: resolvePathAuthMode(forwardAuth.protectedPaths, forwardAuth.excludedPaths),
        baseHandlers: forwardAuthHandlers,
        authHandler: buildGenericForwardAuthHandler(forwardAuth, false),
        apiAuthHandler: forwardAuth.apiSplit
          ? buildGenericForwardAuthHandler(forwardAuth, true)
          : null,
        bypassHeaders: forwardAuth.apiBypassHeaders,
        reverseProxyHandler,
        locationRules,
        skipHttpsHostnameValidation: Boolean(row.skipHttpsHostnameValidation),
        preserveHostHeader: Boolean(row.preserveHostHeader),
      });
    } else if (cpmForwardAuth) {
      // ── CPM Forward Auth ────────────────────────────────────────────
      // Uses CPM itself as the auth provider (replaces Authentik)
      const cpmDialAddress = getCpmDialAddress();
      if (cpmDialAddress) {
        const cpmProxyProof = getForwardAuthProxyProof();
        // Canonical (Go MIME) casing is required, not cosmetic: Caddy resolves
        // `{http.reverse_proxy.header.<name>}` by literal lookup in Go's canonicalised map, so
        // "X-CPM-User" resolves to nothing and every upstream sees an anonymous request.
        const CPM_COPY_HEADERS = ["X-Cpm-User", "X-Cpm-Email", "X-Cpm-Groups", "X-Cpm-User-Id"];

        // Security: strip client-supplied CPM identity headers inbound - CPM sets these only from
        // the verify response, so accepting them lets a caller spoof identity. Must run on EVERY
        // route: unauthenticated ones have nothing else to remove them, and the copy step below
        // only overwrites when the verify value is non-empty.
        const cpmStripHeadersHandler: Record<string, unknown> = {
          handler: "headers",
          request: {
            delete: [...CPM_COPY_HEADERS],
          },
        };
        // Prepend the strip handler to the shared chain for all CPM forward-auth routes.
        const cpmHandlers = [cpmStripHeadersHandler, ...handlers];

        // Build handle_response routes for copying user headers on 2xx
        const cpmHandleResponseRoutes: Record<string, unknown>[] = [
          { handle: [{ handler: "vars" }] },
        ];
        for (const headerName of CPM_COPY_HEADERS) {
          const placeholder = upstreamHeaderPlaceholder(headerName);
          cpmHandleResponseRoutes.push({
            handle: [
              {
                handler: "headers",
                request: {
                  set: { [headerName]: [placeholder] },
                },
              } as Record<string, unknown>,
            ],
            match: [
              {
                not: [{ vars: { [placeholder]: [""] } }],
              },
            ],
          });
        }

        // Forward auth handler - subrequest to CPM verify endpoint
        const cpmForwardAuthHandler: Record<string, unknown> = {
          handler: "reverse_proxy",
          upstreams: [{ dial: cpmDialAddress }],
          rewrite: {
            method: "GET",
            uri: "/api/forward-auth/verify",
          },
          headers: {
            request: {
              set: {
                "X-Forwarded-Method": ["{http.request.method}"],
                "X-Forwarded-Uri": ["{http.request.uri}"],
                "X-Forwarded-Host": ["{http.request.hostport}"],
                "X-Forwarded-Proto": ["{http.request.scheme}"],
                [FORWARD_AUTH_PROXY_PROOF_HEADER]: [cpmProxyProof],
              },
            },
          },
          handle_response: [
            {
              match: { status_code: [2] },
              routes: cpmHandleResponseRoutes,
            },
            {
              match: { status_code: [401, 403] },
              routes: [
                {
                  handle: [
                    {
                      handler: "static_response",
                      status_code: 302,
                      headers: {
                        Location: [
                          `${portalBaseUrl}/portal?rd={http.request.scheme}://{http.request.hostport}{http.request.uri}`,
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          ],
          trusted_proxies: [
            "10.0.0.0/8",
            "172.16.0.0/12",
            "192.168.0.0/16",
            "127.0.0.0/8",
            "fd00::/8",
            "::1/128",
          ],
        };

        // Callback route - unprotected, so it goes before forward_auth
        const cpmCallbackRoute: CaddyHttpRoute = {
          match: [{ path: ["/.cpm-auth/callback"] }],
          handle: [
            {
              handler: "reverse_proxy",
              upstreams: [{ dial: cpmDialAddress }],
              rewrite: {
                uri: "/api/forward-auth/callback?{http.request.uri.query}",
              },
              headers: {
                request: {
                  set: {
                    "X-Forwarded-Host": ["{http.request.hostport}"],
                    "X-Forwarded-Proto": ["{http.request.scheme}"],
                    [FORWARD_AUTH_PROXY_PROOF_HEADER]: [cpmProxyProof],
                  },
                },
              },
            },
          ],
          terminal: true,
        };

        const locationRules = meta.location_rules ?? [];
        const authMode = resolvePathAuthMode(
          cpmForwardAuth.protected_paths,
          cpmForwardAuth.excluded_paths,
        );

        appendForwardAuthPathModeRoutes({
          hostRoutes,
          domainGroups,
          authMode,
          baseHandlers: cpmHandlers,
          authHandler: cpmForwardAuthHandler,
          reverseProxyHandler,
          locationRules,
          skipHttpsHostnameValidation: Boolean(row.skipHttpsHostnameValidation),
          preserveHostHeader: Boolean(row.preserveHostHeader),
          preDomainRoute: cpmCallbackRoute,
          protectedModePreRoutePlacement: "before",
        });
      }
    } else if (tailscale?.auth) {
      // ── Tailscale identity ──────────────────────────────────────────
      // Third and last of the mutually exclusive auth integrations: a host configured for
      // Authentik or CPM forward auth never reaches here, because two of them in one chain would
      // ask the caller to sign in twice.
      //
      // The strip handler goes on the shared chain rather than beside the authenticator, so it
      // runs on excluded and whitelisted paths too - those authenticate nothing, and without it a
      // caller could set X-Tailscale-User themselves and the upstream could not tell the
      // difference. Setting the headers stays inside the auth subroute, where a user exists.
      const tailscaleHandlers = tailscale.forwardIdentity
        ? [buildTailscaleIdentityStripHandler(), ...handlers]
        : handlers;

      appendForwardAuthPathModeRoutes({
        hostRoutes,
        domainGroups,
        authMode: resolvePathAuthMode(tailscale.protectedPaths, tailscale.excludedPaths),
        baseHandlers: tailscaleHandlers,
        authHandler: buildTailscaleAuthSubroute(tailscale.forwardIdentity),
        reverseProxyHandler,
        locationRules,
        skipHttpsHostnameValidation: Boolean(row.skipHttpsHostnameValidation),
        preserveHostHeader: Boolean(row.preserveHostHeader),
      });
    } else {
      const mtls = meta.mtls?.enabled ? meta.mtls : null;
      const mtlsProtectedPaths = mtls?.protected_paths?.length ? mtls.protected_paths : null;
      const mtlsExcludedPaths = mtls?.excluded_paths?.length ? mtls.excluded_paths : null;
      const mtlsPathMode = resolveMtlsPathMode(mtlsProtectedPaths, mtlsExcludedPaths);

      const hostAccessRules = context.mtlsRbac?.accessRulesByHost.get(row.id);
      const hasMtlsRbac =
        hostAccessRules &&
        hostAccessRules.length > 0 &&
        context.mtlsRbac?.roleFingerprintMap &&
        context.mtlsRbac?.certFingerprintMap;
      const hostTrustedFingerprints = mtls
        ? resolveAllowedFingerprints(
            {
              pathPattern: "*",
              allowedRoleIds: mtls.trusted_role_ids ?? [],
              allowedCertIds: mtls.trusted_client_cert_ids ?? [],
              denyAll: false,
            },
            context.mtlsRbac?.roleFingerprintMap ?? new Map(),
            context.mtlsRbac?.certFingerprintMap ?? new Map(),
          )
        : new Set<string>();
      // Path-scoped hosts cannot pin leaves at the TLS layer (see buildClientAuthentication), so a
      // legacy whole-CA host pins here instead. Null means any cert the TLS layer verified.
      const hostGateFingerprints: Set<string> | null =
        hostTrustedFingerprints.size > 0
          ? hostTrustedFingerprints
          : mtls?.ca_certificate_ids?.length
            ? resolveLegacyCaFingerprints(
                mtls.ca_certificate_ids,
                context.mtlsRbac?.caFingerprintMap ?? new Map(),
                context.mtlsRbac?.managedCaIds ?? new Set(),
              )
            : null;
      const hostTrustedFingerprintExpression = hostGateFingerprints
        ? buildFingerprintCelExpression(hostGateFingerprints)
        : validClientCertExpression;

      const buildProtectedPathRoute = (domainGroup: string[], path: string) => {
        if (hasMtlsRbac) {
          const rbacSubroutes = buildMtlsRbacSubroutes(
            hostAccessRules,
            context.mtlsRbac!.roleFingerprintMap,
            context.mtlsRbac!.certFingerprintMap,
            handlers,
            reverseProxyHandler,
            true,
            hostGateFingerprints ?? undefined,
          );
          if (rbacSubroutes) {
            return [
              {
                match: [{ host: domainGroup, path: [path] }],
                handle: [{ handler: "subroute", routes: rbacSubroutes }],
                terminal: true,
              },
            ];
          }
        }

        return [
          {
            match: [
              { host: domainGroup, path: [path], expression: hostTrustedFingerprintExpression },
            ],
            handle: [...handlers, cloneJson(reverseProxyHandler)],
            terminal: true,
          },
          {
            match: [{ host: domainGroup, path: [path] }],
            handle: [
              { handler: "static_response", status_code: "403", body: "mTLS access denied" },
            ],
            terminal: true,
          },
        ];
      };

      const buildExcludedPathRoute = (domainGroup: string[], path: string) => [
        {
          match: [{ host: domainGroup, path: [path] }],
          handle: [...handlers, cloneJson(reverseProxyHandler)],
          terminal: true,
        },
      ];

      const buildProtectedCatchAll = (domainGroup: string[]) => {
        if (hasMtlsRbac) {
          const rbacSubroutes = buildMtlsRbacSubroutes(
            hostAccessRules,
            context.mtlsRbac!.roleFingerprintMap,
            context.mtlsRbac!.certFingerprintMap,
            handlers,
            reverseProxyHandler,
            true,
            hostGateFingerprints ?? undefined,
          );
          if (rbacSubroutes) {
            return [
              {
                match: [{ host: domainGroup }],
                handle: [{ handler: "subroute", routes: rbacSubroutes }],
                terminal: true,
              },
            ];
          }
        }

        return [
          {
            match: [{ host: domainGroup, expression: hostTrustedFingerprintExpression }],
            handle: [...handlers, reverseProxyHandler],
            terminal: true,
          },
          {
            match: [{ host: domainGroup }],
            handle: [
              { handler: "static_response", status_code: "403", body: "mTLS access denied" },
            ],
            terminal: true,
          },
        ];
      };

      // Open catch-all: no client certificate required. Used by whitelist mode (only listed
      // paths are gated) and as the full-site fallback.
      const buildUnprotectedCatchAll = (domainGroup: string[]): CaddyHttpRoute[] => [
        {
          match: [{ host: domainGroup }],
          handle: [...handlers, reverseProxyHandler],
          terminal: true,
        },
      ];

      // Full-site mode. RBAC rules, when present, carry their own per-path allow/deny, and
      // requireValidClientCertByDefault stays false so unruled paths are proxied rather than
      // denied. With no RBAC rules - including hosts with mTLS off entirely - the host is open.
      const buildDefaultCatchAll = (domainGroup: string[]): CaddyHttpRoute[] => {
        if (hasMtlsRbac) {
          const rbacSubroutes = buildMtlsRbacSubroutes(
            hostAccessRules,
            context.mtlsRbac!.roleFingerprintMap,
            context.mtlsRbac!.certFingerprintMap,
            handlers,
            reverseProxyHandler,
          );
          if (rbacSubroutes) {
            return [
              {
                match: [{ host: domainGroup }],
                handle: [{ handler: "subroute", routes: rbacSubroutes }],
                terminal: true,
              },
            ];
          }
        }

        return buildUnprotectedCatchAll(domainGroup);
      };

      appendMtlsPathModeRoutes({
        hostRoutes,
        domainGroups,
        authMode: mtlsPathMode,
        locationRules,
        handlers,
        hostTrustedFingerprintExpression,
        skipHttpsHostnameValidation: Boolean(row.skipHttpsHostnameValidation),
        preserveHostHeader: Boolean(row.preserveHostHeader),
        buildProtectedPathRoute,
        buildExcludedPathRoute,
        buildProtectedCatchAll,
        buildUnprotectedCatchAll,
        buildDefaultCatchAll,
      });
    }

    if (tailscale?.serve) {
      tailscaleNodes.add(tailscale.node);
      const nodeRoutes = tailnetRoutes.get(tailscale.node) ?? [];
      nodeRoutes.push(...hostRoutes);
      tailnetRoutes.set(tailscale.node, nodeRoutes);
    }
    // The same route objects go into both servers when the host is published on the tailnet *and*
    // publicly; JSON.stringify writes a shared reference out twice, so no clone is needed.
    if (!tailscale?.tailnetOnly) {
      routes.push(...hostRoutes);
    }

    // Per-host error pages, scoped to this host's domains. Collected separately so
    // they can be attached to the server-level `errors` block (handle_errors).
    if (meta.error_pages && meta.error_pages.length > 0) {
      for (const rule of meta.error_pages) {
        errorRoutes.push(buildErrorPageRoute(rule, domains));
      }
    }
  }

  return {
    routes: sortRoutesByHostPriority(routes),
    tailnetRoutes: new Map(
      Array.from(tailnetRoutes, ([node, nodeRoutes]) => [
        node,
        sortRoutesByHostPriority(nodeRoutes),
      ]),
    ),
    tailscaleNodes,
    errorRoutes,
  };
}

type TlsConnectionPolicyContext = {
  usage: Map<number, CertificateUsage>;
  managedCertificatesWithAutomation: Set<number>;
  autoManagedDomains: Set<string>;
  mTlsDomainMap: Map<string, number[]>;
  caCertMap: Map<number, { id: number; certificatePem: string }>;
  issuedClientCertMap: Map<number, string[]>;
  cAsWithAnyIssuedCerts: Set<number>;
  mTlsDomainLeafOverride: Map<string, string[]>;
  mTlsOptionalAuthDomains: Set<string>;
};

function buildTlsConnectionPolicies(context: TlsConnectionPolicyContext) {
  const {
    usage,
    managedCertificatesWithAutomation,
    autoManagedDomains,
    mTlsDomainMap,
    caCertMap,
    issuedClientCertMap,
    cAsWithAnyIssuedCerts,
    mTlsDomainLeafOverride,
    mTlsOptionalAuthDomains,
  } = context;
  const policies: Record<string, unknown>[] = [];
  const readyCertificates = new Set<number>();
  const importedCertPems: { certificate: string; key: string }[] = [];

  const buildAuth = (domains: string[], mode: "require_and_verify" | "verify_if_given") =>
    buildClientAuthentication(
      domains,
      mTlsDomainMap,
      caCertMap,
      issuedClientCertMap,
      cAsWithAnyIssuedCerts,
      mTlsDomainLeafOverride,
      mode,
    );

  /** One TLS policy per unique CA set, so a CA_B cert cannot authenticate against a CA_A host. */
  const pushMtlsPolicies = (mTlsDomains: string[]) => {
    const scopedDomains = mTlsDomains.filter((domain) => mTlsOptionalAuthDomains.has(domain));
    const requiredDomains = mTlsDomains.filter((domain) => !mTlsOptionalAuthDomains.has(domain));

    // Scoped hosts must let cert-less requests reach the HTTP path gate, but "request" mode verifies
    // nothing - any self-signed or expired cert got through. verify_if_given checks what is shown.
    for (const [domains, mode] of [
      [requiredDomains, "require_and_verify"],
      [scopedDomains, "verify_if_given"],
    ] as const) {
      if (domains.length === 0) continue;

      const groups = groupMtlsDomainsByCaSet(domains, mTlsDomainMap);
      for (const domainGroup of groups.values()) {
        for (const priorityGroup of groupHostPatternsByPriority(domainGroup)) {
          const mTlsAuth = buildAuth(priorityGroup, mode);
          if (mTlsAuth) {
            policies.push({ match: { sni: priorityGroup }, client_authentication: mTlsAuth });
          } else {
            // All CAs have all certs revoked - drop connections rather than allow through without mTLS
            policies.push({ match: { sni: priorityGroup }, drop: true });
          }
        }
      }
    }
  };

  // Add policy for auto-managed domains (certificateId = null)
  if (autoManagedDomains.size > 0) {
    const domains = Array.from(autoManagedDomains);
    // Split first so mTLS domains always get their own policy, regardless of auth result.
    const mTlsDomains = domains.filter((d) => mTlsDomainMap.has(d));
    const nonMTlsDomains = domains.filter((d) => !mTlsDomainMap.has(d));

    if (mTlsDomains.length > 0) {
      pushMtlsPolicies(mTlsDomains);
    }
    for (const priorityGroup of groupHostPatternsByPriority(nonMTlsDomains)) {
      policies.push({ match: { sni: priorityGroup } });
    }
  }

  for (const [id, entry] of usage.entries()) {
    const domains = Array.from(entry.domains);
    if (domains.length === 0) {
      continue;
    }

    if (entry.certificate.type === "imported") {
      if (!entry.certificate.certificatePem || !entry.certificate.privateKeyPem) {
        continue;
      }

      // Collect PEMs for tls.certificates.load_pem (inline, no shared filesystem needed)
      importedCertPems.push({
        certificate: entry.certificate.certificatePem.trim(),
        key: entry.certificate.privateKeyPem.trim(),
      });

      const mTlsDomains = domains.filter((d) => mTlsDomainMap.has(d));
      const nonMTlsDomains = domains.filter((d) => !mTlsDomainMap.has(d));

      if (mTlsDomains.length > 0) {
        pushMtlsPolicies(mTlsDomains);
      }
      for (const priorityGroup of groupHostPatternsByPriority(nonMTlsDomains)) {
        policies.push({ match: { sni: priorityGroup } });
      }

      readyCertificates.add(id);
      continue;
    }

    if (entry.certificate.type === "managed") {
      if (!managedCertificatesWithAutomation.has(id)) {
        continue;
      }

      const mTlsDomains = domains.filter((d) => mTlsDomainMap.has(d));
      const nonMTlsDomains = domains.filter((d) => !mTlsDomainMap.has(d));

      if (mTlsDomains.length > 0) {
        pushMtlsPolicies(mTlsDomains);
      }
      for (const priorityGroup of groupHostPatternsByPriority(nonMTlsDomains)) {
        policies.push({ match: { sni: priorityGroup } });
      }

      readyCertificates.add(id);
    }
  }

  return {
    policies: sortTlsPoliciesBySniPriority(policies),
    readyCertificates,
    importedCertPems,
  };
}

type TlsAutomationContext = {
  usage: Map<number, CertificateUsage>;
  autoManagedDomains: Set<string>;
  options: {
    acmeEmail?: string;
    dnsSettings?: DnsSettings | null;
    dnsProviderSettings?: DnsProviderSettings | null;
    acmeSettings?: AcmeSettings | null;
    /**
     * Omitted means "do not gate" - callers exercising only ACME policy shapes have no module
     * selection. buildCaddyDocument always passes it, so the real config path is always gated.
     */
    moduleAvailability?: CaddyModuleAvailability;
  };
};

export async function buildTlsAutomation(
  usageOrContext: Map<number, CertificateUsage> | TlsAutomationContext,
  autoManagedDomainsOrOptions?:
    | Set<string>
    | {
        acmeEmail?: string;
        dnsSettings?: DnsSettings | null;
        dnsProviderSettings?: DnsProviderSettings | null;
        acmeSettings?: AcmeSettings | null;
        moduleAvailability?: CaddyModuleAvailability;
      },
  maybeOptions?: {
    acmeEmail?: string;
    dnsSettings?: DnsSettings | null;
    dnsProviderSettings?: DnsProviderSettings | null;
    acmeSettings?: AcmeSettings | null;
    moduleAvailability?: CaddyModuleAvailability;
  },
): Promise<{
  tlsApp?: { automation: { policies: Record<string, unknown>[] } };
  managedCertificateIds: Set<number>;
}> {
  const usage = usageOrContext instanceof Map ? usageOrContext : usageOrContext.usage;
  const autoManagedDomains =
    usageOrContext instanceof Map
      ? autoManagedDomainsOrOptions instanceof Set
        ? autoManagedDomainsOrOptions
        : new Set<string>()
      : usageOrContext.autoManagedDomains;
  const options =
    usageOrContext instanceof Map
      ? autoManagedDomainsOrOptions && !(autoManagedDomainsOrOptions instanceof Set)
        ? autoManagedDomainsOrOptions
        : (maybeOptions ?? {})
      : {
          ...(usageOrContext as TlsAutomationContext).options,
          ...(maybeOptions ?? {}),
        };

  const managedEntries = Array.from(usage.values()).filter(
    (entry) => entry.certificate.type === "managed" && Boolean(entry.certificate.autoRenew),
  );

  const hasAutoManagedDomains = autoManagedDomains.size > 0;

  if (managedEntries.length === 0 && !hasAutoManagedDomains) {
    return {
      managedCertificateIds: new Set<number>(),
      tlsApp: undefined,
    };
  }

  const dnsProviderSettings = options.dnsProviderSettings;
  const globalDnsProvider: DnsProviderCredentials | null =
    dnsProviderSettings?.default && dnsProviderSettings.providers[dnsProviderSettings.default]
      ? {
          provider: dnsProviderSettings.default,
          credentials: dnsProviderSettings.providers[dnsProviderSettings.default],
        }
      : null;

  const dnsSettings = options.dnsSettings;
  // Primary resolvers first, then fallbacks, so DNS-01 validation still has somewhere to go
  // when the primary is unreachable.
  const dnsResolvers: string[] = [];
  if (
    dnsSettings?.enabled &&
    Array.isArray(dnsSettings.resolvers) &&
    dnsSettings.resolvers.length > 0
  ) {
    dnsResolvers.push(...dnsSettings.resolvers);
    if (dnsSettings.fallbacks && dnsSettings.fallbacks.length > 0) {
      dnsResolvers.push(...dnsSettings.fallbacks);
    }
  }

  /**
   * A DNS-01 challenge names its provider module, so an uncompiled caddy-dns plugin is unusable.
   * Dropping just `challenges.dns` degrades to HTTP-01 (wildcards fail) rather than having Caddy
   * reject the whole config.
   */
  const dnsProviderAllowed = (providerName: string): boolean => {
    const availability = options.moduleAvailability;
    if (!availability) return true;
    if (isDnsProviderUsable(availability, providerName)) return true;
    console.warn(
      `Skipping the ACME DNS-01 challenge for "${providerName}": its Caddy DNS module is not ` +
        "enabled in Settings → Caddy Build, or the caddy image has not been rebuilt with it yet.",
    );
    return false;
  };

  const policies: Record<string, unknown>[] = [];
  const managedCertificateIds = new Set<number>();

  /**
   * Send `.ts.net` subjects to Caddy's own Tailscale certificate manager and return the rest.
   *
   * A MagicDNS name resolves only inside a tailnet, so no public CA can validate one and an ACME
   * policy over it retries forever. Caddy provisions no issuer for a policy whose subjects are all
   * `.ts.net` and whose managers include this one, which is why the two never share a policy.
   */
  const takeTailscaleSubjects = (subjects: string[]): string[] => {
    const tailscaleSubjects = subjects.filter(isTailscaleDomain);
    if (tailscaleSubjects.length > 0) {
      policies.push(buildTailscaleAutomationPolicy(tailscaleSubjects));
    }
    return subjects.filter((subject) => !isTailscaleDomain(subject));
  };

  // Custom ACME directory URL + trusted root for internal CAs (OpenBao, Step-CA, etc.).
  // Resolved once per build: syncAcmeCaRootFile touches the filesystem, and the result applies
  // to every issuer across every subject group.
  const customAcmeUrl = (options.acmeSettings?.caUrl ?? "").trim();
  const acmeRootPath = syncAcmeCaRootFile(options.acmeSettings?.caRootPem);

  const applyAcmeOverrides = (issuer: Record<string, unknown>) => {
    if (customAcmeUrl) {
      issuer.ca = customAcmeUrl;
    }

    if (acmeRootPath) {
      issuer.trusted_roots_pem_files = [acmeRootPath];
    }
  };

  // Add policy for auto-managed domains (certificateId = null)
  if (hasAutoManagedDomains) {
    for (const group of groupHostPatternsByPriority(Array.from(autoManagedDomains))) {
      const subjects = takeTailscaleSubjects(group);
      if (subjects.length === 0) continue;

      const issuer: Record<string, unknown> = { module: "acme" };
      applyAcmeOverrides(issuer);

      if (options.acmeEmail) {
        issuer.email = options.acmeEmail;
      }

      if (globalDnsProvider && dnsProviderAllowed(globalDnsProvider.provider)) {
        const dnsChallenge = buildDnsChallengeConfig(
          globalDnsProvider.provider,
          globalDnsProvider.credentials,
          dnsResolvers,
        );
        if (dnsChallenge) {
          issuer.challenges = { dns: dnsChallenge };
        }
      }

      policies.push({
        subjects,
        issuers: [issuer],
      });
    }
  }

  // Add policies for explicitly managed certificates
  for (const entry of managedEntries) {
    const subjects = Array.from(entry.domains);
    if (subjects.length === 0) {
      continue;
    }

    managedCertificateIds.add(entry.certificate.id);

    let effectiveProvider = globalDnsProvider;
    const certOptions = entry.certificate.providerOptions as { provider?: string } | null;
    if (certOptions?.provider && dnsProviderSettings?.providers[certOptions.provider]) {
      effectiveProvider = {
        provider: certOptions.provider,
        credentials: dnsProviderSettings.providers[certOptions.provider],
      };
    }

    for (const group of groupHostPatternsByPriority(subjects)) {
      const subjectGroup = takeTailscaleSubjects(group);
      if (subjectGroup.length === 0) continue;

      const issuer: Record<string, unknown> = { module: "acme" };
      applyAcmeOverrides(issuer);

      if (options.acmeEmail) {
        issuer.email = options.acmeEmail;
      }

      if (effectiveProvider && dnsProviderAllowed(effectiveProvider.provider)) {
        const dnsChallenge = buildDnsChallengeConfig(
          effectiveProvider.provider,
          effectiveProvider.credentials,
          dnsResolvers,
        );
        if (dnsChallenge) {
          issuer.challenges = { dns: dnsChallenge };
        }
      }

      policies.push({
        subjects: subjectGroup,
        issuers: [issuer],
      });
    }
  }

  if (policies.length === 0) {
    return {
      managedCertificateIds,
      tlsApp: undefined,
    };
  }

  return {
    tlsApp: {
      automation: {
        policies: sortAutomationPoliciesBySubjectPriority(withRenewalOverrides(policies)),
      },
    },
    managedCertificateIds,
  };
}

type L4BuildContext = Pick<
  CaddyBuildContext,
  | "globalDnsSettings"
  | "globalUpstreamDnsResolutionSettings"
  | "globalGeoBlock"
  | "moduleAvailability"
>;

async function buildL4Servers(
  context: L4BuildContext,
  agentRowId?: number,
): Promise<Record<string, unknown> | null> {
  // The entire layer4 app comes from caddy-l4. Without it there is no `layer4` key to
  // unmarshal, so emitting one would fail the whole config - HTTP hosts included.
  if (!isFeatureUsable(context.moduleAvailability, "l4")) return null;

  const [enabledL4Hosts, assignments, metrics] = await Promise.all([
    db.select().from(l4ProxyHosts).where(eq(l4ProxyHosts.enabled, true)),
    agentRowId === undefined ? null : listHostAssignments("l4"),
    getMetricsSettings(),
  ]);
  // A row on a reserved port predates validateL4Input's check. getRequiredL4Ports does not publish
  // it, so a listener here would either bind a port nobody can reach or collide with 80/443/2019.
  const metricsPort = metrics?.enabled ? (metrics.port ?? 9090) : null;
  const allL4Hosts = enabledL4Hosts.filter(
    (host) => !isReservedL4ListenAddress(host.listenAddress, metricsPort),
  );
  const l4Hosts =
    assignments === null
      ? allL4Hosts
      : allL4Hosts.filter((host) => servedByAgent(assignments, host.id, agentRowId ?? null));

  if (l4Hosts.length === 0) return null;

  const geoblockUsable = isFeatureUsable(context.moduleAvailability, "geoblock");

  // Group hosts by listen address - multiple hosts on the same port share routes in one server
  const serverMap = new Map<string, typeof l4Hosts>();
  for (const host of l4Hosts) {
    const key = host.listenAddress;
    if (!serverMap.has(key)) serverMap.set(key, []);
    serverMap.get(key)!.push(host);
  }

  const servers: Record<string, unknown> = {};
  let serverIdx = 0;
  for (const [listenAddr, hosts] of serverMap) {
    const routes: Record<string, unknown>[] = [];

    for (const host of hosts) {
      const route: Record<string, unknown> = {};

      // Build matchers
      const matcherType = host.matcherType as string;
      const matcherValues = host.matcherValue ? parseJson<string[]>(host.matcherValue, []) : [];

      if (matcherType === "tls_sni" && matcherValues.length > 0) {
        route.match = [{ tls: { sni: matcherValues } }];
      } else if (matcherType === "http_host" && matcherValues.length > 0) {
        route.match = [{ http: [{ host: matcherValues }] }];
      } else if (matcherType === "proxy_protocol") {
        route.match = [{ proxy_protocol: {} }];
      }
      // "none" = no match block (catch-all)

      // Parse per-host meta for load balancing, DNS resolver, and upstream DNS resolution
      const meta = parseJson<L4Meta>(host.meta, {});

      // Load balancer config
      const lbMeta = meta.load_balancer;
      let lbConfig: LoadBalancerRouteConfig | null = null;
      if (lbMeta?.enabled) {
        lbConfig = {
          enabled: true,
          policy: lbMeta.policy ?? "random",
          policyHeaderField: null,
          policyCookieName: null,
          policyCookieSecret: null,
          // Layer 4 has no request to read: the HTTP-shaped policies (header, cookie, uri_hash,
          // query) have nothing to hash, so only the connection-level ones are wired here.
          policyQueryKey: null,
          policyChoose: lbMeta.policy_choose ?? null,
          policyWeights: lbMeta.policy_weights ?? null,
          tryDuration: lbMeta.try_duration ?? null,
          tryInterval: lbMeta.try_interval ?? null,
          retries: lbMeta.retries ?? null,
          activeHealthCheck: lbMeta.active_health_check?.enabled
            ? {
                enabled: true,
                uri: null,
                port: lbMeta.active_health_check.port ?? null,
                interval: lbMeta.active_health_check.interval ?? null,
                timeout: lbMeta.active_health_check.timeout ?? null,
                status: null,
                body: null,
                passes: lbMeta.active_health_check.passes ?? null,
                fails: lbMeta.active_health_check.fails ?? null,
                // No HTTP probe at layer 4 - the check is a dial, so there is no method, body,
                // redirect to follow or header to send.
                method: null,
                requestBody: null,
                followRedirects: false,
                headers: null,
              }
            : null,
          passiveHealthCheck: lbMeta.passive_health_check?.enabled
            ? {
                enabled: true,
                failDuration: lbMeta.passive_health_check.fail_duration ?? null,
                maxFails: lbMeta.passive_health_check.max_fails ?? null,
                unhealthyStatus: null,
                unhealthyLatency: lbMeta.passive_health_check.unhealthy_latency ?? null,
                unhealthyRequestCount: lbMeta.passive_health_check.unhealthy_request_count ?? null,
              }
            : null,
        };
      }

      // DNS resolver config
      const dnsConfig = parseDnsResolverConfig(meta.dns_resolver);

      // Upstream DNS resolution (pinning)
      const hostDnsResolution = parseUpstreamDnsResolutionConfig(meta.upstream_dns_resolution);
      const effectiveDnsResolution = resolveEffectiveUpstreamDnsResolution(
        context.globalUpstreamDnsResolutionSettings,
        hostDnsResolution,
      );

      // Build handler chain
      const handlers: Record<string, unknown>[] = [];

      // 1. Receive inbound proxy protocol
      if (host.proxyProtocolReceive) {
        handlers.push({ handler: "proxy_protocol" });
      }

      // 2. TLS termination
      if (host.tlsTermination) {
        handlers.push({ handler: "tls" });
      }

      // 3. Proxy handler
      const upstreams = parseJson<string[]>(host.upstreams, []);

      // Resolve upstream hostnames to IPs if DNS pinning is enabled
      let resolvedDials = upstreams;
      if (effectiveDnsResolution.enabled) {
        const resolver = new Resolver();
        const lookupServers = getLookupServers(dnsConfig, context.globalDnsSettings);
        if (lookupServers.length > 0) {
          try {
            resolver.setServers(lookupServers);
          } catch {
            /* ignore invalid servers */
          }
        }
        const timeoutMs = getLookupTimeoutMs(dnsConfig, context.globalDnsSettings);

        // Looked up together and flattened in list order, as the HTTP path does.
        const pinned = await Promise.all(
          upstreams.map(async (upstream): Promise<string[]> => {
            const colonIdx = upstream.lastIndexOf(":");
            if (colonIdx <= 0) {
              return [upstream];
            }
            const hostPart = upstream.substring(0, colonIdx);
            const portPart = upstream.substring(colonIdx + 1);
            if (isIP(hostPart) !== 0) {
              return [upstream];
            }
            try {
              const addresses = await resolveHostnameAddresses(
                resolver,
                hostPart,
                effectiveDnsResolution.family,
                timeoutMs,
              );
              return addresses.map((addr) =>
                addr.includes(":") ? `[${addr}]:${portPart}` : `${addr}:${portPart}`,
              );
            } catch {
              return [upstream];
            }
          }),
        );
        resolvedDials = pinned.flat();
      }

      // For UDP hosts, upstream dials must also use the udp/ prefix
      const dialPrefix = (host.protocol as string) === "udp" ? "udp/" : "";
      const proxyHandler: Record<string, unknown> = {
        handler: "proxy",
        upstreams: resolvedDials.map((u) => ({ dial: [`${dialPrefix}${u}`] })),
      };
      if (host.proxyProtocolVersion) {
        proxyHandler.proxy_protocol = host.proxyProtocolVersion;
      }
      if (lbConfig) {
        const loadBalancing = buildL4LoadBalancingConfig(lbConfig, resolvedDials.length);
        if (loadBalancing) proxyHandler.load_balancing = loadBalancing;
        const healthChecks = buildL4HealthChecksConfig(lbConfig);
        if (healthChecks) proxyHandler.health_checks = healthChecks;
      }
      handlers.push(proxyHandler);

      route.handle = handlers;

      // Geo blocking: a blocking route BEFORE the proxy route. At L4 the blocker is a matcher
      // (layer4.matchers.blocker) - blocked connections match this route and are closed, the
      // rest fall through to the proxy route.
      const effectiveGeoBlock = resolveEffectiveGeoBlock(context.globalGeoBlock ?? null, {
        geoblock: meta.geoblock ?? null,
        geoblock_mode: meta.geoblock_mode ?? "merge",
      });
      if (effectiveGeoBlock && geoblockUsable) {
        const blockerMatcher = buildGeoBlockMatcher(effectiveGeoBlock);

        // Build the same route matcher as the proxy route (if any)
        const blockRoute: Record<string, unknown> = {
          match: [
            {
              blocker: blockerMatcher,
              ...(route.match ? (route.match as Record<string, unknown>[])[0] : {}),
            },
          ],
          handle: [{ handler: "close" }],
        };
        routes.push(blockRoute);
      }

      routes.push(route);
    }

    // Protocol comes from the hosts on this listen address; all of them must agree.
    const protocol = hosts[0].protocol as string;
    const listenValue = protocol === "udp" ? `udp/${listenAddr}` : listenAddr;

    servers[`l4_server_${serverIdx++}`] = {
      listen: [listenValue],
      routes,
    };
  }

  return servers;
}

/**
 * Build the configuration for one agent, or for the fleet.
 *
 * `agentRowId` scopes the document to what that agent should serve: the hosts pinned to it plus
 * every unpinned host, and the modules its own binary carries. Omitted - which is what every unit
 * test and the single-agent path do - nothing is filtered and the module gate falls back to the
 * fleet-wide intersection, which is exactly the document this function produced before hosts could
 * be assigned at all.
 *
 * `options.adaptVia` is the agent whose Caddy adapts the hosts' Caddyfile snippets, and must be the
 * agent this document is loaded onto.
 */
export async function buildCaddyDocument(agentRowId?: number, options: { adaptVia?: string } = {}) {
  const [
    proxyHostRecords,
    certRows,
    accessListEntryRecords,
    accessListRecords,
    accessListIpRuleRecords,
    caCertRows,
    issuedClientCertRows,
    allIssuedCaCertIds,
    httpAssignments,
    dashboardSettings,
    { roleCertIdMap, roleFingerprintMap },
  ] = await Promise.all([
    db
      .select({
        id: proxyHosts.id,
        name: proxyHosts.name,
        domains: proxyHosts.domains,
        upstreams: proxyHosts.upstreams,
        certificateId: proxyHosts.certificateId,
        accessListId: proxyHosts.accessListId,
        sslForced: proxyHosts.sslForced,
        hstsEnabled: proxyHosts.hstsEnabled,
        hstsSubdomains: proxyHosts.hstsSubdomains,
        allowWebsocket: proxyHosts.allowWebsocket,
        preserveHostHeader: proxyHosts.preserveHostHeader,
        skipHttpsHostnameValidation: proxyHosts.skipHttpsHostnameValidation,
        meta: proxyHosts.meta,
        enabled: proxyHosts.enabled,
      })
      .from(proxyHosts),
    db
      .select({
        id: certificates.id,
        name: certificates.name,
        type: certificates.type,
        domainNames: certificates.domainNames,
        certificatePem: certificates.certificatePem,
        privateKeyPem: certificates.privateKeyPem,
        autoRenew: certificates.autoRenew,
        providerOptions: certificates.providerOptions,
      })
      .from(certificates),
    db
      .select({
        accessListId: accessListEntries.accessListId,
        username: accessListEntries.username,
        passwordHash: accessListEntries.passwordHash,
      })
      .from(accessListEntries),
    db
      .select({
        id: accessLists.id,
        ipDefault: accessLists.ipDefault,
        satisfy: accessLists.satisfy,
        passAuth: accessLists.passAuth,
      })
      .from(accessLists),
    db
      .select({
        accessListId: accessListIpRules.accessListId,
        action: accessListIpRules.action,
        cidr: accessListIpRules.cidr,
      })
      .from(accessListIpRules)
      .orderBy(asc(accessListIpRules.accessListId), asc(accessListIpRules.sortOrder)),
    db
      .select({
        id: caCertificates.id,
        certificatePem: caCertificates.certificatePem,
      })
      .from(caCertificates),
    db
      .select({
        id: issuedClientCertificates.id,
        caCertificateId: issuedClientCertificates.caCertificateId,
        certificatePem: issuedClientCertificates.certificatePem,
        fingerprintSha256: issuedClientCertificates.fingerprintSha256,
        validTo: issuedClientCertificates.validTo,
      })
      .from(issuedClientCertificates)
      .where(isNull(issuedClientCertificates.revokedAt)),
    // Distinct CA IDs that have ever had a tracked issued cert (including revoked). Tells
    // "managed" CAs (pin to leaf certs) from "unmanaged" ones (trust any cert they signed).
    db
      .selectDistinct({ caCertificateId: issuedClientCertificates.caCertificateId })
      .from(issuedClientCertificates),
    agentRowId === undefined ? null : listHostAssignments("http"),
    getDashboardSettings(),
    buildRoleMaps(),
  ]);

  // Pinned elsewhere, so this agent must not serve it. Filtered here rather than in the query so
  // the fleet-wide path stays a plain select, and so "no assignments means everywhere" is decided
  // by one function instead of by which side a join was written on.
  const servedRecords =
    httpAssignments === null
      ? proxyHostRecords
      : proxyHostRecords.filter((h) => servedByAgent(httpAssignments, h.id, agentRowId ?? null));

  const storedHostRows: ProxyHostRow[] = servedRecords.map((h) => ({
    id: h.id,
    name: h.name,
    domains: h.domains,
    upstreams: h.upstreams,
    certificateId: h.certificateId,
    accessListId: h.accessListId,
    sslForced: h.sslForced ? 1 : 0,
    hstsEnabled: h.hstsEnabled ? 1 : 0,
    hstsSubdomains: h.hstsSubdomains ? 1 : 0,
    allowWebsocket: h.allowWebsocket ? 1 : 0,
    preserveHostHeader: h.preserveHostHeader ? 1 : 0,
    skipHttpsHostnameValidation: h.skipHttpsHostnameValidation ? 1 : 0,
    meta: h.meta,
    enabled: h.enabled ? 1 : 0,
  }));

  // CPM's own dashboard, served by the Caddy it manages. Synthesised rather than stored, and ahead
  // of the stored rows: sortRoutesByHostPriority settles every other overlap by specificity, but
  // two rows claiming the same exact domain tie and fall back to this order. Winning that tie is
  // the point - a host someone creates for the dashboard's domain must not shadow the route the
  // dashboard is reached through. Absent entirely when the setting is off, the domain is blank, or
  // the dial address could not be worked out - or when it is pinned to agents this one is not.
  const dashboardAgents = dashboardSettings?.options?.agentIds ?? [];
  const dashboardServedHere =
    agentRowId === undefined ||
    dashboardAgents.length === 0 ||
    dashboardAgents.includes(agentRowId);
  const dashboardRow = dashboardServedHere
    ? buildDashboardHostRow(dashboardSettings, getCpmDialAddress())
    : null;
  const proxyHostRows: ProxyHostRow[] = dashboardRow
    ? [dashboardRow, ...storedHostRows]
    : storedHostRows;

  const certRowsMapped: CertificateRow[] = certRows.map((c: (typeof certRows)[0]) => ({
    id: c.id,
    name: c.name,
    type: c.type as "managed" | "imported",
    domainNames: c.domainNames,
    certificatePem: c.certificatePem,
    privateKeyPem: c.privateKeyPem
      ? decryptSecret(c.privateKeyPem, `certificate "${c.name}"`)
      : null,
    autoRenew: c.autoRenew ? 1 : 0,
    providerOptions: c.providerOptions,
  }));

  const accessListEntryRows: AccessListEntryRow[] = accessListEntryRecords.map((entry) => ({
    accessListId: entry.accessListId,
    username: entry.username,
    passwordHash: entry.passwordHash,
  }));

  const certificateMap = new Map(certRowsMapped.map((cert) => [cert.id, cert]));
  const caCertMap = new Map(caCertRows.map((ca) => [ca.id, ca]));
  // Expired certs leave every trust set here too. Path-scoped hosts do not rely on it - Go checks
  // expiry on each handshake - but it keeps the leaf pins and HTTP gates from naming dead certs.
  const now = Date.now();
  const activeIssuedCerts = issuedClientCertRows.filter((r) =>
    isCertificateUnexpired(r.validTo, now),
  );
  const issuedClientCertMap = activeIssuedCerts.reduce<Map<number, string[]>>((map, record) => {
    const current = map.get(record.caCertificateId) ?? [];
    current.push(record.certificatePem);
    map.set(record.caCertificateId, current);
    return map;
  }, new Map());
  const caFingerprintMap = activeIssuedCerts.reduce<Map<number, Set<string>>>((map, record) => {
    const current = map.get(record.caCertificateId) ?? new Set<string>();
    current.add(normalizeFingerprint(record.fingerprintSha256));
    map.set(record.caCertificateId, current);
    return map;
  }, new Map());
  const cAsWithAnyIssuedCerts = new Set(allIssuedCaCertIds.map((r) => r.caCertificateId));
  const accessMap = accessListEntryRows.reduce<Map<number, AccessListEntryRow[]>>((map, entry) => {
    if (!map.has(entry.accessListId)) {
      map.set(entry.accessListId, []);
    }
    map.get(entry.accessListId)!.push(entry);
    return map;
  }, new Map());

  // Build a lookup: issued cert ID → { id, caCertificateId, certificatePem } (active only)
  const issuedCertById = new Map(activeIssuedCerts.map((r) => [r.id, r]));
  // Same active rows, so the fingerprint map for RBAC comes from them rather than a second read.
  const certFingerprintMap = new Map(
    activeIssuedCerts.map((r) => [r.id, normalizeFingerprint(r.fingerprintSha256)]),
  );

  // Domain → CA cert IDs map for mTLS-enabled hosts. New model (trusted_client_cert_ids +
  // trusted_role_ids): derive CAs from the selected certs and pin to those certs. Old model
  // (ca_certificate_ids): trust entire CAs.
  const mTlsDomainMap = new Map<string, number[]>();
  // Per-domain override: which specific leaf cert PEMs to pin (new model only)
  const mTlsDomainLeafOverride = new Map<string, string[]>();
  const mTlsOptionalAuthDomains = new Set<string>();
  for (const row of proxyHostRows) {
    if (!row.enabled) continue;
    const meta = parseJson<{ mtls?: MtlsConfig }>(row.meta, {});
    if (!meta.mtls?.enabled) continue;

    const domains = parseJson<string[]>(row.domains, [])
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    if (domains.length === 0) continue;

    if (meta.mtls.protected_paths?.length || meta.mtls.excluded_paths?.length) {
      for (const domain of domains) {
        mTlsOptionalAuthDomains.add(domain);
      }
    }

    // Collect all trusted cert IDs from both direct selection and roles
    const allCertIds = new Set<number>();
    if (meta.mtls.trusted_client_cert_ids) {
      for (const id of meta.mtls.trusted_client_cert_ids) allCertIds.add(id);
    }
    if (meta.mtls.trusted_role_ids) {
      for (const roleId of meta.mtls.trusted_role_ids) {
        const certIds = roleCertIdMap.get(roleId);
        if (certIds) for (const id of certIds) allCertIds.add(id);
      }
    }

    if (allCertIds.size > 0) {
      // New model: pin trust to the explicitly-selected client certs - derive their CAs for
      // chain validation and collect the leaf PEMs for pinning.
      const derivedCaIds = new Set<number>();
      const leafPems: string[] = [];
      for (const certId of allCertIds) {
        const cert = issuedCertById.get(certId);
        if (cert) {
          derivedCaIds.add(cert.caCertificateId);
          leafPems.push(cert.certificatePem);
        }
      }
      if (leafPems.length > 0) {
        const caIdArr = Array.from(derivedCaIds);
        for (const domain of domains) {
          mTlsDomainMap.set(domain, caIdArr);
          mTlsDomainLeafOverride.set(domain, leafPems);
        }
      } else {
        // Every selected cert/role resolved to ZERO active leaves. FAIL CLOSED: do NOT fall back to
        // whole-CA trust, which would admit other certs of that CA never assigned to this host.
        // require_and_verify with an empty trust set → buildClientAuthentication null → drop-all.
        for (const domain of domains) {
          mTlsDomainMap.set(domain, []);
          mTlsOptionalAuthDomains.delete(domain);
        }
      }
    } else if (meta.mtls.ca_certificate_ids?.length) {
      // Legacy model: trust entire CAs (backward compat)
      for (const domain of domains) {
        mTlsDomainMap.set(domain, meta.mtls.ca_certificate_ids);
      }
    } else {
      // mTLS enabled but nothing resolved (role-only trust fully revoked, or nothing selected) and
      // no legacy CA trust. FAIL CLOSED: keep the domain with an empty CA set (→ drop-all policy)
      // and force require_and_verify, so even protected/excluded-path hosts reject everything.
      for (const domain of domains) {
        mTlsDomainMap.set(domain, []);
        mTlsOptionalAuthDomains.delete(domain);
      }
    }
  }

  // Build mTLS RBAC data for HTTP-layer enforcement
  const enabledProxyHostIds = proxyHostRows.filter((r) => r.enabled).map((r) => r.id);

  const { usage: certificateUsage, autoManagedDomains } = collectCertificateUsage(
    proxyHostRows,
    certificateMap,
  );
  const [
    accessRulesByHost,
    generalSettings,
    acmeSettings,
    dnsSettings,
    dnsProviderSettings,
    upstreamDnsResolutionSettings,
    globalGeoBlock,
    globalWaf,
    wafPresets,
    crsPluginRules,
    trustedProxiesSettings,
    moduleAvailability,
    defaultResponseSettings,
    storedTailscaleSettings,
    globalErrorPages,
    metricsSettings,
    loggingSettings,
    httpProtocols,
  ] = await Promise.all([
    getAccessRulesForHosts(enabledProxyHostIds),
    getGeneralSettings(),
    getAcmeSettings(),
    getDnsSettings(),
    getDnsProviderSettings(),
    getUpstreamDnsResolutionSettings(),
    getGeoBlockSettings(),
    getWafSettings(),
    getWafPresetDirectives(),
    getCrsPluginRules(),
    getTrustedProxiesSettings(),
    getCaddyModuleAvailability(agentRowId),
    getDefaultResponseSettings(),
    getTailscaleSettings(),
    getErrorPagesSettings(),
    getMetricsSettings(),
    getLoggingSettings(),
    getHttpProtocolsSettings(),
  ]);

  // Resolved before anything reads it, because both the routes and the servers depend on the same
  // answer. "Enabled but not usable" is worth saying out loud: the operator turned Tailscale on,
  // every tailnet-only host silently stopped being served, and the only clue is here.
  const tailscaleSettings = storedTailscaleSettings ?? defaultTailscaleSettings();
  const tailscaleCompiledIn = isFeatureUsable(moduleAvailability, "tailscale");
  if (tailscaleSettings.enabled && !tailscaleCompiledIn) {
    console.warn(
      "Tailscale is enabled in settings but its Caddy module is not in the running binary. " +
        "Enable it in Settings → Caddy Build and rebuild Caddy.",
    );
  }
  const tailscaleRuntime: TailscaleRuntime = {
    settings: tailscaleSettings,
    authKey: tailscaleSettings.authKey
      ? decryptSecret(tailscaleSettings.authKey, "Tailscale auth key")
      : "",
    usable: tailscaleSettings.enabled && tailscaleCompiledIn,
  };

  // Optionally seed the global geoblock trusted-proxy list from the server-level value so the
  // two can't silently disagree (issue #222). Applied only as a default: an explicit per-scope
  // geoblock list is left untouched.
  let effectiveGlobalGeoBlock = globalGeoBlock;
  if (trustedProxiesSettings?.default_geoblock && globalGeoBlock) {
    const serverRanges = (trustedProxiesSettings.ranges ?? []).map((r) => r.trim()).filter(Boolean);
    if (serverRanges.length > 0 && !globalGeoBlock.trusted_proxies?.length) {
      effectiveGlobalGeoBlock = { ...globalGeoBlock, trusted_proxies: serverRanges };
    }
  }
  const { tlsApp, managedCertificateIds } = await buildTlsAutomation({
    usage: certificateUsage,
    autoManagedDomains,
    options: {
      acmeEmail: generalSettings?.acmeEmail,
      dnsSettings,
      dnsProviderSettings,
      acmeSettings,
      moduleAvailability,
    },
  });
  const {
    policies: tlsConnectionPolicies,
    readyCertificates,
    importedCertPems,
  } = buildTlsConnectionPolicies({
    usage: certificateUsage,
    managedCertificatesWithAutomation: managedCertificateIds,
    autoManagedDomains,
    mTlsDomainMap,
    caCertMap,
    issuedClientCertMap,
    cAsWithAnyIssuedCerts,
    mTlsDomainLeafOverride,
    mTlsOptionalAuthDomains,
  });

  // Grouped once; the query already orders each list's rules.
  const ipRulesByList = new Map<number, IpRule[]>();
  for (const rule of accessListIpRuleRecords) {
    const rules = ipRulesByList.get(rule.accessListId) ?? [];
    rules.push({
      action: rule.action === "allow" ? "allow" : "deny",
      cidr: rule.cidr,
      note: null,
    });
    ipRulesByList.set(rule.accessListId, rules);
  }

  const caddyBuildContext: CaddyBuildContext = {
    rows: proxyHostRows,
    accessLists: new Map(
      accessListRecords.map((list) => [
        list.id,
        {
          accounts: accessMap.get(list.id) ?? [],
          ipRules: ipRulesByList.get(list.id) ?? [],
          ipDefault: list.ipDefault === "allow" ? ("allow" as const) : ("deny" as const),
          satisfy: list.satisfy === "any" ? ("any" as const) : ("all" as const),
          passAuth: list.passAuth,
        },
      ]),
    ),
    tlsReadyCertificates: readyCertificates,
    globalDnsSettings: dnsSettings,
    globalUpstreamDnsResolutionSettings: upstreamDnsResolutionSettings,
    globalGeoBlock: effectiveGlobalGeoBlock,
    globalWaf,
    wafPresets,
    crsPlugins: crsPluginRules,
    moduleAvailability,
    tailscale: tailscaleRuntime,
    adaptVia: options.adaptVia,
    mtlsRbac: {
      roleFingerprintMap,
      certFingerprintMap,
      accessRulesByHost,
      caFingerprintMap,
      managedCaIds: cAsWithAnyIssuedCerts,
    },
  };

  // The two route sets share nothing but the settings above, so their DNS lookups and adapt
  // round trips overlap instead of queueing.
  const [
    { routes: httpRoutes, tailnetRoutes, tailscaleNodes, errorRoutes: hostErrorRoutes },
    l4Servers,
  ] = await Promise.all([
    buildProxyRoutes(caddyBuildContext),
    buildL4Servers(
      {
        globalDnsSettings: dnsSettings,
        globalUpstreamDnsResolutionSettings: upstreamDnsResolutionSettings,
        globalGeoBlock: effectiveGlobalGeoBlock,
        moduleAvailability,
      },
      agentRowId,
    ),
  ]);

  // An administrator-configured matcher-less route replaces Caddy's native
  // unmatched-request behavior and must remain last so it cannot shadow any
  // managed proxy host.
  const defaultResponseRoute = buildDefaultResponseRoute(defaultResponseSettings);
  const mainRoutes = defaultResponseRoute ? [...httpRoutes, defaultResponseRoute] : httpRoutes;

  // Server-level error routes (Caddy handle_errors): per-host rules first so they
  // take precedence, then global rules act as a fallback for any unmatched host/status.
  const globalErrorRoutes = (globalErrorPages?.rules ?? []).map((rule) =>
    buildErrorPageRoute(rule),
  );
  const errorRoutes: CaddyHttpRoute[] = [...hostErrorRoutes, ...globalErrorRoutes];

  const hasTls = tlsConnectionPolicies.length > 0;

  // Check if metrics should be enabled
  const metricsEnabled = metricsSettings?.enabled ?? false;
  const metricsPort = metricsSettings?.port ?? 9090;

  // Check if access logging should be enabled
  const loggingEnabled = loggingSettings?.enabled ?? false;
  const loggingFormat = loggingSettings?.format ?? "json";

  const servers: Record<string, unknown> = {};

  // Server-level trusted proxies / client-IP headers. Caddy resolves client_ip in core before
  // any handler, so this is the only place a global list fixes client-IP attribution.
  const serverTrustedProxies = buildServerTrustedProxies(trustedProxiesSettings);

  // Main HTTP/HTTPS server for proxy hosts
  if (mainRoutes.length > 0) {
    servers.cpm = {
      listen: hasTls ? [":80", ":443"] : [":80"],
      // First, so every domain pointed here answers the reachability check the same way.
      routes: [reachabilityRoute(), ...mainRoutes],
      // Only disable automatic HTTPS if we have TLS automation policies
      // This allows Caddy to handle HTTP-01 challenges for managed certificates
      ...(tlsApp
        ? evictedNames().length > 0 && { automatic_https: { skip_certificates: evictedNames() } }
        : { automatic_https: { disable: true } }),
      ...(hasTls ? { tls_connection_policies: tlsConnectionPolicies } : {}),
      // Custom error pages (handle_errors)
      ...(errorRoutes.length > 0 ? { errors: { routes: errorRoutes } } : {}),
      // Trusted proxies / client_ip_headers / trusted_proxies_strict (issue #222)
      ...serverTrustedProxies,
      ...buildServerProtocols(httpProtocols),
      // Enable access logging if configured
      ...(loggingEnabled ? { logs: { default_logger_name: "http_access" } } : {}),
    };
  }

  // One server per tailnet node. Separate from `cpm` rather than extra listen addresses on it,
  // because "tailnet only" has to mean the routes are absent from the public server - sharing one
  // server would publish every host on every address. The default-response route is deliberately
  // not repeated here: an unmatched request arriving over the tailnet is a misconfiguration, and
  // Caddy's own 404 says so more usefully than a catch-all meant for the open internet.
  for (const [node, nodeRoutes] of tailnetRoutes) {
    if (nodeRoutes.length === 0) continue;
    servers[`cpm_tailscale_${node}`] = {
      listen: tailscaleListenAddresses(node),
      routes: nodeRoutes,
      ...(tlsApp ? {} : { automatic_https: { disable: true } }),
      ...(hasTls ? { tls_connection_policies: tlsConnectionPolicies } : {}),
      ...(errorRoutes.length > 0 ? { errors: { routes: errorRoutes } } : {}),
      ...serverTrustedProxies,
      ...(loggingEnabled ? { logs: { default_logger_name: "http_access" } } : {}),
    };
  }

  // Metrics server - exposes /metrics endpoint on separate port
  if (metricsEnabled) {
    servers.metrics = {
      listen: [`:${metricsPort}`],
      routes: [
        {
          // Served in-process rather than proxied to the admin API, which binds only the internal
          // caddy-admin network once the agent pins it, never loopback.
          handle: [{ handler: "metrics" }],
        },
      ],
    };
  }

  const httpApp = Object.keys(servers).length > 0 ? { http: { servers } } : {};

  // Only when something actually names a node. The app is what carries the auth key, so emitting
  // it for a deployment that has Tailscale switched on but no host using it would register nodes
  // on the tailnet that serve nothing.
  const tailscaleApp =
    tailscaleRuntime.usable && tailscaleNodes.size > 0
      ? { tailscale: buildTailscaleApp(tailscaleRuntime.settings, tailscaleRuntime.authKey) }
      : {};

  // Build logging configuration. Roll settings are spelled out rather than left to Caddy's
  // file-writer defaults, so rotation does not depend on upstream defaults staying put.
  //
  // They cannot stop a full disk on their own, though. Caddy >= 2.11 rolls logs through
  // timberjack, whose housekeeping pass (gzip and prune old rolled files) starts by listing the
  // directory. A /logs that caddy's UID can write but not read keeps rotating, since create and
  // rename need only w+x, but timberjack swallows the EACCES from the listing and 100MB rolled
  // files pile up until the disk fills. That is what actually filled a deployed host, not the
  // defaults. The named volume inherits the image's chown'd /logs and is fine; a bind mount needs
  //   chgrp <caddy PGID> <host-dir> && chmod 2770 <host-dir>
  // on the host.
  const rollSettings = {
    roll: true,
    roll_size_mb: 100,
    roll_gzip: true,
    roll_keep: 10,
    roll_keep_days: 30,
  };
  const loggingLogs: Record<string, unknown> = {
    // WAF rule match logs. Modern Coraza puts matched rules in the audit log (part H), which
    // waf-log-parser reads; this file is a fallback for older builds plus a human-readable trail.
    // Do not make ingestion depend on it - correlating two files dropped non-blocked events (#233).
    waf_rules: {
      writer: { output: "file", filename: "/logs/waf-rules.log", mode: "0640", ...rollSettings },
      encoder: { format: "json" },
      include: ["http.handlers.waf"],
      level: "ERROR",
    },
  };
  if (loggingEnabled) {
    loggingLogs.http_access = {
      writer: { output: "file", filename: "/logs/access.log", mode: "0640", ...rollSettings },
      encoder: { format: loggingFormat },
      include: ["http.log.access", "http.handlers.blocker"],
    };
  }
  const loggingApp = { logging: { logs: loggingLogs } };

  const l4App = l4Servers ? { layer4: { servers: l4Servers } } : {};

  return {
    admin: {
      // A bare port binds every address family; "0.0.0.0:2019" bound only IPv4, so an agent
      // reaching Caddy over IPv6 found nothing listening.
      listen: ":2019",
      // Caddy matches the Host header against these literally. An IPv6 caller sends the bracketed
      // form, which is a different string from the name and has to be listed separately.
      origins: ["caddy:2019", "localhost:2019", "localhost", "[::1]:2019", "127.0.0.1:2019"],
    },
    ...loggingApp,
    apps: {
      ...httpApp,
      ...(tlsApp || importedCertPems.length > 0
        ? {
            tls: {
              ...(tlsApp ?? {}),
              ...(importedCertPems.length > 0
                ? { certificates: { load_pem: importedCertPems } }
                : {}),
            },
          }
        : {}),
      ...l4App,
      ...tailscaleApp,
    },
  };
}

/**
 * Turn one Caddy's answer into an outcome, or throw.
 *
 * `who` names the agent when there is more than one: with a fleet, "Caddy rejected configuration"
 * leaves the operator with no idea which host is now out of step with the others.
 */
function assertCaddyAccepted(response: { status: number; text: string }, who: string): void {
  if (response.status >= 200 && response.status < 300) return;

  const reason = describeCaddyRejection(response.text);
  logCaddyApplyFailure("Caddy rejected configuration", undefined, {
    status: response.status,
    responseBytes: Buffer.byteLength(response.text),
    knownReason: reason !== null,
  });
  const where = who ? ` on ${who}` : "";
  throw new CaddyApplyError(
    reason
      ? `Caddy rejected configuration${where}: ${reason}`
      : `Caddy rejected configuration${where}`,
    "CADDY_REJECTED",
    describeWafRejection(response.text),
  );
}

/**
 * What each Caddy was serving immediately after this controller last loaded it, keyed by agent
 * ("" for the Caddy reached with no agent attached).
 *
 * The health monitor compares this against the config a Caddy is actually serving. A hash is the
 * only signal that holds: Caddy answers `/config/` with an ETag whichever config it holds, and a
 * container that came back on the image's default Caddyfile serves a perfectly non-empty `http`
 * app - so "did the ETag go" and "is the config empty" both miss a real drift. What is compared is
 * the config Caddy reports, not the document that was posted, because Caddy normalises what it
 * stores and the two would never match.
 */
const appliedConfigHashes = new Map<string, string>();

/** The fingerprint recorded by the last successful load onto this Caddy, if there was one. */
export function getLastAppliedConfigHash(agentId?: string): string | null {
  return appliedConfigHashes.get(agentId ?? "") ?? null;
}

/** Fingerprint of what a Caddy is serving right now, or null when it cannot be asked. */
export async function getCaddyLiveConfigHash(agentId?: string): Promise<string | null> {
  try {
    const response = await caddyAdminRequest({
      path: "/config/",
      method: "GET",
      timeoutMs: 5000,
      agentId,
    });
    if (response.status < 200 || response.status >= 300) return null;
    return createHash("sha256").update(response.text).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Record what a Caddy serves now that a load has been accepted. Failing to read it back only
 * forgets the fingerprint: the monitor then treats that Caddy as one it has nothing to compare
 * against, which is where it started.
 */
async function noteAppliedConfig(agentId?: string): Promise<void> {
  const key = agentId ?? "";
  const hash = await getCaddyLiveConfigHash(agentId);
  if (hash) appliedConfigHashes.set(key, hash);
  else appliedConfigHashes.delete(key);
}

/** Test seam: forget every recorded fingerprint. */
export function resetAppliedConfigHashes(): void {
  appliedConfigHashes.clear();
}

/**
 * Build the configuration and load it onto every agent's Caddy.
 *
 * A document per agent, not one for the fleet. The controller's database is still the single
 * source of truth, but what any given agent should be running is now a question with a different
 * answer per agent - the hosts pinned to it, and the modules its own binary was built with - so
 * each one gets the document computed for it. A rejection anywhere fails the whole apply and says
 * which host rejected it: a partial apply is a state to report, not to succeed at.
 */
export async function applyCaddyConfig() {
  // While an action's writes are being staged there is nothing to push yet: the values are in the
  // operator's change set, not the settings table, and the apply step reloads once for all of
  // them. Actions still call this unconditionally, so the decision lives here rather than in 20
  // call sites that would each have to remember.
  if (currentStagingScope()?.suppressApply) {
    return;
  }
  // A CRS plugin Coraza will not build is switched off rather than left to fail every apply.
  await loadWithCrsPluginRecovery(loadEveryAgent);
}

async function loadEveryAgent(): Promise<void> {
  const { broadcastCaddyAdmin, listAgentTargets } = await import("./agent/client");
  const targets = await listAgentTargets();

  // One agent, or none, goes through the single transport seam: its production adapter already
  // routes to that one agent, and broadcasting to it would be the same call with extra steps.
  // Keeping the common case on one seam is also what lets a test install one in-memory Caddy.
  if (targets.length <= 1) {
    await loadOne(targets[0] ?? null, "");
    return;
  }

  // Each agent adapts the snippets in its own document. Adapted routes are nested unmodified, and
  // an agent is trusted to describe its own Caddy, never to write another agent's config.
  const results = await broadcastCaddyAdmin(async (agent) => ({
    path: "/load",
    method: "POST",
    body: JSON.stringify(await buildCaddyDocument(agent.agentRowId, { adaptVia: agent.agentId })),
  }));
  const unreachable = results.filter((result) => !result.ok);
  if (unreachable.length > 0) {
    logCaddyApplyFailure("Caddy admin request failed", undefined, {
      unreachableAgents: unreachable.length,
    });
    throw new CaddyApplyError(
      `Unable to reach Caddy API on ${unreachable.map((r) => r.agent).join(", ")}`,
      "CADDY_UNREACHABLE",
    );
  }

  for (const result of results) {
    if (!result.ok) continue;
    assertCaddyAccepted(result.value, result.agent);
  }

  // Every agent accepted, so record what each is serving for the monitor to compare against.
  await Promise.all(targets.map((target) => noteAppliedConfig(target.agentId)));
}

/**
 * Build one agent's document, with its snippets adapted by that agent, and load it through the
 * transport seam pinned to the same agent. Null is the Caddy reached with no agent attached.
 */
async function loadOne(
  agent: { agentId: string; agentRowId: number } | null,
  who: string,
): Promise<void> {
  const payload = JSON.stringify(
    await buildCaddyDocument(agent?.agentRowId, { adaptVia: agent?.agentId }),
  );
  let response: { status: number; text: string };
  try {
    response = await caddyAdminRequest({
      path: "/load",
      method: "POST",
      body: payload,
      agentId: agent?.agentId,
    });
  } catch (requestError) {
    logCaddyApplyFailure("Caddy admin request failed", requestError);
    if (isConnectionError(requestError)) {
      throw new CaddyApplyError("Unable to reach Caddy API", "CADDY_UNREACHABLE");
    }
    throw new CaddyApplyError("Failed to apply Caddy configuration", "CADDY_REQUEST_FAILED");
  }
  assertCaddyAccepted(response, who);
  await noteAppliedConfig(agent?.agentId);
}

/**
 * Rebuild and reload one agent's Caddy and no other: what the health monitor does for a Caddy that
 * restarted, so an agent reporting one cannot make the rest of the fleet reload.
 */
export async function applyCaddyConfigToAgent(agent: {
  agentId: string;
  agentRowId: number;
  name: string;
}): Promise<void> {
  if (currentStagingScope()?.suppressApply) return;
  await loadWithCrsPluginRecovery(() => loadOne(agent, agent.name));
}

/**
 * Dial address for Caddy to reach CPM internally: FORWARD_AUTH_INTERNAL_URL if set, else
 * "web:3000" when CADDY_API_URL names a Docker service, else derived from BASE_URL.
 */
function getCpmDialAddress(): string | null {
  const internalUrl = config.forwardAuthInternalUrl;
  if (internalUrl) {
    // Strip protocol, trailing slashes, and paths
    return internalUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }

  // CADDY_API_URL on a Docker service name → assume Docker networking, use the web service
  try {
    const caddyUrl = new URL(config.caddyApiUrl);
    if (
      caddyUrl.hostname !== "localhost" &&
      caddyUrl.hostname !== "127.0.0.1" &&
      caddyUrl.hostname !== "::1"
    ) {
      // Caddy is on a Docker network - CPM is the "web" service on port 3000
      return "web:3000";
    }
  } catch {
    // ignore
  }

  // Derive from BASE_URL (works for non-Docker setups)
  try {
    const url = new URL(config.baseUrl);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return `${url.hostname}:${port}`;
  } catch {
    return null;
  }
}

function parseAuthentikConfig(
  meta: ProxyHostAuthentikMeta | undefined | null,
): AuthentikRouteConfig | null {
  if (!meta?.enabled) {
    return null;
  }

  const outpostDomain = typeof meta.outpost_domain === "string" ? meta.outpost_domain.trim() : "";
  const outpostUpstream =
    typeof meta.outpost_upstream === "string" ? meta.outpost_upstream.trim() : "";
  if (!outpostDomain || !outpostUpstream) {
    return null;
  }

  const authEndpointRaw = typeof meta.auth_endpoint === "string" ? meta.auth_endpoint.trim() : "";
  const authEndpoint = authEndpointRaw || `/${outpostDomain}/auth/caddy`;

  const copyHeaders =
    Array.isArray(meta.copy_headers) && meta.copy_headers.length > 0
      ? meta.copy_headers
          .map((header) => header?.trim())
          .filter((header): header is string => Boolean(header))
      : DEFAULT_AUTHENTIK_HEADERS;

  const trustedProxies =
    Array.isArray(meta.trusted_proxies) && meta.trusted_proxies.length > 0
      ? meta.trusted_proxies
          .map((item) => item?.trim())
          .filter((item): item is string => Boolean(item))
      : DEFAULT_AUTHENTIK_TRUSTED_PROXIES;

  const setOutpostHostHeader =
    meta.set_outpost_host_header !== undefined ? Boolean(meta.set_outpost_host_header) : true;

  const protectedPaths =
    Array.isArray(meta.protected_paths) && meta.protected_paths.length > 0
      ? meta.protected_paths
          .map((path) => path?.trim())
          .filter((path): path is string => Boolean(path))
      : null;

  const excludedPaths =
    Array.isArray(meta.excluded_paths) && meta.excluded_paths.length > 0
      ? meta.excluded_paths
          .map((path) => path?.trim())
          .filter((path): path is string => Boolean(path))
      : null;

  return {
    enabled: true,
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

/**
 * Reads the generic forward-auth block into what the routes need, or null when the host must not
 * be published with it.
 *
 * Null is fail-closed only because of where it is used: the branch that emits these routes is
 * chosen by the same parse, so a host whose block will not parse falls through to being published
 * *unauthenticated*. That is why the model refuses to store an enabled block it cannot complete -
 * by the time the config is built the only remaining answer is a bad one. This re-validates
 * anyway: it reads the raw meta JSON, which a sync from an older master or a hand-edited row can
 * put anything into.
 */
function parseForwardAuthConfig(
  meta: ForwardAuthMeta | undefined | null,
): ForwardAuthRouteConfig | null {
  if (!meta?.enabled) return null;

  const upstreamRaw = typeof meta.auth_upstream === "string" ? meta.auth_upstream.trim() : "";
  if (!upstreamRaw) return null;

  let dialAddress: string;
  try {
    const url = new URL(upstreamRaw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    dialAddress = `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return null;
  }

  const provider = meta.provider === "custom" ? "custom" : "authelia";
  const endpointRaw = stripCaddyPlaceholders(
    typeof meta.auth_endpoint === "string" ? meta.auth_endpoint.trim() : "",
  );
  const authEndpoint =
    endpointRaw || (provider === "authelia" ? DEFAULT_AUTHELIA_FORWARD_AUTH_ENDPOINT : "");
  // A relative URI, and nothing that could split the request line: a control character in
  // there would be interpolated straight into the rewrite Caddy performs.
  if (!authEndpoint.startsWith("/")) return null;
  if ([...authEndpoint].some((char) => char < " " || char === "\u007f")) return null;

  const headerList = (values: unknown): string[] =>
    Array.isArray(values)
      ? values
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter((value) => value && HEADER_NAME_PATTERN.test(value))
          .map(canonicalHeaderName)
      : [];

  const copyHeadersRaw = headerList(meta.copy_headers);
  const copyHeaders =
    copyHeadersRaw.length > 0
      ? copyHeadersRaw
      : provider === "authelia"
        ? [...DEFAULT_AUTHELIA_FORWARD_AUTH_HEADERS]
        : [];

  const trustedProxiesRaw =
    Array.isArray(meta.trusted_proxies) && meta.trusted_proxies.length > 0
      ? meta.trusted_proxies
          .map((proxy) => proxy?.trim())
          .filter((proxy): proxy is string => Boolean(proxy))
      : DEFAULT_AUTHENTIK_TRUSTED_PROXIES;

  const paths = (values: unknown): string[] | null => {
    if (!Array.isArray(values) || values.length === 0) return null;
    const cleaned = values
      .map((value) => (typeof value === "string" ? stripCaddyPlaceholders(value.trim()) : ""))
      .filter(Boolean);
    return cleaned.length > 0 ? cleaned : null;
  };

  return {
    provider,
    dialAddress,
    authEndpoint,
    copyHeaders,
    trustedProxies: expandPrivateRanges(trustedProxiesRaw),
    apiSplit: Boolean(meta.api_split),
    apiBypassHeaders: headerList(meta.api_bypass_headers),
    protectedPaths: paths(meta.protected_paths),
    excludedPaths: paths(meta.excluded_paths),
  };
}

/**
 * The auth subrequest: a reverse proxy to the auth server with the request rewritten to its
 * verify endpoint, copying the identity headers it answers with onto the upstream request.
 *
 * With `api401`, a redirect from the auth server - "go and sign in at the portal" - becomes a bare
 * 401 instead. That is the whole point of the split: an API client or a WebSocket handshake cannot
 * follow a login page, and a 302 into HTML mid-stream is a worse error than the honest one.
 */
function buildGenericForwardAuthHandler(
  cfg: ForwardAuthRouteConfig,
  api401: boolean,
): Record<string, unknown> {
  // Canonical casing is required, not cosmetic: Caddy resolves the placeholder by literal lookup
  // in Go's canonicalised header map - see upstreamHeaderPlaceholder.
  const handleResponseRoutes: Record<string, unknown>[] = [{ handle: [{ handler: "vars" }] }];
  for (const headerName of cfg.copyHeaders) {
    const placeholder = upstreamHeaderPlaceholder(headerName);
    handleResponseRoutes.push({
      handle: [
        {
          handler: "headers",
          request: { set: { [headerName]: [placeholder] } },
        } as Record<string, unknown>,
      ],
      match: [{ not: [{ vars: { [placeholder]: [""] } }] }],
    });
  }

  const handleResponse: Record<string, unknown>[] = [
    { match: { status_code: [2] }, routes: handleResponseRoutes },
  ];
  if (api401) {
    handleResponse.push({
      match: { status_code: [301, 302, 303, 307, 308] },
      routes: [
        { handle: [{ handler: "static_response", status_code: 401, body: "Unauthorized" }] },
      ],
    });
  }

  const handler: Record<string, unknown> = {
    handler: "reverse_proxy",
    upstreams: [{ dial: cfg.dialAddress }],
    rewrite: { method: "GET", uri: cfg.authEndpoint },
    headers: {
      request: {
        set: {
          "X-Forwarded-Method": ["{http.request.method}"],
          "X-Forwarded-Uri": ["{http.request.uri}"],
          "X-Forwarded-Host": ["{http.request.hostport}"],
          "X-Forwarded-Proto": ["{http.request.scheme}"],
        },
      },
    },
    handle_response: handleResponse,
  };
  if (cfg.trustedProxies.length > 0) handler.trusted_proxies = [...cfg.trustedProxies];
  return handler;
}

/**
 * Every policy `http.reverse_proxy.selection_policies.*` registers in the shipped build.
 *
 * Anything outside this falls back to `random` rather than reaching Caddy: an unregistered policy
 * name is refused at load time, and Caddy refuses the whole document rather than the one route.
 */
const VALID_LB_POLICIES = [
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

function parseLoadBalancerConfig(
  meta: LoadBalancerMeta | undefined | null,
): LoadBalancerRouteConfig | null {
  if (!meta?.enabled) {
    return null;
  }

  const policy = meta.policy && VALID_LB_POLICIES.includes(meta.policy) ? meta.policy : "random";
  const policyHeaderField =
    typeof meta.policy_header_field === "string" ? meta.policy_header_field.trim() || null : null;
  const policyCookieName =
    typeof meta.policy_cookie_name === "string" ? meta.policy_cookie_name.trim() || null : null;
  const policyCookieSecret =
    typeof meta.policy_cookie_secret === "string" ? meta.policy_cookie_secret.trim() || null : null;
  const policyQueryKey =
    typeof meta.policy_query_key === "string" ? meta.policy_query_key.trim() || null : null;
  const policyChoose =
    typeof meta.policy_choose === "number" && Number.isInteger(meta.policy_choose)
      ? meta.policy_choose
      : null;
  const policyWeights =
    Array.isArray(meta.policy_weights) &&
    meta.policy_weights.every((w) => typeof w === "number" && Number.isInteger(w))
      ? meta.policy_weights
      : null;
  const tryDuration =
    typeof meta.try_duration === "string" ? meta.try_duration.trim() || null : null;
  const tryInterval =
    typeof meta.try_interval === "string" ? meta.try_interval.trim() || null : null;
  const retries =
    typeof meta.retries === "number" && Number.isFinite(meta.retries) && meta.retries >= 0
      ? meta.retries
      : null;

  let activeHealthCheck: LoadBalancerRouteConfig["activeHealthCheck"] = null;
  if (meta.active_health_check?.enabled) {
    activeHealthCheck = {
      enabled: true,
      uri:
        typeof meta.active_health_check.uri === "string"
          ? meta.active_health_check.uri.trim() || null
          : null,
      port:
        typeof meta.active_health_check.port === "number" &&
        Number.isFinite(meta.active_health_check.port) &&
        meta.active_health_check.port > 0
          ? meta.active_health_check.port
          : null,
      interval:
        typeof meta.active_health_check.interval === "string"
          ? meta.active_health_check.interval.trim() || null
          : null,
      timeout:
        typeof meta.active_health_check.timeout === "string"
          ? meta.active_health_check.timeout.trim() || null
          : null,
      status:
        typeof meta.active_health_check.status === "number" &&
        Number.isFinite(meta.active_health_check.status) &&
        meta.active_health_check.status >= 100
          ? meta.active_health_check.status
          : null,
      body:
        typeof meta.active_health_check.body === "string"
          ? meta.active_health_check.body.trim() || null
          : null,
      passes: activeCount(meta.active_health_check.passes),
      fails: activeCount(meta.active_health_check.fails),
      method:
        typeof meta.active_health_check.method === "string"
          ? meta.active_health_check.method.trim().toUpperCase() || null
          : null,
      requestBody:
        typeof meta.active_health_check.request_body === "string"
          ? meta.active_health_check.request_body.trim() || null
          : null,
      followRedirects: Boolean(meta.active_health_check.follow_redirects),
      headers:
        meta.active_health_check.headers &&
        typeof meta.active_health_check.headers === "object" &&
        Object.keys(meta.active_health_check.headers).length > 0
          ? meta.active_health_check.headers
          : null,
    };
  }

  let passiveHealthCheck: LoadBalancerRouteConfig["passiveHealthCheck"] = null;
  if (meta.passive_health_check?.enabled) {
    const unhealthyStatus = Array.isArray(meta.passive_health_check.unhealthy_status)
      ? meta.passive_health_check.unhealthy_status.filter(
          (s): s is number => typeof s === "number" && Number.isFinite(s) && s >= 100,
        )
      : null;

    passiveHealthCheck = {
      enabled: true,
      failDuration:
        typeof meta.passive_health_check.fail_duration === "string"
          ? meta.passive_health_check.fail_duration.trim() || null
          : null,
      maxFails:
        typeof meta.passive_health_check.max_fails === "number" &&
        Number.isFinite(meta.passive_health_check.max_fails) &&
        meta.passive_health_check.max_fails >= 0
          ? meta.passive_health_check.max_fails
          : null,
      unhealthyStatus: unhealthyStatus && unhealthyStatus.length > 0 ? unhealthyStatus : null,
      unhealthyLatency:
        typeof meta.passive_health_check.unhealthy_latency === "string"
          ? meta.passive_health_check.unhealthy_latency.trim() || null
          : null,
      unhealthyRequestCount: activeCount(meta.passive_health_check.unhealthy_request_count),
    };
  }

  return {
    enabled: true,
    policy,
    policyHeaderField,
    policyCookieName,
    policyCookieSecret,
    policyQueryKey,
    policyChoose,
    policyWeights,
    tryDuration,
    tryInterval,
    retries,
    activeHealthCheck,
    passiveHealthCheck,
  };
}

/** A positive whole count off the stored meta, or null. */
function activeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Layer 4's load balancing, which is a strict subset of the HTTP one.
 *
 * caddy-l4 accepts `selection_policy` and nothing else here - no retries, no try_duration, no
 * try_interval. Emitting one is not ignored: Caddy refuses the whole document with `unknown field`,
 * so a single L4 host with retries set would take down every route in the config, not just its own.
 * Verified against `caddy validate` on the shipped image rather than inferred from the HTTP shape.
 */
function buildL4LoadBalancingConfig(
  config: LoadBalancerRouteConfig,
  upstreamCount?: number,
): Record<string, unknown> | null {
  const selectionPolicy: Record<string, unknown> = { policy: config.policy };

  if (config.policy === "random_choose" && config.policyChoose !== null) {
    selectionPolicy.choose = config.policyChoose;
  } else if (config.policy === "weighted_round_robin") {
    const weights = config.policyWeights;
    if (weights && (upstreamCount === undefined || weights.length === upstreamCount)) {
      selectionPolicy.weights = weights;
    } else {
      selectionPolicy.policy = "round_robin";
    }
  }

  return { selection_policy: selectionPolicy };
}

/**
 * Layer 4's health checks: `port`/`interval`/`timeout` active, `fail_duration`/`max_fails` passive.
 *
 * Everything else the HTTP checks carry - uri, expected status and body, passes, fails,
 * unhealthy_latency, unhealthy_request_count - is an HTTP concept caddy-l4 does not define, and
 * would be rejected the same way. There is no request at layer 4, only a dial.
 */
function buildL4HealthChecksConfig(
  config: LoadBalancerRouteConfig,
): Record<string, unknown> | null {
  const healthChecks: Record<string, unknown> = {};

  if (config.activeHealthCheck?.enabled) {
    const active: Record<string, unknown> = {};
    if (config.activeHealthCheck.port !== null) active.port = config.activeHealthCheck.port;
    if (config.activeHealthCheck.interval) active.interval = config.activeHealthCheck.interval;
    if (config.activeHealthCheck.timeout) active.timeout = config.activeHealthCheck.timeout;
    if (Object.keys(active).length > 0) healthChecks.active = active;
  }

  if (config.passiveHealthCheck?.enabled) {
    const passive: Record<string, unknown> = {};
    if (config.passiveHealthCheck.failDuration) {
      passive.fail_duration = config.passiveHealthCheck.failDuration;
    }
    if (config.passiveHealthCheck.maxFails !== null) {
      passive.max_fails = config.passiveHealthCheck.maxFails;
    }
    if (Object.keys(passive).length > 0) healthChecks.passive = passive;
  }

  return Object.keys(healthChecks).length > 0 ? healthChecks : null;
}

/**
 * `upstreamCount` is only read by `weighted_round_robin`, whose weights are positional against the
 * upstream list. A list that has drifted - an upstream added without a weight beside it - is
 * dropped rather than padded, because a backend silently reweighted to 0 stops receiving traffic
 * and nothing in the UI would say so.
 */
function buildLoadBalancingConfig(
  config: LoadBalancerRouteConfig,
  upstreamCount?: number,
): Record<string, unknown> | null {
  const loadBalancing: Record<string, unknown> = {};

  // Build selection policy
  const selectionPolicy: Record<string, unknown> = { policy: config.policy };

  if (config.policy === "header" && config.policyHeaderField) {
    selectionPolicy.policy = "header";
    selectionPolicy.field = config.policyHeaderField;
  } else if (config.policy === "cookie" && config.policyCookieName) {
    selectionPolicy.policy = "cookie";
    selectionPolicy.name = config.policyCookieName;
    if (config.policyCookieSecret) {
      selectionPolicy.secret = config.policyCookieSecret;
    }
  } else if (config.policy === "query" && config.policyQueryKey) {
    selectionPolicy.key = config.policyQueryKey;
  } else if (config.policy === "random_choose" && config.policyChoose !== null) {
    selectionPolicy.choose = config.policyChoose;
  } else if (config.policy === "weighted_round_robin") {
    const weights = config.policyWeights;
    if (weights && (upstreamCount === undefined || weights.length === upstreamCount)) {
      selectionPolicy.weights = weights;
    } else {
      // Without usable weights this policy is not configurable at all, so fall back to the
      // unweighted rotation rather than emitting a policy Caddy would reject outright.
      selectionPolicy.policy = "round_robin";
    }
  }

  loadBalancing.selection_policy = selectionPolicy;

  // Add retry settings
  if (config.tryDuration) {
    loadBalancing.try_duration = config.tryDuration;
  }
  if (config.tryInterval) {
    loadBalancing.try_interval = config.tryInterval;
  }
  if (config.retries !== null) {
    loadBalancing.retries = config.retries;
  }

  return Object.keys(loadBalancing).length > 0 ? loadBalancing : null;
}

type DnsResolverRouteConfig = {
  enabled: boolean;
  resolvers: string[];
  fallbacks: string[] | null;
  timeout: string | null;
};

function buildHealthChecksConfig(config: LoadBalancerRouteConfig): Record<string, unknown> | null {
  const healthChecks: Record<string, unknown> = {};

  // Active health checks
  if (config.activeHealthCheck?.enabled) {
    const active: Record<string, unknown> = {};

    if (config.activeHealthCheck.uri) {
      active.uri = config.activeHealthCheck.uri;
    }
    if (config.activeHealthCheck.port !== null) {
      active.port = config.activeHealthCheck.port;
    }
    if (config.activeHealthCheck.interval) {
      active.interval = config.activeHealthCheck.interval;
    }
    if (config.activeHealthCheck.passes !== null) {
      active.passes = config.activeHealthCheck.passes;
    }
    if (config.activeHealthCheck.fails !== null) {
      active.fails = config.activeHealthCheck.fails;
    }
    if (config.activeHealthCheck.method) {
      active.method = config.activeHealthCheck.method;
    }
    // `body` is what the probe *sends*; the expected response body is `expect_body` below. Caddy
    // names them that way round, and confusing the two makes every check fail closed.
    if (config.activeHealthCheck.requestBody) {
      active.body = config.activeHealthCheck.requestBody;
    }
    if (config.activeHealthCheck.followRedirects) {
      active.follow_redirects = true;
    }
    if (config.activeHealthCheck.headers) {
      active.headers = Object.fromEntries(
        Object.entries(config.activeHealthCheck.headers).map(([field, value]) => [field, [value]]),
      );
    }
    if (config.activeHealthCheck.timeout) {
      active.timeout = config.activeHealthCheck.timeout;
    }
    if (config.activeHealthCheck.status !== null) {
      active.expect_status = config.activeHealthCheck.status;
    }
    if (config.activeHealthCheck.body) {
      active.expect_body = config.activeHealthCheck.body;
    }

    if (Object.keys(active).length > 0) {
      healthChecks.active = active;
    }
  }

  // Passive health checks
  if (config.passiveHealthCheck?.enabled) {
    const passive: Record<string, unknown> = {};

    if (config.passiveHealthCheck.failDuration) {
      passive.fail_duration = config.passiveHealthCheck.failDuration;
    }
    if (config.passiveHealthCheck.maxFails !== null) {
      passive.max_fails = config.passiveHealthCheck.maxFails;
    }
    if (
      config.passiveHealthCheck.unhealthyStatus &&
      config.passiveHealthCheck.unhealthyStatus.length > 0
    ) {
      passive.unhealthy_status = config.passiveHealthCheck.unhealthyStatus;
    }
    if (config.passiveHealthCheck.unhealthyLatency) {
      passive.unhealthy_latency = config.passiveHealthCheck.unhealthyLatency;
    }
    if (config.passiveHealthCheck.unhealthyRequestCount !== null) {
      passive.unhealthy_request_count = config.passiveHealthCheck.unhealthyRequestCount;
    }

    if (Object.keys(passive).length > 0) {
      healthChecks.passive = passive;
    }
  }

  return Object.keys(healthChecks).length > 0 ? healthChecks : null;
}

function parseDnsResolverConfig(
  meta: DnsResolverMeta | undefined | null,
): DnsResolverRouteConfig | null {
  if (!meta?.enabled) {
    return null;
  }

  const resolvers = Array.isArray(meta.resolvers)
    ? meta.resolvers.map((r) => (typeof r === "string" ? r.trim() : "")).filter((r) => r.length > 0)
    : [];

  if (resolvers.length === 0) {
    return null;
  }

  const fallbacks = Array.isArray(meta.fallbacks)
    ? meta.fallbacks.map((r) => (typeof r === "string" ? r.trim() : "")).filter((r) => r.length > 0)
    : null;

  const timeout = typeof meta.timeout === "string" ? meta.timeout.trim() || null : null;

  return {
    enabled: true,
    resolvers,
    fallbacks: fallbacks && fallbacks.length > 0 ? fallbacks : null,
    timeout,
  };
}

function buildResolverConfig(dnsConfig: DnsResolverRouteConfig): Record<string, unknown> | null {
  if (!dnsConfig?.enabled || dnsConfig.resolvers.length === 0) {
    return null;
  }

  // Resolver addresses (primary + fallbacks); DNS resolvers need a port, defaulting to :53
  const formatResolver = (r: string) => {
    if (r.includes(":")) return r;
    return `${r}:53`;
  };

  const addresses = dnsConfig.resolvers.map(formatResolver);
  if (dnsConfig.fallbacks && dnsConfig.fallbacks.length > 0) {
    addresses.push(...dnsConfig.fallbacks.map(formatResolver));
  }

  return { addresses };
}
