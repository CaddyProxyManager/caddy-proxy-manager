/**
 * Dynamic DNS: record sets Caddy keeps pointed at its own public IP, through a saved DNS
 * provider, by github.com/mholt/caddy-dynamicdns. No node imports: the Settings page reads it.
 * The Caddy app itself is built in dynamic-dns-config.ts, which decrypts credentials.
 */

import { CADDY_DURATION_SEGMENT, isCaddyDuration } from "../caddy/duration";
import { domainError } from "../errors/domain-error";
import { getProviderDefinition } from "./providers";

export type DynamicDnsRecordSet = {
  /** A DNS provider with saved credentials. */
  provider: string;
  /** The zone as the provider knows it, usually the registered domain. */
  zone: string;
  /** Relative to the zone; "@" is the zone itself. */
  names: string[];
  /** The agent whose Caddy updates these; null is the bundled agent. */
  agentId: string | null;
};

export type DynamicDnsSettings = {
  enabled: boolean;
  recordSets: DynamicDnsRecordSet[];
  ipv4: boolean;
  ipv6: boolean;
  checkInterval: string;
  /** Empty leaves the record's TTL to the provider. */
  ttl: string;
  /** Never create a record, only change one that exists. */
  updateOnly: boolean;
  /** Plain-text IP echo services; empty uses the plugin's own list. */
  ipEndpoints: string[];
};

export const DYNAMIC_DNS_DEFAULT_INTERVAL = "5m";
export const DYNAMIC_DNS_MAX_RECORD_SETS = 100;
export const DYNAMIC_DNS_MAX_NAMES = 50;
export const DYNAMIC_DNS_MAX_ENDPOINTS = 10;
/** Every check calls the echo services, which rate-limit anyone polling harder. */
export const DYNAMIC_DNS_MIN_INTERVAL_MS = 60_000;

/** acme-dns only serves TXT records, so it cannot hold an address. */
const UNSUPPORTED_PROVIDERS = new Set(["acmedns"]);

export function defaultDynamicDnsSettings(): DynamicDnsSettings {
  return {
    enabled: false,
    recordSets: [],
    ipv4: true,
    ipv6: false,
    checkInterval: DYNAMIC_DNS_DEFAULT_INTERVAL,
    ttl: "",
    updateOnly: false,
    ipEndpoints: [],
  };
}

export function isDynamicDnsProvider(name: string): boolean {
  return Boolean(getProviderDefinition(name)) && !UNSUPPORTED_PROVIDERS.has(name);
}

const LABEL = "[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?";
const ZONE_PATTERN = new RegExp(`^(?:${LABEL}\\.)+${LABEL}$`);
const NAME_PATTERN = new RegExp(`^(?:\\*|${LABEL})(?:\\.${LABEL})*$`);

const UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Milliseconds of a string `isCaddyDuration` accepted. */
export function caddyDurationMs(value: string): number {
  let total = 0;
  for (const match of value.matchAll(new RegExp(CADDY_DURATION_SEGMENT, "g"))) {
    const [, amount, unit] = /^([\d.]+)(\D+)$/.exec(match[0]) ?? [];
    total += Number(amount) * (UNIT_MS[unit] ?? 0);
  }
  return total;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  if (typeof value === "string") return value.split(/[\s,]+/).filter(Boolean);
  return [];
}

/** "home.example.com." and "Home" are what people paste; both mean what the provider stores. */
function normalizeName(raw: string, zone: string): string {
  const name = raw.toLowerCase().replace(/\.$/, "");
  if (name === zone) return "@";
  return name.endsWith(`.${zone}`) ? name.slice(0, -zone.length - 1) : name;
}

