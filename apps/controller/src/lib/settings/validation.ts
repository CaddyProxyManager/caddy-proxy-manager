import { isHostname } from "../dashboard-host";
import { ipVersion } from "../http/ip-version";
import {
  CORAZA_MAX_BODY_LIMIT,
  CORAZA_MIN_BODY_LIMIT,
  customDirectivesError,
  isValidBodyLimit,
  seclangErrorDetails,
} from "../waf/caddy";
import {
  DomainError,
  type DomainErrorCode,
  type DomainErrorParams,
  domainErrorMessage,
} from "../errors/domain-error";
import {
  CACHE_STORAGES,
  CDN_PROVIDERS,
  normalizeHttpCacheSettings,
} from "../proxy-hosts/http-cache";
import { seclangErrors } from "../waf/seclang";
import { MAX_ANOMALY_THRESHOLD, MIN_ANOMALY_THRESHOLD } from "../waf/tuning";
import { normalizeDefaultResponseSettings } from "../caddy/default-response";
import { normalizeTailscaleSettings } from "../caddy/tailscale";
import { normalizeCrowdSecSettings } from "../caddy/crowdsec";
import { normalizeGlobalRateLimitInput } from "../proxy-hosts/rate-limit-global";
import { DEFAULT_HOST_DEFAULTS } from "../proxy-hosts/host-defaults";
import { HOST_COMPRESSION_MODES } from "../proxy-hosts/compression";
import { getProviderDefinition, isValidDnsDuration } from "../dns/providers";
import {
  ACMEDNS_PROVIDER,
  MAX_DNS_DELEGATIONS,
  normalizeDnsName,
} from "../dns/challenge-delegation";
import { isEmailAddress } from "../email/address";
import { MAX_MFA_GRACE_DAYS, MFA_POLICY_MODES } from "../auth/two-factor/mfa-policy";

/**
 * A `DomainError`, so the setup screen and the dashboard translate it; `/api/v1` keeps the English.
 * A field path stays a `{field}` param: "general.acmeEmail" is a name a translator keeps verbatim.
 */
export class SettingsValidationError extends DomainError {
  constructor(code: DomainErrorCode, params: DomainErrorParams = {}) {
    super(code, params, domainErrorMessage(code, params), 400);
    this.name = "SettingsValidationError";
  }
}

export const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_SHORT_STRING = 2048;
const MAX_SECRET_LENGTH = 16 * 1024;
const MAX_LIST_ITEMS = 1024;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CONTINENTS = new Set(["AF", "AN", "AS", "EU", "NA", "OC", "SA"]);

function invalid(code: DomainErrorCode, params: DomainErrorParams = {}): never {
  throw new SettingsValidationError(code, params);
}

/** A normalizer's own refusal, re-raised as this group's so the REST route still answers 400. */
function invalidFrom(error: unknown): never {
  if (error instanceof DomainError) invalid(error.code, error.params);
  throw error;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("settingsFieldNotObject", { field: label });
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    invalid("settingsUnknownField", { field: label, key: unexpected[0] });
  }
}

function required(value: Record<string, unknown>, key: string, label: string): unknown {
  if (!Object.hasOwn(value, key)) {
    invalid("settingsFieldRequired", { field: `${label}.${key}` });
  }
  return value[key];
}

export function hasForbiddenControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function stringValue(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; controls?: boolean } = {},
): string {
  if (typeof value !== "string") invalid("settingsFieldNotString", { field: label });
  const min = options.min ?? 0;
  const max = options.max ?? MAX_SHORT_STRING;
  if (value.length < min || value.length > max) {
    invalid("settingsFieldLength", { field: label, min, max });
  }
  if (options.controls !== true && hasForbiddenControlCharacter(value)) {
    invalid("settingsFieldControlCharacters", { field: label });
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalid("settingsFieldNotBoolean", { field: label });
  return value;
}

function integerValue(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    invalid("settingsFieldIntegerRange", { field: label, min, max });
  }
  return value;
}

function oneOf(value: unknown, allowed: readonly string[], label: string): void {
  if (!allowed.includes(value as string)) invalid("settingsFieldOneOf", { field: label, allowed });
}

function optionalOneOf(value: unknown, allowed: readonly string[], label: string): void {
  if (value !== undefined) oneOf(value, allowed, label);
}

function stringList(
  value: unknown,
  label: string,
  validate?: (item: string, itemLabel: string) => void,
): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    invalid("settingsFieldArrayMax", { field: label, max: MAX_LIST_ITEMS });
  }
  return value.map((item, index) => {
    const itemLabel = `${label}[${index}]`;
    const parsed = stringValue(item, itemLabel, { min: 1 });
    validate?.(parsed, itemLabel);
    return parsed;
  });
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  label: string,
  max = MAX_SHORT_STRING,
): void {
  if (value[key] !== undefined) stringValue(value[key], `${label}.${key}`, { max });
}

