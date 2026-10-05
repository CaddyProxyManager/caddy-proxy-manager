/**
 * Out of proxy-hosts/actions.ts: a "use server" module may only export actions, and the dashboard
 * host in Settings reads the same fields.
 */
import {
  type ForwardAuthProvider,
  type ProxyHostAuthentikInput,
  type ProxyHostForwardAuthInput,
  type ProxyHostInput,
  type LoadBalancerInput,
  type LoadBalancingPolicy,
  type DnsResolverInput,
  type UpstreamDnsResolutionInput,
  type GeoBlockMode,
  type WafHostConfig,
  type MtlsConfig,
  type RedirectRule,
  type RewriteConfig,
  type PathAllowRule,
  type PathBlockRule,
  type PathRewriteRule,
  type ErrorPageRule,
  type CpmForwardAuthInput,
  type TailscaleHostInput,
  PATH_BLOCK_STATUS_CODES,
  sanitizeErrorPageRules,
} from "@/src/lib/models/proxy-hosts";
import {
  normalizeWafPluginIds,
  normalizeWafPresetIds,
  parseWafIdListJson,
  parseBodyLimitMib,
} from "@/src/lib/waf/caddy";
import {
  type HostCacheConfig,
  hydrateHostCache,
  sanitizeHostCache,
} from "@/src/lib/proxy-hosts/cache";
import {
  type HostCompressionMode,
  sanitizeHostCompression,
} from "@/src/lib/proxy-hosts/compression";
import type { HostMaintenanceConfig } from "@/src/lib/proxy-hosts/maintenance";
import {
  type HostUpstreamTimeoutsConfig,
  UPSTREAM_TIMEOUT_KEYS,
} from "@/src/lib/proxy-hosts/upstream-timeouts";
import type { HostRateLimitConfig } from "@/src/lib/proxy-hosts/rate-limit";
import type { HostAnubisConfig } from "@/src/lib/proxy-hosts/anubis";
import { getCertificate } from "@/src/lib/models/certificates";
import { getCloudflareSettings, type GeoBlockSettings } from "@/src/lib/settings";
import {
  parseAccessListId,
  parseCertificateId,
  parseCheckbox,
  parseCsv,
  parseHostTags,
  parseOptionalNumber,
  parseOptionalText,
  parseUpstreams,
} from "@/src/lib/forms/form-parse";
import { parseAgentIds } from "@/src/lib/models/host-agents";

export async function validateAndSanitizeCertificateId(certificateId: number | null): Promise<{
  certificateId: number | null;
  /** English, for the server log. */
  warning?: string;
  /** For the operator-facing message in their language. */
  missing?: { id: number; cloudflareConfigured: boolean };
}> {
  if (certificateId === null) {
    return { certificateId: null };
  }

  const certificate = await getCertificate(certificateId);

  if (!certificate) {
    const cloudflareConfigured = !!(await getCloudflareSettings())?.apiToken;

    let warning: string;

    if (!cloudflareConfigured) {
      warning = `Certificate ID ${certificateId} not found. Automatically using 'Managed by Caddy (Auto)'. Note: Without Cloudflare DNS integration, wildcard certificates require port 80 to be accessible for HTTP-01 challenges. Configure Cloudflare in Settings to enable DNS-01 challenges.`;
    } else {
      warning = `Certificate ID ${certificateId} not found. Automatically using 'Managed by Caddy (Auto)' which will provision certificates automatically using Caddy.`;
    }

    return { certificateId: null, warning, missing: { id: certificateId, cloudflareConfigured } };
  }

  return { certificateId };
}

