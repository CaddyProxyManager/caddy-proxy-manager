"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/src/lib/auth";
import { assertCanManage, requireAccess } from "@/src/lib/permissions";
import { getTranslations } from "next-intl/server";
import {
  actionError,
  actionSuccess,
  INITIAL_ACTION_STATE,
  type ActionState,
} from "@/src/lib/actions";
import {
  createL4ProxyHost,
  deleteL4ProxyHost,
  updateL4ProxyHost,
  type L4ProxyHostInput,
  type L4Protocol,
  type L4MatcherType,
  type L4ProxyProtocolVersion,
  type L4LoadBalancingPolicy,
  type L4LoadBalancerConfig,
  type L4DnsResolverConfig,
  type L4UpstreamDnsResolutionConfig,
  type L4GeoBlockConfig,
  type L4GeoBlockMode,
  type L4UpstreamPortMode,
} from "@/src/lib/models/l4-proxy-hosts";
import { parseAgentIds } from "@/src/lib/models/host-agents";
import {
  type L4HostBulkRequest,
  bulkUpdateL4ProxyHosts,
  parseL4HostBulkRequest,
} from "@/src/lib/models/bulk-hosts";
import {
  parseCheckbox,
  parseCsv,
  parseUpstreams,
  parseOptionalText,
  parseOptionalNumber,
  parseAccessListId,
} from "@/src/lib/form-parse";

const VALID_PROTOCOLS: L4Protocol[] = ["tcp", "udp"];
const VALID_MATCHER_TYPES: L4MatcherType[] = ["none", "tls_sni", "http_host", "proxy_protocol"];
const VALID_PP_VERSIONS: L4ProxyProtocolVersion[] = ["v1", "v2"];
const VALID_L4_LB_POLICIES: L4LoadBalancingPolicy[] = [
  "random",
  "random_choose",
  "round_robin",
  "weighted_round_robin",
  "least_conn",
  "ip_hash",
  "first",
];
const VALID_DNS_FAMILIES = ["ipv6", "ipv4", "both"] as const;

/**
 * Weights for `weighted_round_robin`, comma-separated in upstream order. All or nothing: a weight
 * silently dropped to 0 takes a backend out of rotation with nothing on screen to say why.
 */
function parseWeights(value: FormDataEntryValue | null): number[] | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;

  const weights = parts.map((part) => Number.parseInt(part, 10));
  return weights.every((w) => Number.isInteger(w) && w >= 0 && w <= 1000) ? weights : null;
}