function optionalMultilineString(
  value: Record<string, unknown>,
  key: string,
  label: string,
  max: number,
): void {
  if (value[key] === undefined) return;
  const parsed = stringValue(value[key], `${label}.${key}`, { max, controls: true });
  for (let index = 0; index < parsed.length; index += 1) {
    const code = parsed.charCodeAt(index);
    if ((code < 32 && code !== 10 && code !== 13) || code === 127) {
      invalid("settingsFieldControlCharactersMultiline", { field: `${label}.${key}` });
    }
  }
}

function optionalBoolean(value: Record<string, unknown>, key: string, label: string): void {
  if (value[key] !== undefined) booleanValue(value[key], `${label}.${key}`);
}

function httpUrl(value: string, label: string, allowEmpty = false): void {
  if (allowEmpty && value.length === 0) return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalid("settingsFieldNotHttpUrl", { field: label });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    invalid("settingsFieldUrlScheme", { field: label });
  }
}

function ipOrCidr(value: string, label: string, allowPrivateRanges = false): void {
  if (allowPrivateRanges && value === "private_ranges") return;
  const separator = value.lastIndexOf("/");
  if (separator === -1) {
    if (ipVersion(value) === 0) invalid("settingsFieldNotIpOrCidr", { field: label });
    return;
  }
  const address = value.slice(0, separator);
  const version = ipVersion(address);
  const prefix = Number(value.slice(separator + 1));
  const maxPrefix = version === 4 ? 32 : version === 6 ? 128 : -1;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    invalid("settingsFieldNotIpOrCidr", { field: label });
  }
}

function headerMap(value: unknown, label: string): void {
  const headers = record(value, label);
  if (Object.keys(headers).length > 100)
    invalid("settingsFieldTooMany", { field: label, max: 100 });
  for (const [name, rawValue] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name) || name.length > 128)
      invalid("settingsHeaderNameInvalid", { field: label });
    stringValue(rawValue, `${label}.${name}`, { max: 8192 });
  }
}

function validateGeneral(value: Record<string, unknown>): void {
  onlyKeys(value, ["defaultDomain", "acmeEmail"], "general settings");
  stringValue(required(value, "defaultDomain", "general settings"), "general.defaultDomain", {
    min: 1,
    max: 253,
  });
  if (value.acmeEmail !== undefined) {
    const email = stringValue(value.acmeEmail, "general.acmeEmail", { max: 320 });
    if (email.length > 0 && !isEmailAddress(email, "public"))
      invalid("settingsFieldNotEmail", { field: "general.acmeEmail" });
  }
}

function validateAcme(value: Record<string, unknown>): void {
  onlyKeys(value, ["caUrl", "caRootPem"], "ACME settings");
  optionalString(value, "caUrl", "acme", 4096);
  optionalMultilineString(value, "caRootPem", "acme", 1024 * 1024);
  if (typeof value.caUrl === "string" && value.caUrl.length > 0) httpUrl(value.caUrl, "acme.caUrl");
}

function validateCloudflare(value: Record<string, unknown>): void {
  onlyKeys(value, ["apiToken", "zoneId", "accountId"], "Cloudflare settings");
  stringValue(required(value, "apiToken", "Cloudflare settings"), "cloudflare.apiToken", {
    min: 1,
    max: MAX_SECRET_LENGTH,
  });
  optionalString(value, "zoneId", "cloudflare");
  optionalString(value, "accountId", "cloudflare");
}

function validateAuthentik(value: Record<string, unknown>): void {
  onlyKeys(value, ["outpostDomain", "outpostUpstream", "authEndpoint"], "Authentik settings");
  stringValue(required(value, "outpostDomain", "Authentik settings"), "authentik.outpostDomain", {
    min: 1,
    max: 253,
  });
  const upstream = stringValue(
    required(value, "outpostUpstream", "Authentik settings"),
    "authentik.outpostUpstream",
    { min: 1, max: 4096 },
  );
  httpUrl(upstream, "authentik.outpostUpstream");
  optionalString(value, "authEndpoint", "authentik", 4096);
}

function validateForwardAuth(value: Record<string, unknown>): void {
  onlyKeys(value, ["provider", "authUpstream", "authEndpoint"], "Forward Auth settings");
  oneOf(
    required(value, "provider", "Forward Auth settings"),
    ["authelia", "custom"],
    "forward_auth.provider",
  );
  const upstream = stringValue(
    required(value, "authUpstream", "Forward Auth settings"),
    "forward_auth.authUpstream",
    { min: 1, max: 4096 },
  );
  httpUrl(upstream, "forward_auth.authUpstream");
  optionalString(value, "authEndpoint", "forward_auth", 4096);
}

