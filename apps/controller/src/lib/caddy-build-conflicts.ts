/**
 * Refusing a module selection something still uses. Kept out of caddy-build.ts to avoid an import
 * cycle; only the two write paths (settings action, REST endpoint) need it.
 */

import { resolveEnabledModuleIds } from "./caddy-build";
import { CADDY_MODULES, CROWDSEC_MODULE_ID, dnsModuleId } from "./caddy-modules";
import { listEnabledL4ProxyHostIds } from "./models/l4-proxy-hosts";
import { listHostAssignments, servedByAgent } from "./models/host-agents";
import { listProxyHosts } from "./models/proxy-hosts";
import {
  type CaddyBuildSettings,
  getCrowdSecSettings,
  getDnsProviderSettings,
  getGeoBlockSettings,
  getWafSettings,
} from "./settings";

/**
 * Data, not a sentence, so the settings action can translate it (`moduleConflictMessage`) while
 * `/api/v1` keeps English. A test keeps the two wordings equal.
 */
export type ModuleConflict =
  | { kind: "l4Hosts" | "hostWaf" | "hostGeoblock" | "tailnetHosts"; count: number }
  | { kind: "globalWaf" | "globalGeoblock" | "globalCrowdsec" }
  | { kind: "defaultDnsProvider" | "dnsProviderCredentials"; provider: string };

/** A conflict as `/api/v1` has always worded it. */
export function englishModuleConflict(conflict: ModuleConflict): string {
  switch (conflict.kind) {
    case "l4Hosts":
      return `${conflict.count} enabled L4 proxy host${conflict.count === 1 ? " needs" : "s need"} the Layer 4 Proxy module`;
    case "globalWaf":
      return "global WAF is switched on and needs the Coraza WAF module";
    case "globalGeoblock":
      return "global geoblocking is switched on and needs the Request Blocker module";
    case "globalCrowdsec":
      return "CrowdSec is switched on and needs the CrowdSec module";
    case "hostWaf":
      return `${conflict.count} proxy host${conflict.count === 1 ? " has" : "s have"} per-host WAF enabled and ${conflict.count === 1 ? "needs" : "need"} the Coraza WAF module`;
    case "hostGeoblock":
      return `${conflict.count} proxy host${conflict.count === 1 ? " has" : "s have"} per-host geoblocking enabled and ${conflict.count === 1 ? "needs" : "need"} the Request Blocker module`;
    case "tailnetHosts":
      return `${conflict.count} proxy host${conflict.count === 1 ? " is" : "s are"} served on the tailnet and ${conflict.count === 1 ? "needs" : "need"} the Tailscale module`;
    case "defaultDnsProvider":
      return `${conflict.provider} is the default DNS provider and needs its caddy-dns module`;
    case "dnsProviderCredentials":
      return `${conflict.provider} has DNS credentials configured and needs its caddy-dns module`;
  }
}

export function englishModuleConflicts(conflicts: readonly ModuleConflict[]): string | null {
  if (conflicts.length === 0) return null;
  return `Cannot disable those modules yet: ${conflicts.map(englishModuleConflict).join("; ")}. Turn the feature off first.`;
}

export async function describeModuleConflicts(
  settings: CaddyBuildSettings,
  agentRowId?: number,
): Promise<string | null> {
  return englishModuleConflicts(await findModuleConflicts(settings, agentRowId));
}