function normalizeRecordSet(value: unknown): DynamicDnsRecordSet {
  const input = (value ?? {}) as Partial<Record<keyof DynamicDnsRecordSet, unknown>>;
  const provider = text(input.provider);
  if (!getProviderDefinition(provider)) {
    throw domainError("dynamicDnsProviderUnknown", { provider }, { status: 400 });
  }
  if (!isDynamicDnsProvider(provider)) {
    throw domainError("dynamicDnsProviderUnsupported", { provider }, { status: 400 });
  }

  const zone = text(input.zone).toLowerCase().replace(/\.$/, "");
  if (!ZONE_PATTERN.test(zone) || zone.length > 253) {
    throw domainError("dynamicDnsZoneInvalid", { zone }, { status: 400 });
  }

  const names = [...new Set(stringList(input.names).map((name) => normalizeName(name, zone)))];
  if (names.length === 0) throw domainError("dynamicDnsNamesRequired", { zone }, { status: 400 });
  if (names.length > DYNAMIC_DNS_MAX_NAMES) {
    throw domainError(
      "dynamicDnsTooManyNames",
      { zone, max: DYNAMIC_DNS_MAX_NAMES },
      { status: 400 },
    );
  }
  for (const name of names) {
    if (name !== "@" && (!NAME_PATTERN.test(name) || name.length + zone.length >= 253)) {
      throw domainError("dynamicDnsNameInvalid", { name, zone }, { status: 400 });
    }
  }

  const agentId = text(input.agentId);
  if (agentId.length > 128 || /[^\w.:-]/.test(agentId)) {
    throw domainError("dynamicDnsAgentInvalid", {}, { status: 400 });
  }

  return { provider, zone, names, agentId: agentId || null };
}

function normalizeEndpoint(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw domainError("dynamicDnsEndpointInvalid", { url: raw }, { status: 400 });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw domainError("dynamicDnsEndpointInvalid", { url: raw }, { status: 400 });
  }
  return raw;
}

/** Throws a DomainError naming the first problem. Also runs over the stored blob. */
export function normalizeDynamicDnsSettings(value: unknown): DynamicDnsSettings {
  const input = (value ?? {}) as Partial<Record<keyof DynamicDnsSettings, unknown>>;
  const enabled = input.enabled === true;

  const rawSets = Array.isArray(input.recordSets) ? input.recordSets : [];
  if (rawSets.length > DYNAMIC_DNS_MAX_RECORD_SETS) {
    throw domainError(
      "dynamicDnsTooManyRecordSets",
      { max: DYNAMIC_DNS_MAX_RECORD_SETS },
      { status: 400 },
    );
  }
  const recordSets = rawSets.map(normalizeRecordSet);
  if (enabled && recordSets.length === 0) {
    throw domainError("dynamicDnsRecordSetsRequired", {}, { status: 400 });
  }

  const ipv4 = input.ipv4 !== false;
  const ipv6 = input.ipv6 === true;
  if (!ipv4 && !ipv6) throw domainError("dynamicDnsNoIpVersion", {}, { status: 400 });

  const checkInterval = text(input.checkInterval) || DYNAMIC_DNS_DEFAULT_INTERVAL;
  if (
    !isCaddyDuration(checkInterval) ||
    caddyDurationMs(checkInterval) < DYNAMIC_DNS_MIN_INTERVAL_MS
  ) {
    throw domainError("dynamicDnsIntervalInvalid", { value: checkInterval }, { status: 400 });
  }

  const ttl = text(input.ttl);
  if (ttl && (!isCaddyDuration(ttl) || caddyDurationMs(ttl) < 1000)) {
    throw domainError("dynamicDnsTtlInvalid", { value: ttl }, { status: 400 });
  }

  const ipEndpoints = [...new Set(stringList(input.ipEndpoints))];
  if (ipEndpoints.length > DYNAMIC_DNS_MAX_ENDPOINTS) {
    throw domainError(
      "dynamicDnsTooManyEndpoints",
      { max: DYNAMIC_DNS_MAX_ENDPOINTS },
      { status: 400 },
    );
  }

  return {
    enabled,
    recordSets,
    ipv4,
    ipv6,
    checkInterval,
    ttl,
    updateOnly: input.updateOnly === true,
    ipEndpoints: ipEndpoints.map(normalizeEndpoint),
  };
}

/** The fully qualified names a record set keeps updated, for display. */
export function recordSetHostnames(set: DynamicDnsRecordSet): string[] {
  return set.names.map((name) => (name === "@" ? set.zone : `${name}.${set.zone}`));
}
