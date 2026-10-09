/**
 * What a new proxy host or L4 host starts with: prefilled by the create dialogs, and filled in by
 * the models for whatever an API body leaves out. Existing hosts never read it. Browser-safe.
 */

import type { L4ProxyHostInput } from "../models/l4-proxy-hosts";
import type { ProxyHostInput } from "../models/proxy-hosts";
import { HOST_COMPRESSION_MODES, type HostCompressionMode } from "./compression";

export type ProxyHostDefaults = {
  sslForced: boolean;
  hstsEnabled: boolean;
  hstsSubdomains: boolean;
  allowWebsocket: boolean;
  preserveHostHeader: boolean;
  skipHttpsValidation: boolean;
  discourageIndexing: boolean;
  compression: HostCompressionMode;
  /** Never stored: follows the global WAF, filled in by getHostDefaults (wafOnByDefault). */
  wafEnabled: boolean;
  crowdsecEnabled: boolean;
};

export type L4ProxyHostDefaults = {
  protocol: "tcp" | "udp";
  tlsTermination: boolean;
  proxyProtocolReceive: boolean;
  crowdsecEnabled: boolean;
};

export type HostDefaults = {
  proxyHost: ProxyHostDefaults;
  l4ProxyHost: L4ProxyHostDefaults;
};

/** The values hard-coded before this was a setting, so an unset row changes nothing. */
export const DEFAULT_HOST_DEFAULTS: HostDefaults = {
  proxyHost: {
    sslForced: true,
    hstsEnabled: true,
    hstsSubdomains: false,
    allowWebsocket: true,
    preserveHostHeader: true,
    skipHttpsValidation: false,
    discourageIndexing: false,
    compression: "inherit",
    wafEnabled: false,
    crowdsecEnabled: true,
  },
  l4ProxyHost: {
    protocol: "tcp",
    tlsTermination: false,
    proxyProtocolReceive: false,
    crowdsecEnabled: true,
  },
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bool(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof raw[key] === "boolean" ? (raw[key] as boolean) : fallback;
}

/** Field by field: anything unreadable falls back to the shipped default, never throws. */
export function sanitizeHostDefaults(value: unknown): HostDefaults {
  const raw = record(value);
  const http = record(raw.proxyHost);
  const l4 = record(raw.l4ProxyHost);
  const httpBase = DEFAULT_HOST_DEFAULTS.proxyHost;
  const l4Base = DEFAULT_HOST_DEFAULTS.l4ProxyHost;
  return {
    proxyHost: {
      sslForced: bool(http, "sslForced", httpBase.sslForced),
      hstsEnabled: bool(http, "hstsEnabled", httpBase.hstsEnabled),
      hstsSubdomains: bool(http, "hstsSubdomains", httpBase.hstsSubdomains),
      allowWebsocket: bool(http, "allowWebsocket", httpBase.allowWebsocket),
      preserveHostHeader: bool(http, "preserveHostHeader", httpBase.preserveHostHeader),
      skipHttpsValidation: bool(http, "skipHttpsValidation", httpBase.skipHttpsValidation),
      discourageIndexing: bool(http, "discourageIndexing", httpBase.discourageIndexing),
      compression: HOST_COMPRESSION_MODES.includes(http.compression as HostCompressionMode)
        ? (http.compression as HostCompressionMode)
        : httpBase.compression,
      wafEnabled: httpBase.wafEnabled,
      crowdsecEnabled: bool(http, "crowdsecEnabled", httpBase.crowdsecEnabled),
    },
    l4ProxyHost: {
      protocol: l4.protocol === "udp" || l4.protocol === "tcp" ? l4.protocol : l4Base.protocol,
      tlsTermination: bool(l4, "tlsTermination", l4Base.tlsTermination),
      proxyProtocolReceive: bool(l4, "proxyProtocolReceive", l4Base.proxyProtocolReceive),
      crowdsecEnabled: bool(l4, "crowdsecEnabled", l4Base.crowdsecEnabled),
    },
  };
}

/**
 * For a write: also drops what the editors would submit as off, so a default can't hold HSTS
 * without HTTPS forced, or TLS termination over UDP, which the L4 model refuses.
 */
export function normalizeHostDefaults(value: unknown): HostDefaults {
  const sanitized = sanitizeHostDefaults(value);
  const http = sanitized.proxyHost;
  const l4 = sanitized.l4ProxyHost;
  const hstsEnabled = http.sslForced && http.hstsEnabled;
  return {
    proxyHost: { ...http, hstsEnabled, hstsSubdomains: hstsEnabled && http.hstsSubdomains },
    l4ProxyHost: { ...l4, tlsTermination: l4.protocol === "tcp" && l4.tlsTermination },
  };
}

/** On while the global WAF logs or blocks, so a new host is protected as the rest are. */
export function wafOnByDefault(global: { enabled?: boolean; mode?: string } | null): boolean {
  return Boolean(global?.enabled) && global?.mode !== "Off";
}

export function isStockHostDefaults<K extends keyof HostDefaults>(
  defaults: HostDefaults,
  kind: K,
): boolean {
  const base = DEFAULT_HOST_DEFAULTS[kind] as Record<string, unknown>;
  const current = defaults[kind] as Record<string, unknown>;
  // The WAF follows the global setting rather than anything chosen here.
  return Object.keys(base).every((key) => key === "wafEnabled" || base[key] === current[key]);
}

/** Only fields the body left out; a null crowdsec still means "follow the global setting". */
export function applyProxyHostDefaults(
  input: ProxyHostInput,
  defaults: ProxyHostDefaults,
): ProxyHostInput {
  return {
    ...input,
    sslForced: input.sslForced ?? defaults.sslForced,
    hstsEnabled: input.hstsEnabled ?? defaults.hstsEnabled,
    hstsSubdomains: input.hstsSubdomains ?? defaults.hstsSubdomains,
    allowWebsocket: input.allowWebsocket ?? defaults.allowWebsocket,
    preserveHostHeader: input.preserveHostHeader ?? defaults.preserveHostHeader,
    skipHttpsHostnameValidation: input.skipHttpsHostnameValidation ?? defaults.skipHttpsValidation,
    discourageIndexing: input.discourageIndexing ?? defaults.discourageIndexing,
    compression: input.compression === undefined ? defaults.compression : input.compression,
    // What the editor's WAF card submits switched on and otherwise untouched.
    waf:
      input.waf === undefined && defaults.wafEnabled
        ? { enabled: true, waf_mode: "merge", load_owasp_crs: true }
        : input.waf,
    crowdsec: input.crowdsec === undefined ? defaults.crowdsecEnabled : input.crowdsec,
  };
}

export function applyL4ProxyHostDefaults(
  input: L4ProxyHostInput,
  defaults: L4ProxyHostDefaults,
): L4ProxyHostInput {
  const protocol = input.protocol ?? defaults.protocol;
  return {
    ...input,
    protocol,
    // Only over TCP: an explicit UDP body would otherwise be refused for a field it never sent.
    tlsTermination: input.tlsTermination ?? (protocol === "tcp" && defaults.tlsTermination),
    proxyProtocolReceive: input.proxyProtocolReceive ?? defaults.proxyProtocolReceive,
    crowdsec: input.crowdsec === undefined ? defaults.crowdsecEnabled : input.crowdsec,
  };
}