function validateDashboard(value: Record<string, unknown>): void {
  onlyKeys(value, ["enabled", "domain", "tls", "options"], "dashboard settings");
  booleanValue(required(value, "enabled", "dashboard settings"), "dashboard.enabled");
  booleanValue(required(value, "tls", "dashboard settings"), "dashboard.tls");
  // Required even when disabled: re-enabling with a blank one would silently build no route.
  const domain = stringValue(required(value, "domain", "dashboard settings"), "dashboard.domain", {
    min: 1,
    max: 253,
  });
  // Interpolated into a Caddy host matcher and the reachability check's URL (which CodeQL flagged).
  if (!isHostname(domain)) invalid("settingsFieldNotHostname", { field: "dashboard.domain" });
  if (value.options !== undefined) validateDashboardOptions(value.options);
}

/** `meta` is only checked for being a JSON object: the proxy host model does the field checks. */
function validateDashboardOptions(input: unknown): void {
  const options = record(input, "dashboard.options");
  onlyKeys(
    options,
    [
      "certificateId",
      "accessListId",
      "hstsSubdomains",
      "skipHttpsHostnameValidation",
      "agentIds",
      "meta",
    ],
    "dashboard.options",
  );
  for (const key of ["certificateId", "accessListId"] as const) {
    const id = required(options, key, "dashboard.options");
    if (id !== null) integerValue(id, `dashboard.options.${key}`, 1, 2_147_483_647);
  }
  booleanValue(
    required(options, "hstsSubdomains", "dashboard.options"),
    "dashboard.options.hstsSubdomains",
  );
  booleanValue(
    required(options, "skipHttpsHostnameValidation", "dashboard.options"),
    "dashboard.options.skipHttpsHostnameValidation",
  );
  const agentIds = required(options, "agentIds", "dashboard.options");
  if (!Array.isArray(agentIds) || agentIds.length > MAX_LIST_ITEMS) {
    invalid("settingsFieldArrayMax", { field: "dashboard.options.agentIds", max: MAX_LIST_ITEMS });
  }
  agentIds.forEach((id, index) => {
    integerValue(id, `dashboard.options.agentIds[${index}]`, 1, 2_147_483_647);
  });
  const meta = required(options, "meta", "dashboard.options");
  if (meta !== null) {
    const text = stringValue(meta, "dashboard.options.meta", {
      max: MAX_SETTINGS_BYTES,
      controls: true,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      invalid("settingsFieldNotJsonObject", { field: "dashboard.options.meta" });
    }
    record(parsed, "dashboard.options.meta");
  }
}

function validateMetrics(value: Record<string, unknown>): void {
  onlyKeys(value, ["enabled", "port"], "metrics settings");
  booleanValue(required(value, "enabled", "metrics settings"), "metrics.enabled");
  if (value.port !== undefined) integerValue(value.port, "metrics.port", 1, 65535);
}

function validateLogging(value: Record<string, unknown>): void {
  onlyKeys(value, ["enabled", "format"], "logging settings");
  booleanValue(required(value, "enabled", "logging settings"), "logging.enabled");
  optionalOneOf(value.format, ["json", "console"], "logging.format");
}

function validateTrustedProxies(value: Record<string, unknown>): void {
  onlyKeys(
    value,
    ["ranges", "client_ip_headers", "strict", "default_geoblock"],
    "trusted proxy settings",
  );
  stringList(
    required(value, "ranges", "trusted proxy settings"),
    "trusted-proxies.ranges",
    (item, label) => ipOrCidr(item, label, true),
  );
  if (value.client_ip_headers !== undefined) {
    stringList(value.client_ip_headers, "trusted-proxies.client_ip_headers", (item, label) => {
      if (!HEADER_NAME.test(item)) invalid("settingsFieldNotHeaderName", { field: label });
    });
  }
  optionalBoolean(value, "strict", "trusted-proxies");
  optionalBoolean(value, "default_geoblock", "trusted-proxies");
}

function validateDns(value: Record<string, unknown>): void {
  onlyKeys(value, ["enabled", "resolvers", "fallbacks", "timeout"], "DNS settings");
  const enabled = booleanValue(required(value, "enabled", "DNS settings"), "dns.enabled");
  const resolvers = stringList(required(value, "resolvers", "DNS settings"), "dns.resolvers");
  if (enabled && resolvers.length === 0) invalid("settingsDnsResolversRequired");
  if (value.fallbacks !== undefined) stringList(value.fallbacks, "dns.fallbacks");
  optionalString(value, "timeout", "dns", 64);
}

/** Stored as sent, so it must already be in the form the builder uses. */
function dnsName(value: unknown, label: string): string {
  const name = stringValue(value, label, { min: 1, max: 253 });
  if (normalizeDnsName(name) !== name.toLowerCase()) {
    invalid("settingsFieldNotDnsName", { field: label });
  }
  return name.toLowerCase();
}

const ACMEDNS_ACCOUNT_KEYS = ["username", "password", "subdomain", "server_url"] as const;

function validateDnsDelegations(value: unknown, providers: Record<string, unknown>): void {
  if (!Array.isArray(value) || value.length > MAX_DNS_DELEGATIONS) {
    invalid("settingsFieldArrayMax", {
      field: "dns-provider.delegations",
      max: MAX_DNS_DELEGATIONS,
    });
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const label = `dns-provider.delegations[${index}]`;
    const delegation = record(entry, label);
    onlyKeys(delegation, ["domain", "target", "provider"], label);
    const domain = dnsName(required(delegation, "domain", label), `${label}.domain`);
    if (seen.has(domain)) invalid("settingsFieldListedTwice", { field: `${label}.domain` });
    seen.add(domain);
    const target = delegation.target ?? null;
    const provider = delegation.provider ?? null;
    if (target !== null) dnsName(target, `${label}.target`);
    if (provider !== null) {
      if (typeof provider !== "string" || !Object.hasOwn(providers, provider)) {
        invalid("settingsFieldNotConfiguredProvider", { field: `${label}.provider` });
      }
    }
    if (target === null && provider === null) {
      invalid("settingsDnsDelegationNeedsTarget", { field: label });
    }
  });
}