export async function findModuleConflicts(
  settings: CaddyBuildSettings,
  agentRowId?: number,
): Promise<ModuleConflict[]> {
  const enabled = new Set(resolveEnabledModuleIds(settings));
  const problems: ModuleConflict[] = [];

  const l4Off = !enabled.has("caddy-l4");
  const wafOff = !enabled.has("coraza-waf");
  const blockerOff = !enabled.has("caddy-blocker");
  const tailscaleOff = !enabled.has("caddy-tailscale");
  const crowdsecOff = !enabled.has(CROWDSEC_MODULE_ID);

  // Scoped to this agent: a host pinned elsewhere would refuse with a reason nobody can act on.
  const [
    httpAssignments,
    l4Assignments,
    l4HostIds,
    waf,
    geoblock,
    allHosts,
    dnsProviders,
    crowdsec,
  ] = await Promise.all([
    agentRowId === undefined ? null : listHostAssignments("http"),
    agentRowId === undefined ? null : listHostAssignments("l4"),
    l4Off ? listEnabledL4ProxyHostIds() : null,
    wafOff ? getWafSettings() : null,
    blockerOff ? getGeoBlockSettings() : null,
    wafOff || blockerOff || tailscaleOff ? listProxyHosts() : null,
    getDnsProviderSettings(),
    crowdsecOff ? getCrowdSecSettings() : null,
  ]);
  const servesHttp = (hostId: number) =>
    httpAssignments === null || servedByAgent(httpAssignments, hostId, agentRowId ?? null);
  const servesL4 = (hostId: number) =>
    l4Assignments === null || servedByAgent(l4Assignments, hostId, agentRowId ?? null);

  if (l4HostIds) {
    const l4Count = l4HostIds.filter(servesL4).length;
    if (l4Count > 0) problems.push({ kind: "l4Hosts", count: l4Count });
  }

  if (waf?.enabled && waf.mode !== "Off") {
    problems.push({ kind: "globalWaf" });
  }

  if (geoblock?.enabled) {
    problems.push({ kind: "globalGeoblock" });
  }

  // Refused rather than warned: every host would quietly stop checking decisions.
  if (crowdsec?.enabled) {
    problems.push({ kind: "globalCrowdsec" });
  }

  // WAF and geoblocking can be on per host with the global switch off.
  if (allHosts) {
    const hosts = allHosts.filter((host) => servesHttp(host.id));
    if (wafOff) {
      const count = hosts.filter((h) => h.enabled && h.waf?.enabled).length;
      if (count > 0) problems.push({ kind: "hostWaf", count });
    }
    if (blockerOff) {
      const count = hosts.filter((h) => h.enabled && h.geoblock?.enabled).length;
      if (count > 0) problems.push({ kind: "hostGeoblock", count });
    }
    if (tailscaleOff) {
      // Refused, not warned: the config would silently drop a tailnet-only host.
      const count = hosts.filter((h) => h.enabled && h.tailscale?.serve).length;
      if (count > 0) problems.push({ kind: "tailnetHosts", count });
    }
  }

  // Not just the default: a certificate can pin its own provider.
  const defaultProvider = dnsProviders?.default ?? null;
  for (const provider of Object.keys(dnsProviders?.providers ?? {})) {
    if (enabled.has(dnsModuleId(provider))) continue;
    problems.push({
      kind: provider === defaultProvider ? "defaultDnsProvider" : "dnsProviderCredentials",
      provider,
    });
  }

  return problems;
}

export type CaddyfileSnippetWarning = {
  count: number;
  /** The first few, by name. */
  names: string[];
  /** How many beyond `names`. */
  more: number;
};

/** Warns, not refuses: only Caddy's adapter knows which plugin a snippet needs. */
export async function describeCaddyfileSnippetWarning(
  settings: CaddyBuildSettings,
): Promise<CaddyfileSnippetWarning | null> {
  const enabled = new Set(resolveEnabledModuleIds(settings));
  const anyDisabled = CADDY_MODULES.some((m) => !enabled.has(m.id));
  if (!anyDisabled) return null;

  const hosts = await listProxyHosts();
  const withSnippets = hosts.filter((h) => h.enabled && h.customCaddyfile?.trim());
  if (withSnippets.length === 0) return null;

  const names = withSnippets.slice(0, 3).map((h) => h.name);
  return { count: withSnippets.length, names, more: withSnippets.length - names.length };
}