function parseL4LoadBalancerConfig(formData: FormData): Partial<L4LoadBalancerConfig> | undefined {
  if (!formData.has("lbPresent")) return undefined;
  const enabled = formData.has("lbEnabledPresent")
    ? parseCheckbox(formData.get("lbEnabled"))
    : undefined;
  const policyRaw = parseOptionalText(formData.get("lbPolicy"));
  const policy =
    policyRaw && VALID_L4_LB_POLICIES.includes(policyRaw as L4LoadBalancingPolicy)
      ? (policyRaw as L4LoadBalancingPolicy)
      : undefined;

  const result: Partial<L4LoadBalancerConfig> = {};
  if (enabled !== undefined) result.enabled = enabled;
  if (policy) result.policy = policy;
  // Presence, not value (see parseLoadBalancerConfig in the proxy-hosts actions), or an emptied
  // box could never be cleared. The three caddy-l4 lacks stay for hosts saved before their
  // withdrawal; the form no longer renders them and the generator refuses to emit them.
  if (formData.has("lbTryDuration")) {
    result.tryDuration = parseOptionalText(formData.get("lbTryDuration"));
  }
  if (formData.has("lbTryInterval")) {
    result.tryInterval = parseOptionalText(formData.get("lbTryInterval"));
  }
  if (formData.has("lbRetries")) {
    result.retries = parseOptionalNumber(formData.get("lbRetries")) ?? undefined;
  }
  if (formData.has("lbPolicyChoose")) {
    result.policyChoose = parseOptionalNumber(formData.get("lbPolicyChoose"));
  }
  if (formData.has("lbPolicyWeights")) {
    result.policyWeights = parseWeights(formData.get("lbPolicyWeights"));
  }

  if (formData.has("lbActiveHealthEnabledPresent")) {
    result.activeHealthCheck = {
      enabled: parseCheckbox(formData.get("lbActiveHealthEnabled")),
      port: parseOptionalNumber(formData.get("lbActiveHealthPort")),
      interval: parseOptionalText(formData.get("lbActiveHealthInterval")),
      timeout: parseOptionalText(formData.get("lbActiveHealthTimeout")),
    };
  }

  if (formData.has("lbPassiveHealthEnabledPresent")) {
    result.passiveHealthCheck = {
      enabled: parseCheckbox(formData.get("lbPassiveHealthEnabled")),
      failDuration: parseOptionalText(formData.get("lbPassiveHealthFailDuration")),
      maxFails: parseOptionalNumber(formData.get("lbPassiveHealthMaxFails")),
      unhealthyLatency: parseOptionalText(formData.get("lbPassiveHealthUnhealthyLatency")),
    };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseL4DnsResolverConfig(formData: FormData): Partial<L4DnsResolverConfig> | undefined {
  if (!formData.has("dnsPresent")) return undefined;
  const enabled = formData.has("dnsEnabledPresent")
    ? parseCheckbox(formData.get("dnsEnabled"))
    : undefined;
  const resolversRaw = parseOptionalText(formData.get("dnsResolvers"));
  const resolvers = resolversRaw
    ? resolversRaw
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const fallbacksRaw = parseOptionalText(formData.get("dnsFallbacks"));
  const fallbacks = fallbacksRaw
    ? fallbacksRaw
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const timeout = parseOptionalText(formData.get("dnsTimeout"));

  const result: Partial<L4DnsResolverConfig> = {};
  if (enabled !== undefined) result.enabled = enabled;
  if (resolvers) result.resolvers = resolvers;
  if (fallbacks) result.fallbacks = fallbacks;
  if (timeout !== null) result.timeout = timeout;

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseL4UpstreamDnsResolutionConfig(
  formData: FormData,
): Partial<L4UpstreamDnsResolutionConfig> | undefined {
  if (!formData.has("upstreamDnsResolutionPresent")) return undefined;
  const modeRaw = parseOptionalText(formData.get("upstreamDnsResolutionMode")) ?? "inherit";
  const familyRaw = parseOptionalText(formData.get("upstreamDnsResolutionFamily")) ?? "inherit";

  const result: Partial<L4UpstreamDnsResolutionConfig> = {};
  if (modeRaw === "enabled") result.enabled = true;
  else if (modeRaw === "disabled") result.enabled = false;
  else if (modeRaw === "inherit") result.enabled = null;

  if (familyRaw === "inherit") result.family = null;
  else if (VALID_DNS_FAMILIES.includes(familyRaw as (typeof VALID_DNS_FAMILIES)[number])) {
    result.family = familyRaw as "ipv6" | "ipv4" | "both";
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseL4GeoBlockConfig(formData: FormData): {
  geoblock: L4GeoBlockConfig | null;
  geoblockMode: L4GeoBlockMode;
} {
  if (!formData.has("geoblockPresent")) {
    return { geoblock: null, geoblockMode: "merge" };
  }
  const enabled = parseCheckbox(formData.get("geoblockEnabled"));
  const rawMode = formData.get("geoblockMode");
  const mode: L4GeoBlockMode = rawMode === "override" ? "override" : "merge";

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

  const config: L4GeoBlockConfig = {
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
  };
  return { geoblock: config, geoblockMode: mode };
}

function parseProtocol(formData: FormData): L4Protocol {
  const raw = String(formData.get("protocol") ?? "tcp")
    .trim()
    .toLowerCase();
  if (VALID_PROTOCOLS.includes(raw as L4Protocol)) return raw as L4Protocol;
  return "tcp";
}

function parseMatcherType(formData: FormData): L4MatcherType {
  const raw = String(formData.get("matcherType") ?? "none").trim();
  if (VALID_MATCHER_TYPES.includes(raw as L4MatcherType)) return raw as L4MatcherType;
  return "none";
}

function parseUpstreamPortMode(formData: FormData): L4UpstreamPortMode | undefined {
  if (!formData.has("upstreamPortMode")) return undefined;
  return formData.get("upstreamPortMode") === "same" ? "same" : "fixed";
}

function parseProxyProtocolVersion(formData: FormData): L4ProxyProtocolVersion | null {
  const raw = parseOptionalText(formData.get("proxyProtocolVersion"));
  if (raw && VALID_PP_VERSIONS.includes(raw as L4ProxyProtocolVersion))
    return raw as L4ProxyProtocolVersion;
  return null;
}

export async function createL4ProxyHostAction(
  _prevState: ActionState = INITIAL_ACTION_STATE,
  formData: FormData,
): Promise<ActionState> {
  void _prevState;
  try {
    const session = await requireAdmin();
    const userId = Number(session.user.id);

    const matcherType = parseMatcherType(formData);
    const matcherValue =
      matcherType === "tls_sni" || matcherType === "http_host"
        ? parseCsv(formData.get("matcherValue"))
        : [];

    const input: L4ProxyHostInput = {
      name: String(formData.get("name") ?? "Untitled"),
      description: formData.has("description") ? String(formData.get("description")) : undefined,
      protocol: parseProtocol(formData),
      listenAddress: String(formData.get("listenAddress") ?? "").trim(),
      upstreams: parseUpstreams(formData.get("upstreams")),
      upstreamPortMode: parseUpstreamPortMode(formData),
      matcherType: matcherType,
      matcherValue: matcherValue,
      tlsTermination: parseCheckbox(formData.get("tlsTermination")),
      proxyProtocolVersion: parseProxyProtocolVersion(formData),
      proxyProtocolReceive: parseCheckbox(formData.get("proxyProtocolReceive")),
      accessListId: parseAccessListId(formData.get("accessListId")),
      enabled: parseCheckbox(formData.get("enabled")),
      agentIds: parseAgentIds(formData.getAll("agentId")),
      loadBalancer: parseL4LoadBalancerConfig(formData),
      dnsResolver: parseL4DnsResolverConfig(formData),
      upstreamDnsResolution: parseL4UpstreamDnsResolutionConfig(formData),
      ...parseL4GeoBlockConfig(formData),
      crowdsec: formData.has("crowdsecPresent")
        ? parseCheckbox(formData.get("crowdsecEnabled"))
        : undefined,
    };

    await createL4ProxyHost(input, userId);
    revalidatePath("/l4-proxy-hosts");
    const t = await getTranslations("l4ProxyHosts");
    return actionSuccess(t("hostCreated"));
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to create L4 proxy host:", error);
    return actionError(t, error, t("errors.createL4HostFailed"));
  }
}

export async function updateL4ProxyHostAction(
  id: number,
  _prevState: ActionState = INITIAL_ACTION_STATE,
  formData: FormData,
): Promise<ActionState> {
  void _prevState;
  try {
    // An operator may edit a host their groups were granted; creating one stays with admins,
    // because a grant names a host that already exists.
    const access = await requireAccess();
    assertCanManage(access, "l4ProxyHost", id);
    const userId = access.userId;

    const matcherType = parseMatcherType(formData);
    const matcherValue =
      matcherType === "tls_sni" || matcherType === "http_host"
        ? parseCsv(formData.get("matcherValue"))
        : [];

    const input: Partial<L4ProxyHostInput> = {
      name: formData.get("name") ? String(formData.get("name")) : undefined,
      description: formData.has("description") ? String(formData.get("description")) : undefined,
      protocol: parseProtocol(formData),
      listenAddress: formData.get("listenAddress")
        ? String(formData.get("listenAddress")).trim()
        : undefined,
      upstreams: formData.get("upstreams") ? parseUpstreams(formData.get("upstreams")) : undefined,
      upstreamPortMode: parseUpstreamPortMode(formData),
      matcherType: matcherType,
      matcherValue: matcherValue,
      tlsTermination: parseCheckbox(formData.get("tlsTermination")),
      proxyProtocolVersion: parseProxyProtocolVersion(formData),
      proxyProtocolReceive: parseCheckbox(formData.get("proxyProtocolReceive")),
      accessListId: formData.has("accessListId")
        ? parseAccessListId(formData.get("accessListId"))
        : undefined,
      enabled: formData.has("enabledPresent") ? parseCheckbox(formData.get("enabled")) : undefined,
      agentIds: formData.has("agentAssignmentPresent")
        ? parseAgentIds(formData.getAll("agentId"))
        : undefined,
      loadBalancer: parseL4LoadBalancerConfig(formData),
      dnsResolver: parseL4DnsResolverConfig(formData),
      upstreamDnsResolution: parseL4UpstreamDnsResolutionConfig(formData),
      ...parseL4GeoBlockConfig(formData),
      crowdsec: formData.has("crowdsecPresent")
        ? parseCheckbox(formData.get("crowdsecEnabled"))
        : undefined,
    };

    await updateL4ProxyHost(id, input, userId);
    revalidatePath("/l4-proxy-hosts");
    const t = await getTranslations("l4ProxyHosts");
    return actionSuccess(t("hostUpdated"));
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to update L4 proxy host:", id, error);
    return actionError(t, error, t("errors.updateL4HostFailed"));
  }
}

export async function deleteL4ProxyHostAction(
  id: number,
  _prevState: ActionState = INITIAL_ACTION_STATE,
): Promise<ActionState> {
  void _prevState;
  try {
    const access = await requireAccess();
    assertCanManage(access, "l4ProxyHost", id);
    await deleteL4ProxyHost(id, access.userId);
    revalidatePath("/l4-proxy-hosts");
    const t = await getTranslations("l4ProxyHosts");
    return actionSuccess(t("hostDeleted"));
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to delete L4 proxy host:", id, error);
    return actionError(t, error, t("errors.deleteL4HostFailed"));
  }
}

export async function toggleL4ProxyHostAction(id: number, enabled: boolean): Promise<ActionState> {
  try {
    const access = await requireAccess();
    assertCanManage(access, "l4ProxyHost", id);
    await updateL4ProxyHost(id, { enabled }, access.userId);
    revalidatePath("/l4-proxy-hosts");
    const t = await getTranslations("l4ProxyHosts");
    return actionSuccess(enabled ? t("hostEnabledMessage") : t("hostDisabledMessage"));
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to toggle L4 proxy host:", id, error);
    return actionError(t, error, t("errors.toggleL4HostFailed"));
  }
}

/** All or nothing, as for proxy hosts. */
export async function bulkL4ProxyHostsAction(request: L4HostBulkRequest): Promise<ActionState> {
  try {
    const access = await requireAccess();
    const parsed = parseL4HostBulkRequest(request);
    for (const id of parsed.ids) assertCanManage(access, "l4ProxyHost", id);
    const { count } = await bulkUpdateL4ProxyHosts(parsed, access.userId);
    revalidatePath("/l4-proxy-hosts");
    const t = await getTranslations("ui");
    return actionSuccess(
      parsed.action === "delete"
        ? t("bulk.deletedResult", { count })
        : t("bulk.updatedResult", { count }),
    );
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to change L4 proxy hosts in bulk:", error);
    return actionError(t, error, t("errors.bulkHostsFailed"));
  }
}
