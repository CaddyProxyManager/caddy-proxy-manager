/**
 * CrowdSec through github.com/hslatman/caddy-crowdsec-bouncer: the `crowdsec` app keeps the Local
 * API's decisions in memory, and a handler (HTTP) or matcher (L4) refuses what they ban. The LAPI
 * is either the operator's own (external) or the `crowdsec` Compose service the bundled agent runs
 * (managed); `crowdSecConnection` is the one place that choice is made.
 */

import { randomBytes } from "node:crypto";
import { isCaddyPlaceholder } from "./tailscale";
import { domainError } from "../errors/domain-error";
import { type OutboundFetch, outboundFetch } from "../http/outbound";
import { parseOutboundBaseUrl } from "../http/outbound-url";

export const CROWDSEC_MODES = ["external", "managed"] as const;
export type CrowdSecMode = (typeof CROWDSEC_MODES)[number];

/** docker-compose.yml's alias on the crowdsec network, which only Caddy shares. */
export const MANAGED_CROWDSEC_API_URL = "http://cpm-crowdsec:8080";
/** docker/crowdsec/acquis.yaml's AppSec listener. */
export const MANAGED_CROWDSEC_APPSEC_URL = "http://cpm-crowdsec:7422";

export type CrowdSecSettings = {
  enabled: boolean;
  /** External: the fields below. Managed: the bundled agent's `crowdsec` container. */
  mode: CrowdSecMode;
  /** Managed only. Off: the container never registers with CrowdSec's Central API. */
  onlineApi: boolean;
  /** Managed only; the external mode's switch is a non-empty `appsecUrl`. */
  managedAppsec: boolean;
  /**
   * Managed only: generated here, encrypted at rest, never accepted from a form or REST, never
   * returned. Kept when switching to external and back, as the container registers it only once.
   */
  managedApiKey: string;
  /** The Local API's base URL. */
  apiUrl: string;
  /** The bouncer key from `cscli bouncers add`. Encrypted at rest, never sent to a browser. */
  apiKey: string;
  /** Empty leaves AppSec off. It is sent the bouncer key too. */
  appsecUrl: string;
  /** Off by default, as in the module: an unreachable AppSec refuses requests. */
  appsecFailOpen: boolean;
  /** How often the decision stream is pulled. A Go duration: the module parses it as one. */
  tickerInterval: string;
};

export const DEFAULT_CROWDSEC_TICKER = "60s";

export const DEFAULT_CROWDSEC_SETTINGS: CrowdSecSettings = {
  enabled: false,
  mode: "external",
  onlineApi: false,
  managedAppsec: false,
  managedApiKey: "",
  apiUrl: "",
  apiKey: "",
  appsecUrl: "",
  appsecFailOpen: false,
  tickerInterval: DEFAULT_CROWDSEC_TICKER,
};

/** For the form and REST: the key replaced by whether one is stored, the managed one dropped. */
export type CrowdSecSettingsView = Omit<CrowdSecSettings, "apiKey" | "managedApiKey"> & {
  hasApiKey: boolean;
};

export function redactCrowdSecSettings(settings: CrowdSecSettings): CrowdSecSettingsView {
  const { apiKey, managedApiKey: _managed, ...rest } = settings;
  return { ...rest, hasApiKey: apiKey.length > 0 };
}

/** Hex, so it needs no quoting in the child environment the agent hands Compose. */
export function generateManagedBouncerKey(): string {
  return randomBytes(32).toString("hex");
}

const GO_DURATION_UNITS_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};
const GO_DURATION_SEGMENT = /(\d+(?:\.\d+)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/gy;
const MIN_TICKER_MS = 1000;
const MAX_TICKER_MS = 24 * 3_600_000;

/** No "d": the module reads this with time.ParseDuration, not caddy.ParseDuration. */
export function goDurationMs(value: string): number | null {
  if (!value || value.length > 32) return null;
  let total = 0;
  let consumed = 0;
  for (const match of value.matchAll(GO_DURATION_SEGMENT)) {
    total += Number(match[1]) * GO_DURATION_UNITS_MS[match[2]];
    consumed += match[0].length;
  }
  return consumed === value.length ? total : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 32 || code === 127) return true;
  }
  return false;
}

/**
 * Checks the shape of whatever is filled in; whether enough is filled in to switch it on is
 * `assertCrowdSecComplete`, since the stored key is merged in between. Also runs on every read.
 */
