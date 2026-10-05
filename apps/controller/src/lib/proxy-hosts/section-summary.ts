/**
 * One line per editor section for the host page: facts as codes, rendered from
 * `proxyHosts.detail.facts.<code>` and joined there, so no sentence is built here. Client safe.
 */

import type { ProxyHost } from "../models/proxy-hosts";
import { EDITOR_SECTIONS, type EditorSection } from "./editor-sections";
import { hostProtections } from "./protections";

export const SECTION_FACTS = [
  "domains",
  "tags",
  "hstsOn",
  "httpsForced",
  "websocketsOn",
  "upstreams",
  "loadBalancer",
  "activeHealthChecks",
  "passiveHealthChecks",
  "noHealthChecks",
  "customTimeouts",
  "dnsResolver",
  "certificateImported",
  "certificateManaged",
  "mtls",
  "accessList",
  "signInCpm",
  "signInAuthentik",
  "signInForwardAuth",
  "tailnet",
  "openAccess",
  "waf",
  "geo",
  "rateLimit",
  "crowdsec",
  "botChallenge",
  "noProtection",
  "redirects",
  "locationRules",
  "rewrite",
  "pathAllows",
  "pathBlocks",
  "pathRewrites",
  "errorPages",
  "defaultRouting",
  "pinnedAgents",
  "everyAgent",
  "cache",
  "compressionOn",
  "compressionOff",
  "maintenanceOn",
  "customConfig",
] as const;
export type SectionFactCode = (typeof SECTION_FACTS)[number];

export type SectionFact = { code: SectionFactCode; values?: Record<string, string | number> };

export type SectionSummary = { section: EditorSection; facts: SectionFact[] };

type Lookups = {
  certificateName: string | null;
  accessListName: string | null;
  /** Names of the agents the host is pinned to; empty for every agent. */
  agentNames: string[];
  crowdsecActive: boolean;
};

function fact(code: SectionFactCode, values?: SectionFact["values"]): SectionFact {
  return values ? { code, values } : { code };
}

export function sectionSummaries(host: ProxyHost, lookups: Lookups): SectionSummary[] {
  const facts: Record<EditorSection, SectionFact[]> = {
    general: [],
    upstreams: [],
    tls: [],
    access: [],
    protection: [],
    routing: [],
    advanced: [],
  };

  facts.general.push(fact("domains", { count: host.domains.length }));
  if (host.tags.length > 0) facts.general.push(fact("tags", { count: host.tags.length }));
  if (host.allowWebsocket) facts.general.push(fact("websocketsOn"));

  facts.upstreams.push(fact("upstreams", { count: host.upstreams.length }));
  const lb = host.loadBalancer;
  if (lb?.enabled) facts.upstreams.push(fact("loadBalancer", { policy: lb.policy }));
  const active = Boolean(lb?.enabled && lb.activeHealthCheck?.enabled);
  const passive = Boolean(lb?.enabled && lb.passiveHealthCheck?.enabled);
  if (active) facts.upstreams.push(fact("activeHealthChecks"));
  if (passive) facts.upstreams.push(fact("passiveHealthChecks"));
  if (!active && !passive) facts.upstreams.push(fact("noHealthChecks"));
  if (host.upstreamTimeouts && Object.values(host.upstreamTimeouts).some((v) => v)) {
    facts.upstreams.push(fact("customTimeouts"));
  }
  if (host.dnsResolver?.enabled) facts.upstreams.push(fact("dnsResolver"));

  facts.tls.push(
    lookups.certificateName
      ? fact("certificateImported", { name: lookups.certificateName })
      : fact("certificateManaged"),
  );
  if (host.sslForced) facts.tls.push(fact("httpsForced"));
  if (host.hstsEnabled) facts.tls.push(fact("hstsOn"));
  if (host.mtls?.enabled) facts.tls.push(fact("mtls"));

  const protections = hostProtections(host, lookups.crowdsecActive);
  if (lookups.accessListName) {
    facts.access.push(fact("accessList", { name: lookups.accessListName }));
  }
  if (protections.signIn === "cpm") facts.access.push(fact("signInCpm"));
  if (protections.signIn === "authentik") facts.access.push(fact("signInAuthentik"));
  if (protections.signIn === "forwardAuth") facts.access.push(fact("signInForwardAuth"));
  if (host.tailscale?.serve) facts.access.push(fact("tailnet"));
  if (facts.access.length === 0) facts.access.push(fact("openAccess"));

  for (const key of ["waf", "geo", "crowdsec", "botChallenge"] as const) {
    if (protections.active.includes(key)) facts.protection.push(fact(key));
  }
  if (host.rateLimit?.enabled) {
    facts.protection.push(fact("rateLimit", { count: host.rateLimit.zones.length }));
  }
  if (facts.protection.length === 0) facts.protection.push(fact("noProtection"));

  const counted = [
    ["redirects", host.redirects.length],
    ["locationRules", host.locationRules.length],
    ["pathAllows", host.pathAllows.length],
    ["pathBlocks", host.pathBlocks.length],
    ["pathRewrites", host.pathRewrites.length],
    ["errorPages", host.errorPages.length],
  ] as const;
  for (const [code, count] of counted) {
    if (count > 0) facts.routing.push(fact(code, { count }));
  }
  if (host.rewrite) facts.routing.push(fact("rewrite"));
  if (facts.routing.length === 0) facts.routing.push(fact("defaultRouting"));

  facts.advanced.push(
    lookups.agentNames.length > 0
      ? fact("pinnedAgents", { names: lookups.agentNames.join(", ") })
      : fact("everyAgent"),
  );
  if (host.cache) facts.advanced.push(fact("cache"));
  if (host.compression === "on") facts.advanced.push(fact("compressionOn"));
  if (host.compression === "off") facts.advanced.push(fact("compressionOff"));
  if (host.maintenance?.enabled) facts.advanced.push(fact("maintenanceOn"));
  if (host.customCaddyfile || host.customReverseProxyJson || host.customPreHandlersJson) {
    facts.advanced.push(fact("customConfig"));
  }

  return EDITOR_SECTIONS.map((section) => ({ section, facts: facts[section] }));
}
