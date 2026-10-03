import db, { nowIso, toIso } from "../db";
import {
  l4PortCount,
  reservedL4Port,
  splitHostPort,
  splitHostPortRange,
  splitL4UpstreamHost,
} from "../caddy-utils";
import { applyCaddyConfig } from "../caddy";
import { getMetricsSettings } from "../settings";
import { logAuditEvent } from "../audit";
import { accessListIpRules, accessLists, l4ProxyHosts } from "../db/schema";
import { and, asc, desc, eq, count, inArray, like, or, sql } from "drizzle-orm";
import { domainError } from "../domain-error";
import { assertNoNewAdminDialTargets } from "./admin-dial-targets";
import { agentIdsForHost, setHostAgents } from "./host-agents";
import { normalizeHostDescription } from "../host-description";
import { assertL4PortPlan, MAX_L4_PORTS_PER_HOST } from "../l4-port-plan";
import {
  type HostCrowdSecMeta,
  hostCrowdSecEnabled,
  sanitizeHostCrowdSec,
  storedHostCrowdSec,
} from "../crowdsec";

export type L4Protocol = "tcp" | "udp";
export type L4MatcherType = "none" | "tls_sni" | "http_host" | "proxy_protocol";
export type L4ProxyProtocolVersion = "v1" | "v2";
/**
 * `same` dials each connection's own listen port on the upstream, for a range: Docker publishes
 * `port:port`, so the port Caddy accepted on is the one the client asked for.
 */
export type L4UpstreamPortMode = "fixed" | "same";

/**
 * What `layer4.proxy.selection_policies.*` registers in the image, per `caddy list-modules`:
 * the request-reading HTTP policies do not apply, and caddy-l4 has no client_ip_hash.
 */
export type L4LoadBalancingPolicy =
  | "random"
  | "random_choose"
  | "round_robin"
  | "weighted_round_robin"
  | "least_conn"
  | "ip_hash"
  | "first";

export type L4LoadBalancerActiveHealthCheck = {
  enabled: boolean;
  port: number | null;
  interval: string | null;
  timeout: string | null;
};

export type L4LoadBalancerPassiveHealthCheck = {
  enabled: boolean;
  failDuration: string | null;
  maxFails: number | null;
  unhealthyLatency: string | null;
};

export type L4LoadBalancerConfig = {
  enabled: boolean;
  policy: L4LoadBalancingPolicy;
  /** How many upstreams `random_choose` picks between. */
  policyChoose: number | null;
  /** Weights for `weighted_round_robin`, positional against the upstream list. */
  policyWeights: number[] | null;
  tryDuration: string | null;
  tryInterval: string | null;
  retries: number | null;
  activeHealthCheck: L4LoadBalancerActiveHealthCheck | null;
  passiveHealthCheck: L4LoadBalancerPassiveHealthCheck | null;
};

export type L4DnsResolverConfig = {
  enabled: boolean;
  resolvers: string[];
  fallbacks: string[];
  timeout: string | null;
};

export type L4UpstreamDnsResolutionConfig = {
  enabled: boolean | null;
  family: "ipv6" | "ipv4" | "both" | null;
};

type L4LoadBalancerActiveHealthCheckMeta = {
  enabled?: boolean;
  port?: number;
  interval?: string;
  timeout?: string;
};

type L4LoadBalancerPassiveHealthCheckMeta = {
  enabled?: boolean;
  fail_duration?: string;
  max_fails?: number;
  unhealthy_latency?: string;
};

type L4LoadBalancerMeta = {
  enabled?: boolean;
  policy?: string;
  policy_choose?: number;
  policy_weights?: number[];
  try_duration?: string;
  try_interval?: string;
  retries?: number;
  active_health_check?: L4LoadBalancerActiveHealthCheckMeta;
  passive_health_check?: L4LoadBalancerPassiveHealthCheckMeta;
};

type L4DnsResolverMeta = {
  enabled?: boolean;
  resolvers?: string[];
  fallbacks?: string[];
  timeout?: string;
};

type L4UpstreamDnsResolutionMeta = {
  enabled?: boolean;
  family?: string;
};

export type L4GeoBlockConfig = {
  enabled: boolean;
  block_countries: string[];
  block_continents: string[];
  block_asns: number[];
  block_cidrs: string[];
  block_ips: string[];
  allow_countries: string[];
  allow_continents: string[];
  allow_asns: number[];
  allow_cidrs: string[];
  allow_ips: string[];
};

export type L4GeoBlockMode = "merge" | "override";

