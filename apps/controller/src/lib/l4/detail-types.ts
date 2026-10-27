/** An L4 host's page data, as the server hands it over. Client safe. */

import type { L4TrafficReport } from "../clickhouse/l4-traffic";
import type { L4ProxyHost } from "../models/l4-proxy-hosts";
import type { ProxyHostHeaderInfo } from "../proxy-hosts/header";
import type { L4SectionSummary } from "./section-summary";

export type L4HealthChecks = {
  active: { port: number | null; interval: string | null } | null;
  passive: { maxFails: number | null; failDuration: string | null } | null;
};

/** `off`: L4 connection logging or analytics is off, so nothing is recorded. */
export type L4HostTraffic =
  | { state: "off" }
  | {
      state: "on";
      report: L4TrafficReport;
      /** Enabled hosts on the same protocol and a port of this one's, which share its numbers. */
      sharedWith: number;
    };

export type L4HostDetail = {
  host: L4ProxyHost;
  sections: L4SectionSummary[];
  healthChecks: L4HealthChecks;
  traffic: L4HostTraffic;
};

export function l4HealthChecksOf(host: Pick<L4ProxyHost, "loadBalancer">): L4HealthChecks {
  const lb = host.loadBalancer;
  const active = lb?.enabled && lb.activeHealthCheck?.enabled ? lb.activeHealthCheck : null;
  const passive = lb?.enabled && lb.passiveHealthCheck?.enabled ? lb.passiveHealthCheck : null;
  return {
    active: active ? { port: active.port, interval: active.interval } : null,
    passive: passive ? { maxFails: passive.maxFails, failDuration: passive.failDuration } : null,
  };
}

/** The proxy host's header, with the listen address where the domains go. */
export function l4HostHeader(
  host: Pick<L4ProxyHost, "name" | "protocol" | "listenAddress" | "tags" | "enabled">,
): ProxyHostHeaderInfo {
  return {
    name: host.name,
    domains: [`${host.protocol.toUpperCase()} ${host.listenAddress}`],
    tags: host.tags,
    status: host.enabled ? null : { state: "disabled", problem: null },
    analyticsHref: null,
    logsHref: null,
  };
}