export function normalizeCrowdSecSettings(value: unknown): CrowdSecSettings {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};

  let apiUrl = text(raw.apiUrl);
  if (apiUrl) {
    const parsed = parseOutboundBaseUrl(apiUrl);
    if (parsed.problem === "metadata")
      throw domainError("outboundUrlMetadata", {}, { status: 400 });
    if (parsed.problem === "https") throw domainError("crowdsecApiUrlHttps", {}, { status: 400 });
    if (parsed.problem) throw domainError("crowdsecApiUrlInvalid", {}, { status: 400 });
    apiUrl = parsed.url;
  }

  let appsecUrl = text(raw.appsecUrl);
  if (appsecUrl) {
    const parsed = parseOutboundBaseUrl(appsecUrl);
    if (parsed.problem === "metadata")
      throw domainError("outboundUrlMetadata", {}, { status: 400 });
    if (parsed.problem === "https") {
      throw domainError("crowdsecAppsecUrlHttps", {}, { status: 400 });
    }
    if (parsed.problem) throw domainError("crowdsecAppsecUrlInvalid", {}, { status: 400 });
    appsecUrl = parsed.url;
  }

  // Generous: this also runs over the stored ciphertext.
  const apiKey = text(raw.apiKey);
  if (apiKey.length > 4096 || hasControlOrSpace(apiKey)) {
    throw domainError("crowdsecApiKeyInvalid", {}, { status: 400 });
  }
  // Only ever the stored ciphertext: saveCrowdSecSettings never takes it from the caller.
  const managedApiKey = text(raw.managedApiKey);
  if (managedApiKey.length > 4096 || hasControlOrSpace(managedApiKey)) {
    throw domainError("crowdsecApiKeyInvalid", {}, { status: 400 });
  }

  if (raw.mode !== undefined && !(CROWDSEC_MODES as readonly unknown[]).includes(raw.mode)) {
    throw domainError("crowdsecModeInvalid", {}, { status: 400 });
  }

  const tickerInterval = text(raw.tickerInterval) || DEFAULT_CROWDSEC_TICKER;
  const tickerMs = goDurationMs(tickerInterval);
  if (tickerMs === null || tickerMs < MIN_TICKER_MS || tickerMs > MAX_TICKER_MS) {
    throw domainError("crowdsecTickerInvalid", {}, { status: 400 });
  }

  return {
    enabled: raw.enabled === true,
    mode: raw.mode === "managed" ? "managed" : "external",
    onlineApi: raw.onlineApi === true,
    managedAppsec: raw.managedAppsec === true,
    managedApiKey,
    apiUrl,
    apiKey,
    appsecUrl,
    appsecFailOpen: raw.appsecFailOpen === true,
    tickerInterval,
  };
}

/**
 * A blank key keeps the stored one, but only while both addresses it is sent to stay the same:
 * otherwise anyone able to save settings could point the stored key at a server of their own.
 */
export function keepStoredCrowdSecKey(
  submitted: CrowdSecSettings,
  stored: CrowdSecSettings | null,
): CrowdSecSettings {
  if (submitted.apiKey || !stored?.apiKey) return submitted;
  const sameTargets =
    stored.apiUrl === submitted.apiUrl && stored.appsecUrl === submitted.appsecUrl;
  return sameTargets ? { ...submitted, apiKey: stored.apiKey } : submitted;
}

/**
 * The managed key is the stored one or a new one, whatever was submitted; minted on the first
 * switch to managed, so the container registers it on its first start.
 */
export function withManagedCrowdSecKey(
  submitted: CrowdSecSettings,
  stored: CrowdSecSettings | null,
  generate: () => string = generateManagedBouncerKey,
): CrowdSecSettings {
  const managedApiKey = stored?.managedApiKey ?? "";
  if (managedApiKey || submitted.mode !== "managed") return { ...submitted, managedApiKey };
  return { ...submitted, managedApiKey: generate() };
}

/** Switching it on needs an address and a key, unless managed; switched off, anything may be kept. */
export function assertCrowdSecComplete(
  settings: CrowdSecSettings,
  stored: CrowdSecSettings | null,
): void {
  if (!settings.enabled || settings.mode === "managed") return;
  if (!settings.apiUrl) throw domainError("crowdsecApiUrlRequired", {}, { status: 400 });
  if (!settings.apiKey) {
    throw domainError(
      stored?.apiKey ? "crowdsecApiKeyReenter" : "crowdsecApiKeyRequired",
      {},
      { status: 400 },
    );
  }
}

export function isCrowdSecConfigured(settings: CrowdSecSettings | null | undefined): boolean {
  if (!settings?.enabled) return false;
  if (settings.mode === "managed") return settings.managedApiKey.length > 0;
  return Boolean(settings.apiUrl && settings.apiKey);
}

/** Whether the agent running the controller's services should run the `crowdsec` container. */
export function wantsManagedCrowdSec(settings: CrowdSecSettings | null | undefined): boolean {
  return Boolean(settings && settings.mode === "managed" && isCrowdSecConfigured(settings));
}

// ─── Caddy JSON ──────────────────────────────────────────────────────────────