function validateAcmeDnsAccounts(value: unknown): void {
  const accounts = record(value, "dns-provider.acmeDnsAccounts");
  const domains = Object.keys(accounts);
  if (domains.length > MAX_DNS_DELEGATIONS) {
    invalid("settingsFieldTooMany", {
      field: "dns-provider.acmeDnsAccounts",
      max: MAX_DNS_DELEGATIONS,
    });
  }
  for (const domain of domains) {
    const label = `dns-provider.acmeDnsAccounts.${domain}`;
    // The builder looks accounts up by lowercase name.
    if (dnsName(domain, `${label} key`) !== domain) {
      invalid("settingsAcmeDnsAccountKeyNotLowercase", { field: label });
    }
    const account = record(accounts[domain], label);
    onlyKeys(account, [...ACMEDNS_ACCOUNT_KEYS, "fulldomain"], label);
    for (const key of ["username", "password", "subdomain"] as const) {
      stringValue(required(account, key, label), `${label}.${key}`, {
        min: 1,
        max: MAX_SECRET_LENGTH,
      });
    }
    dnsName(required(account, "fulldomain", label), `${label}.fulldomain`);
    httpUrl(
      stringValue(required(account, "server_url", label), `${label}.server_url`, { min: 1 }),
      `${label}.server_url`,
    );
  }
}

function validateDnsProvider(value: Record<string, unknown>): void {
  onlyKeys(
    value,
    ["providers", "default", "delegations", "acmeDnsAccounts"],
    "DNS provider settings",
  );
  const providers = record(
    required(value, "providers", "DNS provider settings"),
    "dns-provider.providers",
  );
  const providerNames = Object.keys(providers);
  if (providerNames.length > 32) {
    invalid("settingsFieldTooMany", { field: "dns-provider.providers", max: 32 });
  }
  for (const providerName of providerNames) {
    const definition = getProviderDefinition(providerName);
    if (!definition) invalid("settingsDnsProviderUnsupported", { provider: providerName });
    const credentials = record(providers[providerName], `dns-provider.providers.${providerName}`);
    onlyKeys(
      credentials,
      definition.fields.map((field) => field.key),
      `dns-provider.providers.${providerName}`,
    );
    for (const field of definition.fields) {
      if (field.required) {
        stringValue(
          required(credentials, field.key, `dns-provider.providers.${providerName}`),
          `dns-provider.providers.${providerName}.${field.key}`,
          { min: 1, max: MAX_SECRET_LENGTH },
        );
      } else if (credentials[field.key] !== undefined) {
        const stored = stringValue(
          credentials[field.key],
          `dns-provider.providers.${providerName}.${field.key}`,
          { max: MAX_SECRET_LENGTH },
        );
        if (field.type === "duration" && !isValidDnsDuration(stored)) {
          invalid("settingsFieldNotDuration", {
            field: `dns-provider.providers.${providerName}.${field.key}`,
          });
        }
      }
    }
  }
  if (value.default !== null && typeof value.default !== "string") {
    invalid("settingsDnsDefaultNotName");
  }
  if (typeof value.default === "string" && !Object.hasOwn(providers, value.default)) {
    invalid("settingsFieldNotConfiguredProvider", { field: "dns-provider.default" });
  }
  const acmeDns = providers[ACMEDNS_PROVIDER] as Record<string, unknown> | undefined;
  if (acmeDns) {
    // The single account is all or nothing: the module refuses one with a field missing.
    const set = ACMEDNS_ACCOUNT_KEYS.filter((key) => acmeDns[key]);
    if (set.length > 0 && set.length < ACMEDNS_ACCOUNT_KEYS.length) {
      invalid("settingsAcmeDnsAccountIncomplete", {
        field: `dns-provider.providers.${ACMEDNS_PROVIDER}`,
        keys: ACMEDNS_ACCOUNT_KEYS,
      });
    }
  }
  if (value.delegations !== undefined) validateDnsDelegations(value.delegations, providers);
  if (value.acmeDnsAccounts !== undefined) validateAcmeDnsAccounts(value.acmeDnsAccounts);
}