export function parseAuthentikConfig(formData: FormData): ProxyHostAuthentikInput | undefined {
  if (!formData.has("authentikPresent")) {
    return undefined;
  }

  const enabledIndicator = formData.has("authentikEnabledPresent");
  const enabledValue = enabledIndicator
    ? formData.has("authentikEnabled")
      ? parseCheckbox(formData.get("authentikEnabled"))
      : false
    : undefined;
  const outpostDomain = parseOptionalText(formData.get("authentikOutpostDomain"));
  const outpostUpstream = parseOptionalText(formData.get("authentikOutpostUpstream"));
  const authEndpoint = parseOptionalText(formData.get("authentikAuthEndpoint"));
  const copyHeaders = parseCsv(formData.get("authentikCopyHeaders"));
  const trustedProxies = parseCsv(formData.get("authentikTrustedProxies"));
  const protectedPaths = parseCsv(formData.get("authentikProtectedPaths"));
  const excludedPaths = parseCsv(formData.get("authentikExcludedPaths"));
  const setHostHeader = formData.has("authentikSetHostHeaderPresent")
    ? parseCheckbox(formData.get("authentikSetHostHeader"))
    : undefined;

  const result: ProxyHostAuthentikInput = {};
  if (enabledValue !== undefined) {
    result.enabled = enabledValue;
  }
  if (outpostDomain !== null) {
    result.outpostDomain = outpostDomain;
  }
  if (outpostUpstream !== null) {
    result.outpostUpstream = outpostUpstream;
  }
  if (authEndpoint !== null) {
    result.authEndpoint = authEndpoint;
  }
  if (copyHeaders.length > 0 || formData.has("authentikCopyHeaders")) {
    result.copyHeaders = copyHeaders;
  }
  if (trustedProxies.length > 0 || formData.has("authentikTrustedProxies")) {
    result.trustedProxies = trustedProxies;
  }
  if (protectedPaths.length > 0 || formData.has("authentikProtectedPaths")) {
    result.protectedPaths = protectedPaths;
  }
  if (excludedPaths.length > 0 || formData.has("authentikExcludedPaths")) {
    result.excludedPaths = excludedPaths;
  }
  if (setHostHeader !== undefined) {
    result.setOutpostHostHeader = setHostHeader;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/** Fields read only when rendered, so hidden advanced options are not cleared on save. */
export function parseForwardAuthConfig(formData: FormData): ProxyHostForwardAuthInput | undefined {
  if (!formData.has("forwardAuthPresent")) {
    return undefined;
  }

  const enabledValue = formData.has("forwardAuthEnabledPresent")
    ? parseCheckbox(formData.get("forwardAuthEnabled"))
    : undefined;
  const provider = parseOptionalText(formData.get("forwardAuthProvider"));
  const authUpstream = parseOptionalText(formData.get("forwardAuthUpstream"));
  const authEndpoint = parseOptionalText(formData.get("forwardAuthEndpoint"));
  const copyHeaders = parseCsv(formData.get("forwardAuthCopyHeaders"));
  const trustedProxies = parseCsv(formData.get("forwardAuthTrustedProxies"));
  const apiBypassHeaders = parseCsv(formData.get("forwardAuthApiBypassHeaders"));
  const protectedPaths = parseCsv(formData.get("forwardAuthProtectedPaths"));
  const excludedPaths = parseCsv(formData.get("forwardAuthExcludedPaths"));
  const apiSplit = formData.has("forwardAuthApiSplitPresent")
    ? parseCheckbox(formData.get("forwardAuthApiSplit"))
    : undefined;

  const result: ProxyHostForwardAuthInput = {};
  if (enabledValue !== undefined) result.enabled = enabledValue;
  // Passed through: the model validates it, and dropping it would store the wrong preset.
  if (provider !== null) result.provider = provider as ForwardAuthProvider;
  if (authUpstream !== null) result.authUpstream = authUpstream;
  if (authEndpoint !== null) result.authEndpoint = authEndpoint;
  if (copyHeaders.length > 0 || formData.has("forwardAuthCopyHeaders")) {
    result.copyHeaders = copyHeaders;
  }
  if (trustedProxies.length > 0 || formData.has("forwardAuthTrustedProxies")) {
    result.trustedProxies = trustedProxies;
  }
  if (apiSplit !== undefined) result.apiSplit = apiSplit;
  if (apiBypassHeaders.length > 0 || formData.has("forwardAuthApiBypassHeaders")) {
    result.apiBypassHeaders = apiBypassHeaders;
  }
  if (protectedPaths.length > 0 || formData.has("forwardAuthProtectedPaths")) {
    result.protectedPaths = protectedPaths;
  }
  if (excludedPaths.length > 0 || formData.has("forwardAuthExcludedPaths")) {
    result.excludedPaths = excludedPaths;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function parseCpmForwardAuthConfig(formData: FormData): CpmForwardAuthInput | undefined {
  if (!formData.has("cpmForwardAuthPresent")) {
    return undefined;
  }

  // The hidden input is always present (FormBooleanControls), so only the value means on or off.
  const enabledIndicator = formData.has("cpmForwardAuthEnabledPresent");
  const enabledValue = enabledIndicator
    ? parseCheckbox(formData.get("cpmForwardAuthEnabled"))
    : undefined;
  const protectedPaths = parseCsv(formData.get("cpmForwardAuthProtectedPaths"));
  const excludedPaths = parseCsv(formData.get("cpmForwardAuthExcludedPaths"));

  const result: CpmForwardAuthInput = {};
  if (enabledValue !== undefined) {
    result.enabled = enabledValue;
  }
  if (protectedPaths.length > 0 || formData.has("cpmForwardAuthProtectedPaths")) {
    result.protected_paths = protectedPaths.length > 0 ? protectedPaths : null;
  }
  if (excludedPaths.length > 0 || formData.has("cpmForwardAuthExcludedPaths")) {
    result.excluded_paths = excludedPaths.length > 0 ? excludedPaths : null;
  }
  // Only drawn while forward auth is on; absent, the host keeps what it had.
  if (formData.has("cpmForwardAuthRequireCaptcha")) {
    result.require_captcha = parseCheckbox(formData.get("cpmForwardAuthRequireCaptcha"));
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/** Fields read only when rendered, so options hidden behind the serve switch survive a save. */
export function parseTailscaleConfig(formData: FormData): TailscaleHostInput | undefined {
  if (!formData.has("tailscalePresent")) {
    return undefined;
  }

  const result: TailscaleHostInput = {};
  if (formData.has("tailscaleServe")) {
    result.serve = parseCheckbox(formData.get("tailscaleServe"));
  }
  if (formData.has("tailscaleNode")) {
    result.node = parseOptionalText(formData.get("tailscaleNode")) ?? "";
  }
  if (formData.has("tailscaleTailnetOnly")) {
    result.tailnetOnly = parseCheckbox(formData.get("tailscaleTailnetOnly"));
  }
  if (formData.has("tailscaleAuth")) {
    result.auth = parseCheckbox(formData.get("tailscaleAuth"));
  }
  if (formData.has("tailscaleProtectedPaths")) {
    const paths = parseCsv(formData.get("tailscaleProtectedPaths"));
    result.protected_paths = paths.length > 0 ? paths : null;
  }
  if (formData.has("tailscaleExcludedPaths")) {
    const paths = parseCsv(formData.get("tailscaleExcludedPaths"));
    result.excluded_paths = paths.length > 0 ? paths : null;
  }
  if (formData.has("tailscaleForwardIdentity")) {
    result.forwardIdentity = parseCheckbox(formData.get("tailscaleForwardIdentity"));
  }
  if (formData.has("tailscaleUpstreamNode")) {
    result.upstreamNode = parseOptionalText(formData.get("tailscaleUpstreamNode")) ?? "";
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function parseRedirectUrl(raw: FormDataEntryValue | null): string {
  if (!raw || typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return trimmed;
  } catch {
    return "";
  }
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

/** All or nothing: a weight silently dropped to 0 takes a backend out of rotation unseen. */
export function parseWeightList(value: FormDataEntryValue | null): number[] | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const weights = parts.map((part) => Number.parseInt(part, 10));
  return weights.every((w) => Number.isInteger(w) && w >= 0 && w <= 1000) ? weights : null;
}
const VALID_UPSTREAM_DNS_FAMILIES = ["ipv6", "ipv4", "both"] as const;

export function parseLoadBalancerConfig(formData: FormData): LoadBalancerInput | undefined {
  if (!formData.has("lbPresent")) {
    return undefined;
  }

  const enabledIndicator = formData.has("lbEnabledPresent");
  const enabledValue = enabledIndicator
    ? formData.has("lbEnabled")
      ? parseCheckbox(formData.get("lbEnabled"))
      : false
    : undefined;

  const policyRaw = parseOptionalText(formData.get("lbPolicy"));
  const policy =
    policyRaw && VALID_LB_POLICIES.includes(policyRaw as LoadBalancingPolicy)
      ? (policyRaw as LoadBalancingPolicy)
      : undefined;

  const policyHeaderField = parseOptionalText(formData.get("lbPolicyHeaderField"));
  const policyCookieName = parseOptionalText(formData.get("lbPolicyCookieName"));
  const policyCookieSecret = parseOptionalText(formData.get("lbPolicyCookieSecret"));
  const policyQueryKey = parseOptionalText(formData.get("lbPolicyQueryKey"));
  const policyChoose = parseOptionalNumber(formData.get("lbPolicyChoose"));
  const policyWeights = parseWeightList(formData.get("lbPolicyWeights"));
  const tryDuration = parseOptionalText(formData.get("lbTryDuration"));
  const tryInterval = parseOptionalText(formData.get("lbTryInterval"));
  const retries = parseOptionalNumber(formData.get("lbRetries"));

  const activeHealthEnabled = formData.has("lbActiveHealthEnabledPresent")
    ? formData.has("lbActiveHealthEnabled")
      ? parseCheckbox(formData.get("lbActiveHealthEnabled"))
      : false
    : undefined;

  let activeHealthCheck: LoadBalancerInput["activeHealthCheck"];
  if (activeHealthEnabled !== undefined || formData.has("lbActiveHealthUri")) {
    activeHealthCheck = {
      enabled: activeHealthEnabled,
      uri: parseOptionalText(formData.get("lbActiveHealthUri")),
      port: parseOptionalNumber(formData.get("lbActiveHealthPort")),
      interval: parseOptionalText(formData.get("lbActiveHealthInterval")),
      timeout: parseOptionalText(formData.get("lbActiveHealthTimeout")),
      status: parseOptionalNumber(formData.get("lbActiveHealthStatus")),
      body: parseOptionalText(formData.get("lbActiveHealthBody")),
      passes: parseOptionalNumber(formData.get("lbActiveHealthPasses")),
      fails: parseOptionalNumber(formData.get("lbActiveHealthFails")),
      method: parseOptionalText(formData.get("lbActiveHealthMethod")),
      requestBody: parseOptionalText(formData.get("lbActiveHealthRequestBody")),
      followRedirects: formData.has("lbActiveHealthFollowRedirectsPresent")
        ? parseCheckbox(formData.get("lbActiveHealthFollowRedirects"))
        : undefined,
    };
  }

  const passiveHealthEnabled = formData.has("lbPassiveHealthEnabledPresent")
    ? formData.has("lbPassiveHealthEnabled")
      ? parseCheckbox(formData.get("lbPassiveHealthEnabled"))
      : false
    : undefined;

  let passiveHealthCheck: LoadBalancerInput["passiveHealthCheck"];
  if (passiveHealthEnabled !== undefined || formData.has("lbPassiveHealthFailDuration")) {
    const unhealthyStatusRaw = parseOptionalText(formData.get("lbPassiveHealthUnhealthyStatus"));
    let unhealthyStatus: number[] | null = null;
    if (unhealthyStatusRaw) {
      unhealthyStatus = unhealthyStatusRaw
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n >= 100);
      if (unhealthyStatus.length === 0) {
        unhealthyStatus = null;
      }
    }

    passiveHealthCheck = {
      enabled: passiveHealthEnabled,
      failDuration: parseOptionalText(formData.get("lbPassiveHealthFailDuration")),
      maxFails: parseOptionalNumber(formData.get("lbPassiveHealthMaxFails")),
      unhealthyStatus,
      unhealthyLatency: parseOptionalText(formData.get("lbPassiveHealthUnhealthyLatency")),
      unhealthyRequestCount: parseOptionalNumber(
        formData.get("lbPassiveHealthUnhealthyRequestCount"),
      ),
    };
  }

  const result: LoadBalancerInput = {};
  if (enabledValue !== undefined) {
    result.enabled = enabledValue;
  }
  if (policy !== undefined) {
    result.policy = policy;
  }
  // Gated on presence, never value: `undefined` leaves a key alone and `null` deletes it, so an
  // emptied box clears while an unrendered policy's fields are left untouched.
  if (formData.has("lbPolicyHeaderField")) {
    result.policyHeaderField = policyHeaderField;
  }
  if (formData.has("lbPolicyCookieName")) {
    result.policyCookieName = policyCookieName;
  }
  if (formData.has("lbPolicyCookieSecret")) {
    result.policyCookieSecret = policyCookieSecret;
  }
  if (formData.has("lbPolicyQueryKey")) {
    result.policyQueryKey = policyQueryKey;
  }
  if (formData.has("lbPolicyChoose")) {
    result.policyChoose = policyChoose;
  }
  if (formData.has("lbPolicyWeights")) {
    result.policyWeights = policyWeights;
  }
  if (formData.has("lbTryDuration")) {
    result.tryDuration = tryDuration;
  }
  if (formData.has("lbTryInterval")) {
    result.tryInterval = tryInterval;
  }
  if (formData.has("lbRetries")) {
    result.retries = retries;
  }
  if (activeHealthCheck !== undefined) {
    result.activeHealthCheck = activeHealthCheck;
  }
  if (passiveHealthCheck !== undefined) {
    result.passiveHealthCheck = passiveHealthCheck;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function parseGeoBlockConfig(formData: FormData): {
  geoblock: GeoBlockSettings | null;
  geoblockMode: GeoBlockMode;
} {
  if (!formData.has("geoblockPresent")) {
    return { geoblock: null, geoblockMode: "merge" };
  }

  const enabled = parseCheckbox(formData.get("geoblockEnabled"));
  const rawMode = formData.get("geoblockMode");
  const mode: GeoBlockMode = rawMode === "override" ? "override" : "merge";

  const parseStringList = (key: string): string[] => {
    const val = formData.get(key);
    if (!val || typeof val !== "string") return [];
    return val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  };

  const parseNumberList = (key: string): number[] => {
    return parseStringList(key)
      .map((s) => parseInt(s, 10))
      .filter((n) => !Number.isNaN(n));
  };

  const config: GeoBlockSettings = {
    enabled,
    block_countries: parseStringList("geoblockBlockCountries"),
    block_continents: parseStringList("geoblockBlockContinents"),
    block_asns: parseNumberList("geoblockBlockAsns"),
    block_cidrs: parseStringList("geoblockBlockCidrs"),
    block_ips: parseStringList("geoblockBlockIps"),
    allow_countries: parseStringList("geoblockAllowCountries"),
    allow_continents: parseStringList("geoblockAllowContinents"),
    allow_asns: parseNumberList("geoblockAllowAsns"),
    allow_cidrs: parseStringList("geoblockAllowCidrs"),
    allow_ips: parseStringList("geoblockAllowIps"),
    trusted_proxies: parseStringList("geoblockTrustedProxies"),
    fail_closed: formData.get("geoblockFailClosed") === "on",
    response_status: (() => {
      const s = parseOptionalNumber(formData.get("geoblockResponseStatus")) ?? 403;
      return s >= 100 && s <= 599 ? s : 403;
    })(),
    response_body: parseOptionalText(formData.get("geoblockResponseBody")) ?? "Forbidden",
    response_headers: parseResponseHeaders(formData),
    redirect_url: parseRedirectUrl(formData.get("geoblockRedirectUrl")),
  };

  return { geoblock: config, geoblockMode: mode };
}

export function parseResponseHeaders(formData: FormData): Record<string, string> {
  const keys = formData.getAll("geoblockResponseHeadersKeys[]") as string[];
  const values = formData.getAll("geoblockResponseHeadersValues[]") as string[];
  const headers: Record<string, string> = {};
  keys.forEach((key, i) => {
    const trimmed = key.trim();
    if (trimmed && /^[a-zA-Z0-9\-_]+$/.test(trimmed)) {
      headers[trimmed] = (values[i] ?? "").trim();
    }
  });
  return headers;
}

export function parseWafConfig(formData: FormData): { waf?: WafHostConfig | null } {
  if (!formData.has("wafPresent")) return {};
  const enabled = parseCheckbox(formData.get("wafEnabled"));
  const rawMode = formData.get("wafMode");
  const wafMode: WafHostConfig["waf_mode"] = rawMode === "override" ? "override" : "merge";
  const rawEngineMode = formData.get("wafEngineMode");
  const engineMode: WafHostConfig["mode"] =
    rawEngineMode === "On" || rawEngineMode === "Off" || rawEngineMode === "DetectionOnly"
      ? rawEngineMode
      : undefined;
  const loadCrs = parseCheckbox(formData.get("wafLoadOwaspCrs"));
  const customDirectives =
    typeof formData.get("wafCustomDirectives") === "string"
      ? (formData.get("wafCustomDirectives") as string).trim()
      : "";
  const rawExcl = formData.get("wafExcludedRuleIds");
  const excluded_rule_ids: number[] = rawExcl
    ? parseWafIdListJson(rawExcl as string).filter(
        (x): x is number => Number.isInteger(x) && (x as number) > 0,
      )
    : [];
  const rawPresets = formData.get("wafPresetIds");
  const preset_ids = rawPresets
    ? normalizeWafPresetIds(parseWafIdListJson(rawPresets as string))
    : [];
  const rawPlugins = formData.get("wafPluginIds");
  const plugin_ids = rawPlugins
    ? normalizeWafPluginIds(parseWafIdListJson(rawPlugins as string))
    : [];

  if (!enabled) {
    return { waf: { enabled: false, waf_mode: wafMode } };
  }

  // Blank inherits the global limits; createProxyHost/updateProxyHost re-validate.
  const requestBodyLimit = parseBodyLimitMib(
    formData.get("wafRequestBodyLimitMb"),
    "hostWafRequestBodyLimitInvalid",
  );
  const requestBodyInMemoryLimit = parseBodyLimitMib(
    formData.get("wafRequestBodyInMemoryLimitMb"),
    "hostWafInMemoryBodyLimitInvalid",
  );
  const rawLimitAction = formData.get("wafRequestBodyLimitAction");
  const requestBodyLimitAction =
    rawLimitAction === "Reject" || rawLimitAction === "ProcessPartial" ? rawLimitAction : undefined;

  return {
    waf: {
      enabled: true,
      mode: engineMode,
      load_owasp_crs: loadCrs,
      custom_directives: customDirectives,
      excluded_rule_ids,
      ...(preset_ids.length > 0 ? { preset_ids } : {}),
      ...(plugin_ids.length > 0 ? { plugin_ids } : {}),
      waf_mode: wafMode,
      ...(requestBodyLimit !== undefined ? { request_body_limit: requestBodyLimit } : {}),
      ...(requestBodyInMemoryLimit !== undefined
        ? { request_body_in_memory_limit: requestBodyInMemoryLimit }
        : {}),
      ...(requestBodyLimitAction ? { request_body_limit_action: requestBodyLimitAction } : {}),
    },
  };
}

export function parseDnsResolverConfig(formData: FormData): DnsResolverInput | undefined {
  if (!formData.has("dnsPresent")) {
    return undefined;
  }

  const enabledIndicator = formData.has("dnsEnabledPresent");
  const enabledValue = enabledIndicator
    ? formData.has("dnsEnabled")
      ? parseCheckbox(formData.get("dnsEnabled"))
      : false
    : undefined;

  const resolversRaw = parseOptionalText(formData.get("dnsResolvers"));
  let resolvers: string[] | undefined;
  if (resolversRaw || formData.has("dnsResolvers")) {
    resolvers = resolversRaw
      ? resolversRaw
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
  }

  const fallbacksRaw = parseOptionalText(formData.get("dnsFallbacks"));
  let fallbacks: string[] | null = null;
  if (fallbacksRaw) {
    fallbacks = fallbacksRaw
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (fallbacks.length === 0) {
      fallbacks = null;
    }
  }

  const timeout = parseOptionalText(formData.get("dnsTimeout"));

  const result: DnsResolverInput = {};
  if (enabledValue !== undefined) {
    result.enabled = enabledValue;
  }
  if (resolvers !== undefined) {
    result.resolvers = resolvers;
  }
  if (fallbacks !== null) {
    result.fallbacks = fallbacks;
  }
  if (timeout !== null) {
    result.timeout = timeout;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function parseMtlsConfig(formData: FormData): MtlsConfig | null {
  if (!formData.has("mtlsPresent")) return null;
  const enabled = formData.get("mtlsEnabled") === "true";
  if (!enabled) return null;
  const certIds = formData
    .getAll("mtlsCertId")
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  const roleIds = formData
    .getAll("mtlsRoleId")
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  const protectedPaths = parseCsv(formData.get("mtlsProtectedPaths"));
  const excludedPaths = parseCsv(formData.get("mtlsExcludedPaths"));
  return {
    enabled,
    trusted_client_cert_ids: certIds,
    trusted_role_ids: roleIds,
    protected_paths: protectedPaths.length > 0 ? protectedPaths : null,
    excluded_paths: excludedPaths.length > 0 ? excludedPaths : null,
  };
}

export function parseRedirectsConfig(formData: FormData): RedirectRule[] | null {
  const raw = formData.get("redirectsJson");
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (r) =>
        r &&
        typeof r.from === "string" &&
        typeof r.to === "string" &&
        [301, 302, 307, 308].includes(r.status),
    ) as RedirectRule[];
  } catch {
    return null;
  }
}

export function parseLocationRulesConfig(
  formData: FormData,
): import("@/src/lib/models/proxy-hosts").LocationRuleInput[] | null {
  const raw = formData.get("locationRulesJson");
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function parseRewriteConfig(formData: FormData): RewriteConfig | null {
  const prefix = formData.get("rewritePathPrefix");
  if (!prefix || typeof prefix !== "string" || !prefix.trim()) return null;
  return { path_prefix: prefix.trim() };
}

/** Undefined without the section, null when switched off. */
export function parseCacheConfig(formData: FormData): HostCacheConfig | null | undefined {
  if (!formData.has("cachePresent")) return undefined;
  if (!parseCheckbox(formData.get("cacheEnabled"))) return null;
  return hydrateHostCache(
    sanitizeHostCache({ mode: formData.get("cacheMode"), maxAge: formData.get("cacheMaxAge") }),
  );
}

/** Undefined without the field, so a form that does not render it leaves the host's choice. */
export function parseCompressionMode(formData: FormData): HostCompressionMode | undefined {
  return formData.has("compression")
    ? sanitizeHostCompression(formData.get("compression"))
    : undefined;
}

/** Undefined without the card. Ranges are checked by the model, which names the bad one. */
export function parseMaintenanceConfig(
  formData: FormData,
): Partial<HostMaintenanceConfig> | undefined {
  if (!formData.has("maintenancePresent")) return undefined;
  const text = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value : "";
  };
  return {
    enabled: parseCheckbox(formData.get("maintenanceEnabled")),
    retryAfter: text("maintenanceRetryAfter").trim() ? Number(text("maintenanceRetryAfter")) : null,
    bypassCidrs: text("maintenanceBypass")
      .split(/[\s,]+/)
      .filter(Boolean),
    body: text("maintenanceBody").replace(/\r\n?/g, "\n") || null,
  };
}

/** Undefined without the card, null with it switched off. Durations are checked by the model. */
export function parseUpstreamTimeoutsConfig(
  formData: FormData,
): Partial<HostUpstreamTimeoutsConfig> | null | undefined {
  if (!formData.has("upstreamTimeoutsPresent")) return undefined;
  if (!parseCheckbox(formData.get("upstreamTimeoutsEnabled"))) return null;
  return Object.fromEntries(
    UPSTREAM_TIMEOUT_KEYS.map((key) => [
      key,
      parseOptionalText(formData.get(`upstreamTimeouts.${key}`)),
    ]),
  );
}

/** Undefined without the card. Zones are kept while it is off, and checked by the model. */
export function parseRateLimitConfig(formData: FormData): HostRateLimitConfig | undefined {
  if (!formData.has("rateLimitPresent")) return undefined;
  const raw = formData.get("rateLimitZonesJson");
  let zones: unknown = [];
  try {
    zones = typeof raw === "string" && raw ? JSON.parse(raw) : [];
  } catch {
    zones = [];
  }
  const mode = formData.get("rateLimitMode");
  return {
    enabled: parseCheckbox(formData.get("rateLimitEnabled")),
    zones: (Array.isArray(zones) ? zones : []) as HostRateLimitConfig["zones"],
    ...(typeof mode === "string" && mode ? { mode: mode as HostRateLimitConfig["mode"] } : {}),
  };
}

/** Undefined without the card, so a form that does not render it leaves the host's choice. */
/** Undefined without the card. Kept while off; the model checks the URL and the paths. */
export function parseAnubisConfig(formData: FormData): Partial<HostAnubisConfig> | undefined {
  if (!formData.has("anubisPresent")) return undefined;
  const text = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
  };
  return {
    enabled: parseCheckbox(formData.get("anubisEnabled")),
    upstream: text("anubisUpstream") || null,
    exemptPaths: text("anubisExemptPaths")
      .split(/[\s,]+/)
      .filter(Boolean),
  };
}

export function parseCrowdSecEnabled(formData: FormData): boolean | undefined {
  if (!formData.has("crowdsecPresent")) return undefined;
  return parseCheckbox(formData.get("crowdsecEnabled"));
}

export function parsePathAllowsConfig(formData: FormData): PathAllowRule[] | null {
  const raw = formData.get("pathAllowsJson");
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (r) => r && typeof r.path === "string" && r.path.trim(),
    ) as PathAllowRule[];
  } catch {
    return null;
  }
}

export function parsePathBlocksConfig(formData: FormData): PathBlockRule[] | null {
  const raw = formData.get("pathBlocksJson");
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const valid = PATH_BLOCK_STATUS_CODES as readonly number[];
    return parsed.filter(
      (r) =>
        r && typeof r.path === "string" && typeof r.status === "number" && valid.includes(r.status),
    ) as PathBlockRule[];
  } catch {
    return null;
  }
}

export function parsePathRewritesConfig(formData: FormData): PathRewriteRule[] | null {
  const raw = formData.get("pathRewritesJson");
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (r) => r && typeof r.from === "string" && typeof r.to === "string",
    ) as PathRewriteRule[];
  } catch {
    return null;
  }
}

export function parseErrorPagesConfig(formData: FormData): ErrorPageRule[] | null {
  const raw = formData.get("errorPagesJson");
  if (!raw || typeof raw !== "string") return null;
  try {
    return sanitizeErrorPageRules(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function parseUpstreamDnsResolutionConfig(
  formData: FormData,
): UpstreamDnsResolutionInput | undefined {
  if (!formData.has("upstreamDnsResolutionPresent")) {
    return undefined;
  }

  const modeRaw = parseOptionalText(formData.get("upstreamDnsResolutionMode")) ?? "inherit";
  const familyRaw = parseOptionalText(formData.get("upstreamDnsResolutionFamily")) ?? "inherit";

  const result: UpstreamDnsResolutionInput = {};

  if (modeRaw === "enabled") {
    result.enabled = true;
  } else if (modeRaw === "disabled") {
    result.enabled = false;
  } else if (modeRaw === "inherit") {
    result.enabled = null;
  }

  if (familyRaw === "inherit") {
    result.family = null;
  } else if (
    VALID_UPSTREAM_DNS_FAMILIES.includes(familyRaw as (typeof VALID_UPSTREAM_DNS_FAMILIES)[number])
  ) {
    result.family = familyRaw as "ipv6" | "ipv4" | "both";
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * An unrendered section is `undefined`, and so left alone. Name, domains, upstreams, certificate,
 * access list and agents are the caller's.
 */
export function parseProxyHostOptionUpdates(formData: FormData): Partial<ProxyHostInput> {
  const boolField = (key: string) =>
    formData.has(`${key}Present`) ? parseCheckbox(formData.get(key)) : undefined;
  return {
    sslForced: boolField("sslForced"),
    hstsEnabled: boolField("hstsEnabled"),
    hstsSubdomains: boolField("hstsSubdomains"),
    allowWebsocket: boolField("allowWebsocket"),
    preserveHostHeader: boolField("preserveHostHeader"),
    skipHttpsHostnameValidation: boolField("skipHttpsHostnameValidation"),
    discourageIndexing: boolField("discourageIndexing"),
    customPreHandlersJson: formData.has("customPreHandlersJson")
      ? parseOptionalText(formData.get("customPreHandlersJson"))
      : undefined,
    customReverseProxyJson: formData.has("customReverseProxyJson")
      ? parseOptionalText(formData.get("customReverseProxyJson"))
      : undefined,
    customCaddyfile: formData.has("customCaddyfile")
      ? parseOptionalText(formData.get("customCaddyfile"))
      : undefined,
    authentik: parseAuthentikConfig(formData),
    forwardAuth: parseForwardAuthConfig(formData),
    cpmForwardAuth: parseCpmForwardAuthConfig(formData),
    tailscale: parseTailscaleConfig(formData),
    loadBalancer: parseLoadBalancerConfig(formData),
    dnsResolver: parseDnsResolverConfig(formData),
    upstreamDnsResolution: parseUpstreamDnsResolutionConfig(formData),
    // parseGeoBlockConfig reads no section as "no rules", which is creation's default, not an edit.
    ...(formData.has("geoblockPresent") ? parseGeoBlockConfig(formData) : {}),
    ...parseWafConfig(formData),
    mtls: formData.has("mtlsPresent") ? parseMtlsConfig(formData) : undefined,
    redirects: formData.has("redirectsJson") ? parseRedirectsConfig(formData) : undefined,
    rewrite: formData.has("rewritePathPrefix") ? parseRewriteConfig(formData) : undefined,
    cache: parseCacheConfig(formData),
    compression: parseCompressionMode(formData),
    maintenance: parseMaintenanceConfig(formData),
    upstreamTimeouts: parseUpstreamTimeoutsConfig(formData),
    rateLimit: parseRateLimitConfig(formData),
    crowdsec: parseCrowdSecEnabled(formData),
    anubis: parseAnubisConfig(formData),
    locationRules: formData.has("locationRulesJson")
      ? parseLocationRulesConfig(formData)
      : undefined,
    pathAllows: formData.has("pathAllowsJson") ? parsePathAllowsConfig(formData) : undefined,
    pathBlocks: formData.has("pathBlocksJson") ? parsePathBlocksConfig(formData) : undefined,
    pathRewrites: formData.has("pathRewritesJson") ? parsePathRewritesConfig(formData) : undefined,
    errorPages: formData.has("errorPagesJson") ? parseErrorPagesConfig(formData) : undefined,
  };
}

export type ForwardAuthAccessInput = { userIds: number[]; groupIds: number[] };

/** The editor's whole form, as the save action and the review step both read it. */
export type ParsedProxyHostForm<T> = {
  input: T;
  /** Who may sign in through CPM's portal; undefined leaves the stored grants alone. */
  forwardAuthAccess?: ForwardAuthAccessInput;
  /** A picked certificate that no longer exists, so the host falls back to automatic TLS. */
  missingCertificate?: { id: number; cloudflareConfigured: boolean };
};

function parseForwardAuthAccess(formData: FormData): ForwardAuthAccessInput {
  const ids = (key: string) =>
    formData
      .getAll(key)
      .map((v) => Number(v))
      .filter((n) => n > 0);
  return { userIds: ids("cpmFaUserId"), groupIds: ids("cpmFaGroupId") };
}

export async function parseProxyHostCreateForm(
  formData: FormData,
): Promise<ParsedProxyHostForm<ProxyHostInput>> {
  const boolField = (key: string) =>
    formData.has(`${key}Present`) ? parseCheckbox(formData.get(key)) : undefined;
  const { certificateId, warning, missing } = await validateAndSanitizeCertificateId(
    parseCertificateId(formData.get("certificateId")),
  );
  if (warning) console.warn(`[proxy host form] ${warning}`);

  const input: ProxyHostInput = {
    name: String(formData.get("name") ?? "Untitled"),
    description: formData.has("description") ? String(formData.get("description")) : undefined,
    tags: parseHostTags(formData),
    domains: parseCsv(formData.get("domains")),
    upstreams: parseUpstreams(formData.get("upstreams")),
    // Empty means every agent, as an absent field does, so older clients keep working.
    agentIds: parseAgentIds(formData.getAll("agentId")),
    certificateId,
    accessListId: parseAccessListId(formData.get("accessListId")),
    // An absent marker takes the model's default, so a form without a toggle keeps it on.
    sslForced: boolField("sslForced"),
    hstsEnabled: boolField("hstsEnabled"),
    hstsSubdomains: parseCheckbox(formData.get("hstsSubdomains")),
    allowWebsocket: boolField("allowWebsocket"),
    preserveHostHeader: boolField("preserveHostHeader"),
    skipHttpsHostnameValidation: parseCheckbox(formData.get("skipHttpsHostnameValidation")),
    discourageIndexing: boolField("discourageIndexing"),
    enabled: parseCheckbox(formData.get("enabled")),
    customPreHandlersJson: parseOptionalText(formData.get("customPreHandlersJson")),
    customReverseProxyJson: parseOptionalText(formData.get("customReverseProxyJson")),
    customCaddyfile: parseOptionalText(formData.get("customCaddyfile")),
    authentik: parseAuthentikConfig(formData),
    forwardAuth: parseForwardAuthConfig(formData),
    cpmForwardAuth: parseCpmForwardAuthConfig(formData),
    tailscale: parseTailscaleConfig(formData),
    loadBalancer: parseLoadBalancerConfig(formData),
    dnsResolver: parseDnsResolverConfig(formData),
    upstreamDnsResolution: parseUpstreamDnsResolutionConfig(formData),
    ...parseGeoBlockConfig(formData),
    ...parseWafConfig(formData),
    mtls: parseMtlsConfig(formData),
    redirects: parseRedirectsConfig(formData),
    rewrite: parseRewriteConfig(formData),
    cache: parseCacheConfig(formData) ?? null,
    compression: parseCompressionMode(formData),
    maintenance: parseMaintenanceConfig(formData),
    upstreamTimeouts: parseUpstreamTimeoutsConfig(formData),
    rateLimit: parseRateLimitConfig(formData),
    crowdsec: parseCrowdSecEnabled(formData),
    anubis: parseAnubisConfig(formData),
    locationRules: parseLocationRulesConfig(formData),
    pathAllows: parsePathAllowsConfig(formData),
    pathBlocks: parsePathBlocksConfig(formData),
    pathRewrites: parsePathRewritesConfig(formData),
    errorPages: parseErrorPagesConfig(formData),
  };
  const access = parseForwardAuthAccess(formData);
  const hasAccess = access.userIds.length > 0 || access.groupIds.length > 0;
  return {
    input,
    forwardAuthAccess: input.cpmForwardAuth?.enabled && hasAccess ? access : undefined,
    missingCertificate: missing,
  };
}

/** Every field gated on presence: a partial form changes only what it carries. */
export async function parseProxyHostUpdateForm(
  formData: FormData,
): Promise<ParsedProxyHostForm<Partial<ProxyHostInput>>> {
  const boolField = (key: string) =>
    formData.has(`${key}Present`) ? parseCheckbox(formData.get(key)) : undefined;

  let certificateId: number | null | undefined;
  let missing: ParsedProxyHostForm<unknown>["missingCertificate"];
  if (formData.has("certificateId")) {
    const validation = await validateAndSanitizeCertificateId(
      parseCertificateId(formData.get("certificateId")),
    );
    certificateId = validation.certificateId;
    missing = validation.missing;
    if (validation.warning) console.warn(`[proxy host form] ${validation.warning}`);
  }

  const input: Partial<ProxyHostInput> = {
    name: formData.get("name") ? String(formData.get("name")) : undefined,
    description: formData.has("description") ? String(formData.get("description")) : undefined,
    tags: parseHostTags(formData),
    domains: formData.get("domains") ? parseCsv(formData.get("domains")) : undefined,
    upstreams: formData.get("upstreams") ? parseUpstreams(formData.get("upstreams")) : undefined,
    // Gated on the marker: an empty list is a real edit ("everywhere"), not an absent field.
    agentIds: formData.has("agentAssignmentPresent")
      ? parseAgentIds(formData.getAll("agentId"))
      : undefined,
    certificateId,
    accessListId: formData.has("accessListId")
      ? parseAccessListId(formData.get("accessListId"))
      : undefined,
    ...parseProxyHostOptionUpdates(formData),
    enabled: boolField("enabled"),
  };
  return {
    input,
    forwardAuthAccess: formData.has("cpmForwardAuthPresent")
      ? parseForwardAuthAccess(formData)
      : undefined,
    missingCertificate: missing,
  };
}
