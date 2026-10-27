/**
 * One line per L4 editor section for the host page, as proxy-hosts/section-summary.ts is for an
 * HTTP host, from the same fact codes and catalog. Client safe.
 */

import type { L4ProxyHost } from "../models/l4-proxy-hosts";
import { type SectionFact, fact } from "../proxy-hosts/section-summary";
import { L4_EDITOR_SECTIONS, type L4EditorSection } from "./editor-sections";

export type L4SectionSummary = { section: L4EditorSection; facts: SectionFact[] };

type Lookups = {
  accessListName: string | null;
  /** Names of the agents the host is pinned to; empty for every agent. */
  agentNames: string[];
  crowdsecActive: boolean;
};

export function l4SectionSummaries(host: L4ProxyHost, lookups: Lookups): L4SectionSummary[] {
  const facts: Record<L4EditorSection, SectionFact[]> = {
    general: [],
    upstreams: [],
    protection: [],
  };

  facts.general.push(
    fact("listen", { protocol: host.protocol.toUpperCase(), address: host.listenAddress }),
  );
  const hostnames = host.matcherValue.join(", ");
  if (host.matcherType === "tls_sni") facts.general.push(fact("matcherSni", { hostnames }));
  if (host.matcherType === "http_host") facts.general.push(fact("matcherHost", { hostnames }));
  if (host.matcherType === "proxy_protocol") facts.general.push(fact("matcherProxyProtocol"));
  if (host.tlsTermination) facts.general.push(fact("tlsTerminated"));
  if (host.proxyProtocolReceive) facts.general.push(fact("proxyProtocolIn"));
  if (host.tags.length > 0) facts.general.push(fact("tags", { count: host.tags.length }));
  facts.general.push(
    lookups.agentNames.length > 0
      ? fact("pinnedAgents", { names: lookups.agentNames.join(", ") })
      : fact("everyAgent"),
  );

  facts.upstreams.push(fact("upstreams", { count: host.upstreams.length }));
  if (host.upstreamPortMode === "same") facts.upstreams.push(fact("samePortUpstreams"));
  if (host.proxyProtocolVersion) {
    facts.upstreams.push(fact("proxyProtocolOut", { version: host.proxyProtocolVersion }));
  }
  const lb = host.loadBalancer;
  if (lb?.enabled) facts.upstreams.push(fact("loadBalancer", { policy: lb.policy }));
  const active = Boolean(lb?.enabled && lb.activeHealthCheck?.enabled);
  const passive = Boolean(lb?.enabled && lb.passiveHealthCheck?.enabled);
  if (active) facts.upstreams.push(fact("activeHealthChecks"));
  if (passive) facts.upstreams.push(fact("passiveHealthChecks"));
  if (!active && !passive) facts.upstreams.push(fact("noHealthChecks"));
  if (host.dnsResolver?.enabled) facts.upstreams.push(fact("dnsResolver"));
  if (host.upstreamDnsResolution?.enabled) facts.upstreams.push(fact("upstreamDnsPinned"));

  if (lookups.accessListName) {
    facts.protection.push(fact("accessList", { name: lookups.accessListName }));
  }
  if (host.geoblock?.enabled) facts.protection.push(fact("geo"));
  if (host.crowdsec && lookups.crowdsecActive) facts.protection.push(fact("crowdsec"));
  if (facts.protection.length === 0) facts.protection.push(fact("noProtection"));

  return L4_EDITOR_SECTIONS.map((section) => ({ section, facts: facts[section] }));
}