function validateUpstreamDns(value: Record<string, unknown>): void {
  onlyKeys(value, ["enabled", "family"], "upstream DNS settings");
  booleanValue(required(value, "enabled", "upstream DNS settings"), "upstream-dns.enabled");
  oneOf(
    required(value, "family", "upstream DNS settings"),
    ["ipv4", "ipv6", "both"],
    "upstream-dns.family",
  );
}

function validateNumberList(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    invalid("settingsFieldArrayMax", { field: label, max: MAX_LIST_ITEMS });
  }
  value.forEach((item, index) => {
    integerValue(item, `${label}[${index}]`, 1, 4_294_967_295);
  });
}

function validateGeoBlock(value: Record<string, unknown>): void {
  const keys = [
    "enabled",
    "block_countries",
    "block_continents",
    "block_asns",
    "block_cidrs",
    "block_ips",
    "allow_countries",
    "allow_continents",
    "allow_asns",
    "allow_cidrs",
    "allow_ips",
    "trusted_proxies",
    "fail_closed",
    "response_status",
    "response_body",
    "response_headers",
    "redirect_url",
  ];
  onlyKeys(value, keys, "geoblock settings");
  for (const key of keys) required(value, key, "geoblock settings");
  booleanValue(value.enabled, "geoblock.enabled");
  booleanValue(value.fail_closed, "geoblock.fail_closed");
  for (const key of ["block_countries", "allow_countries"]) {
    stringList(value[key], `geoblock.${key}`, (item, label) => {
      if (!/^[A-Z]{2}$/.test(item)) invalid("settingsFieldNotCountryCode", { field: label });
    });
  }
  for (const key of ["block_continents", "allow_continents"]) {
    stringList(value[key], `geoblock.${key}`, (item, label) => {
      if (!CONTINENTS.has(item)) invalid("settingsFieldNotContinentCode", { field: label });
    });
  }
  validateNumberList(value.block_asns, "geoblock.block_asns");
  validateNumberList(value.allow_asns, "geoblock.allow_asns");
  for (const key of ["block_cidrs", "allow_cidrs"]) {
    stringList(value[key], `geoblock.${key}`, (item, label) => ipOrCidr(item, label));
  }
  for (const key of ["block_ips", "allow_ips"]) {
    stringList(value[key], `geoblock.${key}`, (item, label) => {
      if (ipVersion(item) === 0) invalid("settingsFieldNotIpAddress", { field: label });
    });
  }
  stringList(value.trusted_proxies, "geoblock.trusted_proxies", (item, label) =>
    ipOrCidr(item, label, true),
  );
  integerValue(value.response_status, "geoblock.response_status", 100, 599);
  stringValue(value.response_body, "geoblock.response_body", { max: 65_536, controls: true });
  headerMap(value.response_headers, "geoblock.response_headers");
  const redirect = stringValue(value.redirect_url, "geoblock.redirect_url", { max: 4096 });
  httpUrl(redirect, "geoblock.redirect_url", true);
}

/**
 * A host's own geo-block rules, which `/api/v1` and GraphQL take as raw JSON. The host form fills
 * every key; the API may leave the response fields to inherit, so those get the global defaults
 * before the same check the global settings get.
 */
export function validateHostGeoBlock(input: unknown): void {
  const value = record(input, "geoblock settings");
  validateGeoBlock({ response_status: 403, response_body: "", ...value });
}