export type L4ProxyHostMeta = {
  load_balancer?: L4LoadBalancerMeta;
  dns_resolver?: L4DnsResolverMeta;
  upstream_dns_resolution?: L4UpstreamDnsResolutionMeta;
  geoblock?: L4GeoBlockConfig;
  geoblock_mode?: L4GeoBlockMode;
  crowdsec?: HostCrowdSecMeta;
  /** Absent means `fixed`. */
  upstream_port_mode?: "same";
};

const VALID_L4_LB_POLICIES: L4LoadBalancingPolicy[] = [
  "random",
  "random_choose",
  "round_robin",
  "weighted_round_robin",
  "least_conn",
  "ip_hash",
  "first",
];
const VALID_L4_UPSTREAM_DNS_FAMILIES: L4UpstreamDnsResolutionConfig["family"][] = [
  "ipv6",
  "ipv4",
  "both",
];

export type L4ProxyHost = {
  id: number;
  name: string;
  description: string | null;
  protocol: L4Protocol;
  listenAddress: string;
  upstreams: string[];
  matcherType: L4MatcherType;
  matcherValue: string[];
  tlsTermination: boolean;
  proxyProtocolVersion: L4ProxyProtocolVersion | null;
  proxyProtocolReceive: boolean;
  /** An access list whose IP rules close connections from the addresses they deny. */
  accessListId: number | null;
  enabled: boolean;
  meta: L4ProxyHostMeta | null;
  loadBalancer: L4LoadBalancerConfig | null;
  dnsResolver: L4DnsResolverConfig | null;
  upstreamDnsResolution: L4UpstreamDnsResolutionConfig | null;
  geoblock: L4GeoBlockConfig | null;
  geoblockMode: L4GeoBlockMode;
  /** Checked against CrowdSec's decisions when CrowdSec is set up; on unless the host opts out. */
  crowdsec: boolean;
  /** With `same`, each upstream is a bare host. */
  upstreamPortMode: L4UpstreamPortMode;
  createdAt: string;
  updatedAt: string;
};

export type L4ProxyHostInput = {
  name: string;
  /** Free-text notes; blank clears them. */
  description?: string | null;
  protocol: L4Protocol;
  listenAddress: string;
  upstreams: string[];
  /**
   * Empty (or undefined on update) means every agent. Assigning a host does not recreate the
   * agent's Caddy, so its port still needs the usual apply.
   */
  agentIds?: number[];
  matcherType?: L4MatcherType;
  matcherValue?: string[];
  tlsTermination?: boolean;
  proxyProtocolVersion?: L4ProxyProtocolVersion | null;
  proxyProtocolReceive?: boolean;
  accessListId?: number | null;
  enabled?: boolean;
  meta?: L4ProxyHostMeta | null;
  loadBalancer?: Partial<L4LoadBalancerConfig> | null;
  dnsResolver?: Partial<L4DnsResolverConfig> | null;
  upstreamDnsResolution?: Partial<L4UpstreamDnsResolutionConfig> | null;
  geoblock?: L4GeoBlockConfig | null;
  geoblockMode?: L4GeoBlockMode;
  /** False opts the host out of CrowdSec; true or null follows the global setting. */
  crowdsec?: boolean | null;
  upstreamPortMode?: L4UpstreamPortMode;
};

const VALID_PROTOCOLS: L4Protocol[] = ["tcp", "udp"];
const VALID_MATCHER_TYPES: L4MatcherType[] = ["none", "tls_sni", "http_host", "proxy_protocol"];
const VALID_PROXY_PROTOCOL_VERSIONS: L4ProxyProtocolVersion[] = ["v1", "v2"];

function safeJsonParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeMetaValue(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** A positive whole count off the stored meta, or null. */
function l4Count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function hydrateL4LoadBalancer(meta: L4LoadBalancerMeta | undefined): L4LoadBalancerConfig | null {
  if (!meta) return null;

  const enabled = Boolean(meta.enabled);
  const policy: L4LoadBalancingPolicy =
    meta.policy && VALID_L4_LB_POLICIES.includes(meta.policy as L4LoadBalancingPolicy)
      ? (meta.policy as L4LoadBalancingPolicy)
      : "random";

  const tryDuration = normalizeMetaValue(meta.try_duration ?? null);
  const tryInterval = normalizeMetaValue(meta.try_interval ?? null);
  const retries =
    typeof meta.retries === "number" && Number.isFinite(meta.retries) && meta.retries >= 0
      ? meta.retries
      : null;

  let activeHealthCheck: L4LoadBalancerActiveHealthCheck | null = null;
  if (meta.active_health_check) {
    activeHealthCheck = {
      enabled: Boolean(meta.active_health_check.enabled),
      port:
        typeof meta.active_health_check.port === "number" &&
        Number.isFinite(meta.active_health_check.port) &&
        meta.active_health_check.port > 0
          ? meta.active_health_check.port
          : null,
      interval: normalizeMetaValue(meta.active_health_check.interval ?? null),
      timeout: normalizeMetaValue(meta.active_health_check.timeout ?? null),
    };
  }

  let passiveHealthCheck: L4LoadBalancerPassiveHealthCheck | null = null;
  if (meta.passive_health_check) {
    passiveHealthCheck = {
      enabled: Boolean(meta.passive_health_check.enabled),
      failDuration: normalizeMetaValue(meta.passive_health_check.fail_duration ?? null),
      maxFails:
        typeof meta.passive_health_check.max_fails === "number" &&
        Number.isFinite(meta.passive_health_check.max_fails) &&
        meta.passive_health_check.max_fails >= 0
          ? meta.passive_health_check.max_fails
          : null,
      unhealthyLatency: normalizeMetaValue(meta.passive_health_check.unhealthy_latency ?? null),
    };
  }

  return {
    enabled,
    policy,
    policyChoose: l4Count(meta.policy_choose),
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

function dehydrateL4LoadBalancer(
  config: Partial<L4LoadBalancerConfig> | null,
): L4LoadBalancerMeta | undefined {
  if (!config) return undefined;

  const meta: L4LoadBalancerMeta = {
    enabled: Boolean(config.enabled),
  };

  if (config.policy) {
    meta.policy = config.policy;
  }
  if (config.policyChoose !== undefined && config.policyChoose !== null) {
    meta.policy_choose = config.policyChoose;
  }
  if (config.policyWeights && config.policyWeights.length > 0) {
    meta.policy_weights = config.policyWeights;
  }
  if (config.tryDuration) {
    meta.try_duration = config.tryDuration;
  }
  if (config.tryInterval) {
    meta.try_interval = config.tryInterval;
  }
  if (config.retries !== undefined && config.retries !== null) {
    meta.retries = config.retries;
  }

  if (config.activeHealthCheck) {
    const ahc: L4LoadBalancerActiveHealthCheckMeta = {
      enabled: config.activeHealthCheck.enabled,
    };
    if (config.activeHealthCheck.port !== null && config.activeHealthCheck.port !== undefined) {
      ahc.port = config.activeHealthCheck.port;
    }
    if (config.activeHealthCheck.interval) {
      ahc.interval = config.activeHealthCheck.interval;
    }
    if (config.activeHealthCheck.timeout) {
      ahc.timeout = config.activeHealthCheck.timeout;
    }
    meta.active_health_check = ahc;
  }

  if (config.passiveHealthCheck) {
    const phc: L4LoadBalancerPassiveHealthCheckMeta = {
      enabled: config.passiveHealthCheck.enabled,
    };
    if (config.passiveHealthCheck.failDuration) {
      phc.fail_duration = config.passiveHealthCheck.failDuration;
    }
    if (
      config.passiveHealthCheck.maxFails !== null &&
      config.passiveHealthCheck.maxFails !== undefined
    ) {
      phc.max_fails = config.passiveHealthCheck.maxFails;
    }
    if (config.passiveHealthCheck.unhealthyLatency) {
      phc.unhealthy_latency = config.passiveHealthCheck.unhealthyLatency;
    }
    meta.passive_health_check = phc;
  }

  return meta;
}

function hydrateL4DnsResolver(meta: L4DnsResolverMeta | undefined): L4DnsResolverConfig | null {
  if (!meta) return null;

  const enabled = Boolean(meta.enabled);

  const resolvers = Array.isArray(meta.resolvers)
    ? meta.resolvers.map((r) => (typeof r === "string" ? r.trim() : "")).filter((r) => r.length > 0)
    : [];

  const fallbacks = Array.isArray(meta.fallbacks)
    ? meta.fallbacks.map((r) => (typeof r === "string" ? r.trim() : "")).filter((r) => r.length > 0)
    : [];

  const timeout = normalizeMetaValue(meta.timeout ?? null);

  return {
    enabled,
    resolvers,
    fallbacks,
    timeout,
  };
}

function dehydrateL4DnsResolver(
  config: Partial<L4DnsResolverConfig> | null,
): L4DnsResolverMeta | undefined {
  if (!config) return undefined;

  const meta: L4DnsResolverMeta = {
    enabled: Boolean(config.enabled),
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

function hydrateL4UpstreamDnsResolution(
  meta: L4UpstreamDnsResolutionMeta | undefined,
): L4UpstreamDnsResolutionConfig | null {
  if (!meta) return null;

  const enabled = meta.enabled === undefined ? null : Boolean(meta.enabled);
  const family =
    meta.family &&
    VALID_L4_UPSTREAM_DNS_FAMILIES.includes(meta.family as L4UpstreamDnsResolutionConfig["family"])
      ? (meta.family as L4UpstreamDnsResolutionConfig["family"])
      : null;

  return {
    enabled,
    family,
  };
}

function dehydrateL4UpstreamDnsResolution(
  config: Partial<L4UpstreamDnsResolutionConfig> | null,
): L4UpstreamDnsResolutionMeta | undefined {
  if (!config) return undefined;

  const meta: L4UpstreamDnsResolutionMeta = {};
  if (config.enabled !== null && config.enabled !== undefined) {
    meta.enabled = Boolean(config.enabled);
  }
  if (config.family && VALID_L4_UPSTREAM_DNS_FAMILIES.includes(config.family)) {
    meta.family = config.family;
  }

  return Object.keys(meta).length > 0 ? meta : undefined;
}

type L4ProxyHostRow = typeof l4ProxyHosts.$inferSelect;

function parseL4ProxyHost(row: L4ProxyHostRow): L4ProxyHost {
  const meta = safeJsonParse<L4ProxyHostMeta>(row.meta, {});
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    protocol: row.protocol as L4Protocol,
    listenAddress: row.listenAddress,
    upstreams: safeJsonParse<string[]>(row.upstreams, []),
    matcherType: (row.matcherType as L4MatcherType) || "none",
    matcherValue: safeJsonParse<string[]>(row.matcherValue, []),
    tlsTermination: row.tlsTermination,
    proxyProtocolVersion: row.proxyProtocolVersion as L4ProxyProtocolVersion | null,
    proxyProtocolReceive: row.proxyProtocolReceive,
    accessListId: row.accessListId ?? null,
    enabled: row.enabled,
    meta: Object.keys(meta).length > 0 ? meta : null,
    loadBalancer: hydrateL4LoadBalancer(meta.load_balancer),
    dnsResolver: hydrateL4DnsResolver(meta.dns_resolver),
    upstreamDnsResolution: hydrateL4UpstreamDnsResolution(meta.upstream_dns_resolution),
    geoblock: meta.geoblock?.enabled ? meta.geoblock : null,
    geoblockMode: meta.geoblock_mode ?? "merge",
    crowdsec: hostCrowdSecEnabled(sanitizeHostCrowdSec(meta.crowdsec)),
    upstreamPortMode: meta.upstream_port_mode === "same" ? "same" : "fixed",
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

function validateL4Input(input: L4ProxyHostInput | Partial<L4ProxyHostInput>, isCreate: boolean) {
  if (isCreate) {
    if (!input.name?.trim()) {
      throw domainError("nameRequired", {}, { status: 400 });
    }
    if (!input.protocol || !VALID_PROTOCOLS.includes(input.protocol)) {
      throw domainError("invalidL4Protocol", {}, { status: 400 });
    }
    if (!input.listenAddress?.trim()) {
      throw domainError("listenAddressRequired", {}, { status: 400 });
    }
    if (!input.upstreams || input.upstreams.length === 0) {
      throw domainError("upstreamsRequired", {}, { status: 400 });
    }
  }

  if (input.listenAddress !== undefined) {
    // Not a trailing-colon match: `2001:db8::1` ends in `:1` and would become a listener on port
    // 1. IPv6 literals must be bracketed, as everywhere else in this stack.
    const parsed = splitHostPortRange(input.listenAddress);
    if (parsed === null) {
      throw domainError("l4ListenAddressInvalid", {}, { status: 400 });
    }
    if (l4PortCount(parsed) > MAX_L4_PORTS_PER_HOST) {
      throw domainError("l4ListenRangeTooLarge", { max: MAX_L4_PORTS_PER_HOST }, { status: 400 });
    }
    const reserved = reservedL4Port(parsed, null);
    if (reserved !== null) {
      throw domainError("l4ListenPortReserved", { port: reserved }, { status: 400 });
    }
  }

  if (
    input.upstreamPortMode !== undefined &&
    input.upstreamPortMode !== "fixed" &&
    input.upstreamPortMode !== "same"
  ) {
    throw domainError("l4UpstreamPortModeInvalid", {}, { status: 400 });
  }

  if (input.protocol !== undefined && !VALID_PROTOCOLS.includes(input.protocol)) {
    throw domainError("invalidL4Protocol", {}, { status: 400 });
  }

  if (input.matcherType !== undefined && !VALID_MATCHER_TYPES.includes(input.matcherType)) {
    throw domainError("l4MatcherTypeInvalid", { types: VALID_MATCHER_TYPES }, { status: 400 });
  }

  if (input.matcherType === "tls_sni" || input.matcherType === "http_host") {
    if (!input.matcherValue || input.matcherValue.length === 0) {
      throw domainError("matcherHostnamesRequired", {}, { status: 400 });
    }
  }

  if (input.tlsTermination && input.protocol === "udp") {
    throw domainError("udpTlsTerminationUnsupported", {}, { status: 400 });
  }

  if (input.proxyProtocolVersion !== undefined && input.proxyProtocolVersion !== null) {
    if (!VALID_PROXY_PROTOCOL_VERSIONS.includes(input.proxyProtocolVersion)) {
      throw domainError("invalidProxyProtocolVersion", {}, { status: 400 });
    }
  }
}

/**
 * Cross-field, so run on the merged host: an update can switch the mode without resending the
 * upstreams it applies to.
 */
function validateL4Upstreams(
  upstreams: string[],
  mode: L4UpstreamPortMode,
  activeHealthCheck: boolean,
): void {
  for (const upstream of upstreams) {
    if (mode === "same") {
      if (splitL4UpstreamHost(upstream) === null) {
        throw domainError("l4SamePortUpstreamInvalid", { upstream }, { status: 400 });
      }
      continue;
    }
    // A bare IPv6 literal contains colons and would have passed a `includes(":")` check while
    // naming no port at all.
    if (splitHostPort(upstream) === null || splitHostPort(upstream)?.host === "") {
      throw domainError("l4UpstreamInvalid", { upstream }, { status: 400 });
    }
  }
  // caddy-l4 probes each upstream's dial address, and in `same` that holds a per-connection port.
  if (mode === "same" && activeHealthCheck) {
    throw domainError("l4SamePortActiveHealthCheck", {}, { status: 400 });
  }
}

/**
 * Only a list's IP rules apply at layer 4 - there is no request to ask a password in - so a list
 * without any would close every connection.
 */
async function assertL4AccessList(id: number | null | undefined): Promise<void> {
  if (id === undefined || id === null) return;
  if (!Number.isInteger(id)) throw domainError("accessListNotFound", {}, { status: 400 });
  const [list] = await db
    .select({ id: accessLists.id })
    .from(accessLists)
    .where(eq(accessLists.id, id));
  if (!list) throw domainError("accessListNotFound", {}, { status: 400 });
  const [rule] = await db
    .select({ id: accessListIpRules.id })
    .from(accessListIpRules)
    .where(eq(accessListIpRules.accessListId, id))
    .limit(1);
  if (!rule) throw domainError("l4AccessListNeedsIpRules", {}, { status: 400 });
}

export async function listL4ProxyHosts(): Promise<L4ProxyHost[]> {
  const hosts = await db.select().from(l4ProxyHosts).orderBy(desc(l4ProxyHosts.createdAt));
  return hosts.map(parseL4ProxyHost);
}

/**
 * `visibleIds` null means unrestricted (admin). An empty array means the viewer sees nothing and
 * must not be dropped, or the query would list every host.
 */
function l4ListFilter(search?: string, visibleIds?: number[] | null, protocol?: L4Protocol) {
  const clauses = [];
  if (protocol) {
    clauses.push(eq(l4ProxyHosts.protocol, protocol));
  }
  if (search) {
    clauses.push(
      or(
        like(l4ProxyHosts.name, `%${search}%`),
        like(l4ProxyHosts.description, `%${search}%`),
        like(l4ProxyHosts.listenAddress, `%${search}%`),
        like(l4ProxyHosts.upstreams, `%${search}%`),
      ),
    );
  }
  if (visibleIds != null) {
    clauses.push(visibleIds.length > 0 ? inArray(l4ProxyHosts.id, visibleIds) : sql`false`);
  }
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : and(...clauses);
}

export async function countL4ProxyHosts(
  search?: string,
  visibleIds?: number[] | null,
  protocol?: L4Protocol,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(l4ProxyHosts)
    .where(l4ListFilter(search, visibleIds, protocol));
  return row?.value ?? 0;
}

/** Enabled only: disabled hosts emit no config, so they do not block switching caddy-l4 off. */
export async function listEnabledL4ProxyHostIds(): Promise<number[]> {
  const rows = await db
    .select({ id: l4ProxyHosts.id })
    .from(l4ProxyHosts)
    .where(eq(l4ProxyHosts.enabled, true));
  return rows.map((row) => row.id);
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous drizzle columns have no useful union
const L4_SORT_COLUMNS: Record<string, any> = {
  name: l4ProxyHosts.name,
  protocol: l4ProxyHosts.protocol,
  listenAddress: l4ProxyHosts.listenAddress,
  upstreams: l4ProxyHosts.upstreams,
  enabled: l4ProxyHosts.enabled,
  createdAt: l4ProxyHosts.createdAt,
};

export async function listL4ProxyHostsPaginated(
  limit: number,
  offset: number,
  search?: string,
  sortBy?: string,
  sortDir?: "asc" | "desc",
  visibleIds?: number[] | null,
  protocol?: L4Protocol,
): Promise<L4ProxyHost[]> {
  const where = l4ListFilter(search, visibleIds, protocol);
  const col = (sortBy && L4_SORT_COLUMNS[sortBy]) || l4ProxyHosts.createdAt;
  const dir = sortDir === "asc" ? asc : desc;
  const hosts = await db
    .select()
    .from(l4ProxyHosts)
    .where(where)
    .orderBy(dir(col))
    .limit(limit)
    .offset(offset);
  return hosts.map(parseL4ProxyHost);
}

/** The metrics listener's port is configurable, so it is checked here rather than in the constant. */
export async function assertNotMetricsPort(listenAddress: string | undefined): Promise<void> {
  if (listenAddress === undefined) return;
  const parsed = splitHostPortRange(listenAddress);
  const metrics = await getMetricsSettings();
  if (!parsed || !metrics?.enabled) return;
  const port = metrics.port ?? 9090;
  if (port >= parsed.start && port <= parsed.end) {
    throw domainError("l4ListenPortReserved", { port }, { status: 400 });
  }
}

export async function createL4ProxyHost(input: L4ProxyHostInput, actorUserId: number) {
  validateL4Input(input, true);
  validateL4Upstreams(
    input.upstreams,
    input.upstreamPortMode ?? "fixed",
    Boolean(input.loadBalancer?.activeHealthCheck?.enabled),
  );
  await assertNotMetricsPort(input.listenAddress);
  if (input.enabled ?? true) {
    await assertL4PortPlan([
      {
        id: null,
        protocol: input.protocol,
        listenAddress: input.listenAddress,
        agentIds: input.agentIds ?? [],
      },
    ]);
  }
  await assertL4AccessList(input.accessListId);
  await assertNoNewAdminDialTargets([], input.upstreams, actorUserId);

  const now = nowIso();
  const [record] = await db
    .insert(l4ProxyHosts)
    .values({
      name: input.name.trim(),
      description: normalizeHostDescription(input.description) ?? null,
      protocol: input.protocol,
      listenAddress: input.listenAddress.trim(),
      upstreams: JSON.stringify(Array.from(new Set(input.upstreams.map((u) => u.trim())))),
      matcherType: input.matcherType ?? "none",
      matcherValue: input.matcherValue
        ? JSON.stringify(input.matcherValue.map((v) => v.trim()).filter(Boolean))
        : null,
      tlsTermination: input.tlsTermination ?? false,
      proxyProtocolVersion: input.proxyProtocolVersion ?? null,
      proxyProtocolReceive: input.proxyProtocolReceive ?? false,
      accessListId: input.accessListId ?? null,
      ownerUserId: actorUserId,
      meta: (() => {
        const meta: L4ProxyHostMeta = { ...(input.meta ?? {}) };
        if (input.loadBalancer) meta.load_balancer = dehydrateL4LoadBalancer(input.loadBalancer);
        if (input.dnsResolver) meta.dns_resolver = dehydrateL4DnsResolver(input.dnsResolver);
        if (input.upstreamDnsResolution)
          meta.upstream_dns_resolution = dehydrateL4UpstreamDnsResolution(
            input.upstreamDnsResolution,
          );
        if (input.geoblock) meta.geoblock = input.geoblock;
        if (input.geoblockMode && input.geoblockMode !== "merge")
          meta.geoblock_mode = input.geoblockMode;
        const crowdsec =
          input.crowdsec !== undefined
            ? storedHostCrowdSec(input.crowdsec !== false)
            : sanitizeHostCrowdSec(meta.crowdsec);
        if (crowdsec) meta.crowdsec = crowdsec;
        else delete meta.crowdsec;
        // What was validated, not a raw `meta` passed through.
        if (input.upstreamPortMode === "same") meta.upstream_port_mode = "same";
        else delete meta.upstream_port_mode;
        return Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;
      })(),
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!record) {
    throw domainError("l4ProxyHostCreationFailed");
  }

  if (input.agentIds !== undefined) {
    await setHostAgents("l4", record.id, input.agentIds);
  }

  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "l4_proxy_host",
    entityId: record.id,
    summary: `Created L4 proxy host ${input.name}`,
    data: input,
  });

  await applyCaddyConfig();
  return (await getL4ProxyHost(record.id))!;
}

export async function getL4ProxyHost(id: number): Promise<L4ProxyHost | null> {
  const host = await db.query.l4ProxyHosts.findFirst({
    where: (table, { eq }) => eq(table.id, id),
  });
  return host ? parseL4ProxyHost(host) : null;
}

export async function updateL4ProxyHost(
  id: number,
  input: Partial<L4ProxyHostInput>,
  actorUserId: number,
) {
  const existing = await getL4ProxyHost(id);
  if (!existing) {
    throw domainError("l4ProxyHostNotFound", {}, { status: 404 });
  }

  // Merged so cross-field constraints see the stored values.
  const merged = {
    protocol: input.protocol ?? existing.protocol,
    tlsTermination: input.tlsTermination ?? existing.tlsTermination,
    matcherType: input.matcherType ?? existing.matcherType,
    matcherValue: input.matcherValue ?? existing.matcherValue,
  };
  if (merged.tlsTermination && merged.protocol === "udp") {
    throw domainError("udpTlsTerminationUnsupported", {}, { status: 400 });
  }
  if (
    (merged.matcherType === "tls_sni" || merged.matcherType === "http_host") &&
    merged.matcherValue.length === 0
  ) {
    throw domainError("matcherHostnamesRequired", {}, { status: 400 });
  }

  validateL4Input(input, false);
  const upstreamPortMode = input.upstreamPortMode ?? existing.upstreamPortMode;
  if (
    input.upstreams !== undefined ||
    input.upstreamPortMode !== undefined ||
    input.loadBalancer !== undefined
  ) {
    const loadBalancer =
      input.loadBalancer !== undefined ? input.loadBalancer : existing.loadBalancer;
    validateL4Upstreams(
      input.upstreams ?? existing.upstreams,
      upstreamPortMode,
      Boolean(loadBalancer?.activeHealthCheck?.enabled),
    );
  }
  await assertNotMetricsPort(input.listenAddress);
  const enabled = input.enabled ?? existing.enabled;
  const portsMove =
    (input.enabled === true && !existing.enabled) ||
    (input.listenAddress !== undefined && input.listenAddress.trim() !== existing.listenAddress) ||
    (input.protocol !== undefined && input.protocol !== existing.protocol) ||
    input.agentIds !== undefined;
  if (enabled && portsMove) {
    await assertL4PortPlan([
      {
        id,
        protocol: input.protocol ?? existing.protocol,
        listenAddress: input.listenAddress ?? existing.listenAddress,
        agentIds: input.agentIds ?? (await agentIdsForHost("l4", id)),
      },
    ]);
  }
  await assertL4AccessList(input.accessListId);
  // A layer-4 dial is a raw TCP pipe, so an upstream on the admin port publishes the whole admin
  // API on this host's listen port - the same hole the HTTP host model closes.
  await assertNoNewAdminDialTargets(existing.upstreams, input.upstreams ?? [], actorUserId);

  const now = nowIso();
  await db
    .update(l4ProxyHosts)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined
        ? { description: normalizeHostDescription(input.description) }
        : {}),
      ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
      ...(input.listenAddress !== undefined ? { listenAddress: input.listenAddress.trim() } : {}),
      ...(input.upstreams !== undefined
        ? { upstreams: JSON.stringify(Array.from(new Set(input.upstreams.map((u) => u.trim())))) }
        : {}),
      ...(input.matcherType !== undefined ? { matcherType: input.matcherType } : {}),
      ...(input.matcherValue !== undefined
        ? { matcherValue: JSON.stringify(input.matcherValue.map((v) => v.trim()).filter(Boolean)) }
        : {}),
      ...(input.tlsTermination !== undefined ? { tlsTermination: input.tlsTermination } : {}),
      ...(input.proxyProtocolVersion !== undefined
        ? { proxyProtocolVersion: input.proxyProtocolVersion }
        : {}),
      ...(input.proxyProtocolReceive !== undefined
        ? { proxyProtocolReceive: input.proxyProtocolReceive }
        : {}),
      ...(input.accessListId !== undefined ? { accessListId: input.accessListId } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(() => {
        const hasMetaChanges =
          input.meta !== undefined ||
          input.loadBalancer !== undefined ||
          input.dnsResolver !== undefined ||
          input.upstreamDnsResolution !== undefined ||
          input.geoblock !== undefined ||
          input.geoblockMode !== undefined ||
          input.crowdsec !== undefined ||
          input.upstreamPortMode !== undefined;
        if (!hasMetaChanges) return {};

        const existingMeta: L4ProxyHostMeta = {
          ...(existing.loadBalancer
            ? { load_balancer: dehydrateL4LoadBalancer(existing.loadBalancer) }
            : {}),
          ...(existing.dnsResolver
            ? { dns_resolver: dehydrateL4DnsResolver(existing.dnsResolver) }
            : {}),
          ...(existing.upstreamDnsResolution
            ? {
                upstream_dns_resolution: dehydrateL4UpstreamDnsResolution(
                  existing.upstreamDnsResolution,
                ),
              }
            : {}),
          ...(existing.geoblock ? { geoblock: existing.geoblock } : {}),
          ...(existing.geoblockMode !== "merge" ? { geoblock_mode: existing.geoblockMode } : {}),
          ...(existing.crowdsec ? {} : { crowdsec: { enabled: false } as const }),
          ...(existing.upstreamPortMode === "same" ? { upstream_port_mode: "same" as const } : {}),
        };

        const meta: L4ProxyHostMeta =
          input.meta !== undefined ? { ...(input.meta ?? {}) } : { ...existingMeta };

        if (input.loadBalancer !== undefined) {
          const lb = dehydrateL4LoadBalancer(input.loadBalancer);
          if (lb) {
            meta.load_balancer = lb;
          } else {
            delete meta.load_balancer;
          }
        }
        if (input.dnsResolver !== undefined) {
          const dr = dehydrateL4DnsResolver(input.dnsResolver);
          if (dr) {
            meta.dns_resolver = dr;
          } else {
            delete meta.dns_resolver;
          }
        }
        if (input.upstreamDnsResolution !== undefined) {
          const udr = dehydrateL4UpstreamDnsResolution(input.upstreamDnsResolution);
          if (udr) {
            meta.upstream_dns_resolution = udr;
          } else {
            delete meta.upstream_dns_resolution;
          }
        }
        if (input.geoblock !== undefined) {
          if (input.geoblock) {
            meta.geoblock = input.geoblock;
          } else {
            delete meta.geoblock;
          }
        }
        if (input.geoblockMode !== undefined) {
          if (input.geoblockMode !== "merge") {
            meta.geoblock_mode = input.geoblockMode;
          } else {
            delete meta.geoblock_mode;
          }
        }
        const crowdsec =
          input.crowdsec !== undefined
            ? storedHostCrowdSec(input.crowdsec !== false)
            : sanitizeHostCrowdSec(meta.crowdsec);
        if (crowdsec) meta.crowdsec = crowdsec;
        else delete meta.crowdsec;
        if (upstreamPortMode === "same") meta.upstream_port_mode = "same";
        else delete meta.upstream_port_mode;

        return { meta: Object.keys(meta).length > 0 ? JSON.stringify(meta) : null };
      })(),
      updatedAt: now,
    })
    .where(eq(l4ProxyHosts.id, id));

  if (input.agentIds !== undefined) {
    await setHostAgents("l4", id, input.agentIds);
  }

  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "l4_proxy_host",
    entityId: id,
    summary: `Updated L4 proxy host ${input.name ?? existing.name}`,
    data: input,
  });

  await applyCaddyConfig();
  return (await getL4ProxyHost(id))!;
}

export async function deleteL4ProxyHost(id: number, actorUserId: number) {
  const existing = await getL4ProxyHost(id);
  if (!existing) {
    throw domainError("l4ProxyHostNotFound", {}, { status: 404 });
  }

  await db.delete(l4ProxyHosts).where(eq(l4ProxyHosts.id, id));
  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "l4_proxy_host",
    entityId: id,
    summary: `Deleted L4 proxy host ${existing.name}`,
  });
  await applyCaddyConfig();
}

export type L4ProxyHostCounts = { total: number; tcp: number; udp: number; enabled: number };

/** Protocol and enabled totals across everything visible, for the tiles and the tab counts. */
export async function countL4ProxyHostsByProtocol(
  search?: string,
  visibleIds?: number[] | null,
): Promise<L4ProxyHostCounts> {
  const [row] = await db
    .select({
      total: count(),
      tcp: sql<number>`sum(case when ${l4ProxyHosts.protocol} = 'tcp' then 1 else 0 end)`.mapWith(
        Number,
      ),
      enabled: sql<number>`sum(case when ${l4ProxyHosts.enabled} then 1 else 0 end)`.mapWith(
        Number,
      ),
    })
    .from(l4ProxyHosts)
    .where(l4ListFilter(search, visibleIds));
  const total = row?.total ?? 0;
  const tcp = row?.tcp ?? 0;
  return { total, tcp, udp: total - tcp, enabled: row?.enabled ?? 0 };
}