/** What config generation reads. `apiKey` is still encrypted; the caller decrypts it. */
export type CrowdSecConnection = {
  apiUrl: string;
  apiKey: string;
  appsecUrl: string;
  appsecFailOpen: boolean;
  tickerInterval: string;
  /** The managed container reads Caddy's access log, so the document must write it, as JSON. */
  managed: boolean;
};

/**
 * The one place the address and key are chosen. `runsManagedServices`: whether the agent this
 * document is for runs the managed container; any other has no LAPI to reach, so gets none.
 */
export function crowdSecConnection(
  settings: CrowdSecSettings | null,
  runsManagedServices = true,
): CrowdSecConnection | null {
  if (!settings || !isCrowdSecConfigured(settings)) return null;
  const common = {
    appsecFailOpen: settings.appsecFailOpen,
    tickerInterval: settings.tickerInterval,
  };
  if (settings.mode === "managed") {
    if (!runsManagedServices) return null;
    return {
      ...common,
      apiUrl: MANAGED_CROWDSEC_API_URL,
      apiKey: settings.managedApiKey,
      appsecUrl: settings.managedAppsec ? MANAGED_CROWDSEC_APPSEC_URL : "",
      managed: true,
    };
  }
  return {
    ...common,
    apiUrl: settings.apiUrl,
    apiKey: settings.apiKey,
    appsecUrl: settings.appsecUrl,
    managed: false,
  };
}

/**
 * Streaming keeps decisions in memory, so a lookup never waits on the LAPI; hard fails off, so an
 * unreachable LAPI at startup does not stop Caddy. `apiKey` arrives decrypted.
 */
export function buildCrowdSecApp(
  connection: CrowdSecConnection,
  apiKey: string,
): Record<string, unknown> {
  return {
    api_url: connection.apiUrl,
    api_key: apiKey,
    ticker_interval: connection.tickerInterval,
    enable_streaming: true,
    enable_hard_fails: false,
    ...(connection.appsecUrl
      ? { appsec_url: connection.appsecUrl, appsec_fail_open: connection.appsecFailOpen }
      : {}),
  };
}

/** Reads Caddy's client_ip, so trusted proxies apply. Ban and captcha answer 403, throttle 429. */
export function buildCrowdSecHandler(): Record<string, unknown> {
  return { handler: "crowdsec" };
}

export function buildAppSecHandler(): Record<string, unknown> {
  return { handler: "appsec" };
}

/**
 * An L4 guard's matcher sets. The module's matcher matches an *allowed* address, so the deny is
 * its negation. It reads the connection's remote address, which inside the PROXY-protocol
 * subroute is the client's.
 */
export function crowdSecL4DenySets(): Record<string, unknown>[] {
  return [{ not: [{ crowdsec: {} }] }];
}

// ─── Per host ────────────────────────────────────────────────────────────────

/** Stored only when a host opts out; absent follows the global setting. */
export type HostCrowdSecMeta = { enabled: false };

export function sanitizeHostCrowdSec(value: unknown): HostCrowdSecMeta | undefined {
  return value && typeof value === "object" && (value as { enabled?: unknown }).enabled === false
    ? { enabled: false }
    : undefined;
}

export function hostCrowdSecEnabled(meta: HostCrowdSecMeta | undefined): boolean {
  return meta?.enabled !== false;
}

/** For a model input: true (or absent) stores nothing. */
export function storedHostCrowdSec(enabled: boolean): HostCrowdSecMeta | undefined {
  return enabled ? undefined : { enabled: false };
}

// ─── Test connection ─────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 5000;

export type CrowdSecProbeResult =
  | { status: "ok" }
  | { status: "rejected" }
  | { status: "unexpected"; httpStatus: number }
  | { status: "unreachable" }
  | { status: "placeholder" };

/**
 * Asks for the decisions on one address, so the answer stays small. Run from the controller,
 * which may not reach a LAPI only Caddy's network can: "unreachable" here is not proof Caddy
 * cannot. `apiUrl` has been through `normalizeCrowdSecSettings`; never follows a redirect.
 */
export async function probeCrowdSecLapi(
  apiUrl: string,
  apiKey: string,
  fetchImpl: OutboundFetch = outboundFetch,
): Promise<CrowdSecProbeResult> {
  if (isCaddyPlaceholder(apiKey)) return { status: "placeholder" };
  const parsed = parseOutboundBaseUrl(apiUrl);
  if (!parsed.url) return { status: "unreachable" };

  let response: Response;
  try {
    // outbound: crowdsecLapi
    response = await fetchImpl(`${parsed.url}/v1/decisions?ip=127.0.0.1`, {
      method: "GET",
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
      redirect: "manual",
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  } catch {
    return { status: "unreachable" };
  }
  await response.body?.cancel().catch(() => {});
  if (response.status === 200) return { status: "ok" };
  if (response.status === 401 || response.status === 403) return { status: "rejected" };
  return { status: "unexpected", httpStatus: response.status };
}