/** The stored global WAF settings an update replaces. */
export type PreviousWafSettings = {
  custom_directives?: string | null;
  load_owasp_crs?: boolean;
  strict_directives?: boolean;
} | null;

function validateWaf(value: Record<string, unknown>, previous: PreviousWafSettings): void {
  onlyKeys(
    value,
    [
      "enabled",
      "mode",
      "load_owasp_crs",
      "custom_directives",
      "strict_directives",
      "excluded_rule_ids",
      "preset_ids",
      "plugin_ids",
      "request_body_limit",
      "request_body_in_memory_limit",
      "request_body_limit_action",
      "paranoia_level",
      "log_next_paranoia_level",
      "inbound_anomaly_threshold",
      "outbound_anomaly_threshold",
    ],
    "WAF settings",
  );
  booleanValue(required(value, "enabled", "WAF settings"), "waf.enabled");
  oneOf(required(value, "mode", "WAF settings"), ["Off", "On", "DetectionOnly"], "waf.mode");
  booleanValue(required(value, "load_owasp_crs", "WAF settings"), "waf.load_owasp_crs");
  if (value.strict_directives !== undefined) {
    booleanValue(value.strict_directives, "waf.strict_directives");
  }
  const strictDirectives = value.strict_directives === true;
  const directives = stringValue(
    required(value, "custom_directives", "WAF settings"),
    "waf.custom_directives",
    { max: 100_000, controls: true },
  );
  // A dropped line is a rule the user believes is running, so refuse and name each one - but only
  // what this update newly drops, or a rule a later release started dropping blocks every save.
  const directiveError = customDirectivesError(
    directives,
    { crsLoaded: value.load_owasp_crs === true, strictDirectives },
    previous
      ? {
          directives: previous.custom_directives,
          options: {
            crsLoaded: Boolean(previous.load_owasp_crs),
            strictDirectives: Boolean(previous.strict_directives),
          },
        }
      : undefined,
  );
  if (directiveError) invalidFrom(directiveError);
  // Past the allowlist, a line can still be one Coraza refuses, and that fails every host's config.
  const lintErrors = seclangErrors(directives, { crsLoaded: value.load_owasp_crs === true });
  if (lintErrors.length > 0) {
    invalid("wafDirectivesInvalid", {
      count: lintErrors.length,
      details: seclangErrorDetails(lintErrors),
    });
  }
  if (value.excluded_rule_ids !== undefined)
    validateNumberList(value.excluded_rule_ids, "waf.excluded_rule_ids");
  if (value.preset_ids !== undefined) validateNumberList(value.preset_ids, "waf.preset_ids");
  if (value.plugin_ids !== undefined) validateNumberList(value.plugin_ids, "waf.plugin_ids");
  validateBodyLimits(value, "waf");
  if (value.paranoia_level !== undefined) {
    integerValue(value.paranoia_level, "waf.paranoia_level", 1, 4);
  }
  if (value.log_next_paranoia_level !== undefined) {
    booleanValue(value.log_next_paranoia_level, "waf.log_next_paranoia_level");
  }
  for (const key of ["inbound_anomaly_threshold", "outbound_anomaly_threshold"] as const) {
    if (value[key] !== undefined) {
      integerValue(value[key], `waf.${key}`, MIN_ANOMALY_THRESHOLD, MAX_ANOMALY_THRESHOLD);
    }
  }
}

/** Global and per-host WAF. Past Coraza's 1 GiB ceiling Caddy rejects the whole config. */
export function validateBodyLimits(value: Record<string, unknown>, prefix: string): void {
  for (const key of ["request_body_limit", "request_body_in_memory_limit"] as const) {
    const raw = value[key];
    if (raw === undefined || raw === null) continue;
    if (!isValidBodyLimit(raw)) {
      invalid("settingsBodyLimitRange", {
        field: `${prefix}.${key}`,
        min: CORAZA_MIN_BODY_LIMIT,
        max: CORAZA_MAX_BODY_LIMIT,
      });
    }
  }
  const action = value.request_body_limit_action;
  if (action !== undefined && action !== null) {
    oneOf(action, ["Reject", "ProcessPartial"], `${prefix}.request_body_limit_action`);
  }
  const limit = value.request_body_limit;
  const inMemory = value.request_body_in_memory_limit;
  if (typeof limit === "number" && typeof inMemory === "number" && inMemory > limit) {
    invalid("settingsBodyLimitInMemoryExceeds", {
      field: `${prefix}.request_body_in_memory_limit`,
      limitField: `${prefix}.request_body_limit`,
    });
  }
}

function validateErrorPages(value: Record<string, unknown>): void {
  onlyKeys(value, ["rules"], "error page settings");
  const rules = required(value, "rules", "error page settings");
  if (!Array.isArray(rules) || rules.length > 100) {
    invalid("settingsFieldArrayMax", { field: "error-pages.rules", max: 100 });
  }
  rules.forEach((rawRule, index) => {
    const label = `error-pages.rules[${index}]`;
    const rule = record(rawRule, label);
    onlyKeys(rule, ["statuses", "body", "contentType"], label);
    const statuses = required(rule, "statuses", label);
    if (!Array.isArray(statuses) || statuses.length > 200) {
      invalid("settingsFieldArrayMax", { field: `${label}.statuses`, max: 200 });
    }
    statuses.forEach((status, statusIndex) => {
      integerValue(status, `${label}.statuses[${statusIndex}]`, 400, 599);
    });
    stringValue(required(rule, "body", label), `${label}.body`, {
      min: 1,
      max: 65_536,
      controls: true,
    });
    optionalString(rule, "contentType", label, 128);
  });
}

function validateDefaultResponse(value: Record<string, unknown>): void {
  onlyKeys(
    value,
    ["mode", "status", "body", "headers", "redirectUrl"],
    "default response settings",
  );
  normalizeDefaultResponseSettings(value);
}

/** A kind or field left out is saved as shipped: a PUT replaces the whole row. */
function validateHostDefaults(value: Record<string, unknown>): void {
  onlyKeys(value, ["proxyHost", "l4ProxyHost"], "host defaults");
  for (const kind of ["proxyHost", "l4ProxyHost"] as const) {
    if (value[kind] === undefined) continue;
    const fields = record(value[kind], kind);
    onlyKeys(fields, Object.keys(DEFAULT_HOST_DEFAULTS[kind]), kind);
    for (const [key, shipped] of Object.entries(DEFAULT_HOST_DEFAULTS[kind])) {
      if (typeof shipped === "boolean") optionalBoolean(fields, key, kind);
    }
  }
  if (value.proxyHost !== undefined) {
    optionalOneOf(
      record(value.proxyHost, "proxyHost").compression,
      HOST_COMPRESSION_MODES,
      "proxyHost.compression",
    );
  }
  if (value.l4ProxyHost !== undefined) {
    optionalOneOf(
      record(value.l4ProxyHost, "l4ProxyHost").protocol,
      ["tcp", "udp"],
      "l4ProxyHost.protocol",
    );
  }
}

/** The GET shape round-trips: `hasPassword` and `hasApiKey` are accepted and ignored. */
/** `{ mode, graceDays }`, or the older `{ requireForAdmins }` API clients still send. */
function validateTwoFactorPolicy(value: Record<string, unknown>): void {
  onlyKeys(value, ["mode", "graceDays", "requireForAdmins"], "two-factor settings");
  if (!("mode" in value) && !("requireForAdmins" in value)) {
    required(value, "mode", "two-factor settings");
  }
  if ("mode" in value) optionalOneOf(value.mode, MFA_POLICY_MODES, "mode");
  if ("requireForAdmins" in value) booleanValue(value.requireForAdmins, "requireForAdmins");
  if ("graceDays" in value) integerValue(value.graceDays, "graceDays", 0, MAX_MFA_GRACE_DAYS);
}

function validateHttpCache(value: Record<string, unknown>): void {
  const label = "HTTP cache settings";
  onlyKeys(value, ["storage", "otterSize", "redis", "etcd", "cdn"], label);
  if (value.redis !== undefined) {
    onlyKeys(
      record(value.redis, "redis"),
      ["addresses", "username", "password", "db", "hasPassword"],
      label,
    );
  }
  if (value.etcd !== undefined) onlyKeys(record(value.etcd, "etcd"), ["endpoints"], label);
  if (value.cdn !== undefined) {
    const cdn = record(value.cdn, "cdn");
    onlyKeys(
      cdn,
      ["provider", "apiKey", "email", "zoneId", "serviceId", "strategy", "hasApiKey"],
      label,
    );
    optionalOneOf(cdn.provider, CDN_PROVIDERS, "cdn.provider");
  }
  optionalOneOf(value.storage, CACHE_STORAGES, "storage");
  try {
    normalizeHttpCacheSettings(value, { secretsPending: true });
  } catch (error) {
    invalidFrom(error);
  }
}

function validateTailscale(value: Record<string, unknown>): void {
  onlyKeys(
    value,
    [
      "enabled",
      "authKey",
      "controlUrl",
      "ephemeral",
      "stateDir",
      "tags",
      "defaultNode",
      "validateAuthKey",
      "apiAccessToken",
      "apiTailnet",
      "http3",
    ],
    "Tailscale settings",
  );
  booleanValue(required(value, "enabled", "Tailscale settings"), "tailscale.enabled");
  if (value.http3 !== undefined) booleanValue(value.http3, "tailscale.http3");
  try {
    // The normalizer also runs on every read; duplicated rules could accept what a read then drops.
    normalizeTailscaleSettings(value);
  } catch (error) {
    invalidFrom(error);
  }
}

function validateCrowdSec(value: Record<string, unknown>): void {
  // No managedApiKey: the controller generates it, and nothing may set it.
  onlyKeys(
    value,
    [
      "enabled",
      "mode",
      "onlineApi",
      "managedAppsec",
      "apiUrl",
      "apiKey",
      "appsecUrl",
      "appsecFailOpen",
      "tickerInterval",
    ],
    "CrowdSec settings",
  );
  booleanValue(required(value, "enabled", "CrowdSec settings"), "crowdsec.enabled");
  for (const key of ["mode", "apiUrl", "apiKey", "appsecUrl", "tickerInterval"]) {
    if (value[key] !== undefined) stringValue(value[key], `crowdsec.${key}`);
  }
  for (const key of ["appsecFailOpen", "onlineApi", "managedAppsec"]) {
    if (value[key] !== undefined) booleanValue(value[key], `crowdsec.${key}`);
  }
  try {
    // Whether a key is present is only known once the stored one is merged, on save.
    normalizeCrowdSecSettings(value);
  } catch (error) {
    invalidFrom(error);
  }
}

export function assertSettingsPayloadSize(input: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    invalid("settingsPayloadNotJson");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_SETTINGS_BYTES) {
    invalid("settingsPayloadTooLarge", { max: MAX_SETTINGS_BYTES });
  }
}

/** Strict runtime validation for REST settings writes. */
export function validateSettingsGroup(
  group: string,
  input: unknown,
  { previousWaf = null }: { previousWaf?: PreviousWafSettings } = {},
): unknown {
  assertSettingsPayloadSize(input);

  const value = record(input, `${group} settings`);
  switch (group) {
    case "general":
      validateGeneral(value);
      break;
    case "acme":
      validateAcme(value);
      break;
    case "cloudflare":
      validateCloudflare(value);
      break;
    case "authentik":
      validateAuthentik(value);
      break;
    case "forward-auth":
      validateForwardAuth(value);
      break;
    case "dashboard":
      validateDashboard(value);
      break;
    case "metrics":
      validateMetrics(value);
      break;
    case "logging":
      validateLogging(value);
      break;
    case "trusted-proxies":
      validateTrustedProxies(value);
      break;
    case "dns":
      validateDns(value);
      break;
    case "dns-provider":
      validateDnsProvider(value);
      break;
    case "upstream-dns":
      validateUpstreamDns(value);
      break;
    case "geoblock":
      validateGeoBlock(value);
      break;
    case "waf":
      validateWaf(value, previousWaf);
      break;
    case "rate-limit":
      onlyKeys(value, ["enabled", "zones", "allowlist"], "rate limit settings");
      booleanValue(required(value, "enabled", "rate limit settings"), "enabled");
      try {
        normalizeGlobalRateLimitInput(value);
      } catch (error) {
        invalidFrom(error);
      }
      break;
    case "error-pages":
      validateErrorPages(value);
      break;
    case "default-response":
      validateDefaultResponse(value);
      break;
    case "tailscale":
      validateTailscale(value);
      break;
    case "crowdsec":
      validateCrowdSec(value);
      break;
    case "http-protocols":
      onlyKeys(value, ["http2", "http3"], "HTTP version settings");
      booleanValue(required(value, "http2", "HTTP version settings"), "http2");
      booleanValue(required(value, "http3", "HTTP version settings"), "http3");
      break;
    case "compression":
      onlyKeys(value, ["enabled"], "compression settings");
      booleanValue(required(value, "enabled", "compression settings"), "enabled");
      break;
    case "two-factor":
      validateTwoFactorPolicy(value);
      break;
    case "host-defaults":
      validateHostDefaults(value);
      break;
    case "http-cache":
      validateHttpCache(value);
      break;
    case "global-caddy-config":
      // Length, characters and whether Caddy takes it are checked on save, against a real Caddy.
      onlyKeys(value, ["caddyfile"], "global Caddyfile settings");
      if (typeof required(value, "caddyfile", "global Caddyfile settings") !== "string") {
        invalid("settingsFieldNotString", { field: "caddyfile" });
      }
      break;
    default:
      invalid("settingsGroupUnknown");
  }
  return input;
}
