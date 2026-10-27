/**
 * What heads each of a proxy host's pages: its name, status, domains and tags, and whether it has
 * Analytics and Logs tabs. The overview reads the status off attention it gathers anyway; the other
 * tabs gather only what this needs.
 */

import { collectAttention } from "../attention";
import type { ProxyHost } from "../models/proxy-hosts";
import { type Access, can } from "../users/permissions";
import { proxyHostAnalyticsHref, proxyHostLogsHref } from "./editor-sections";
import {
  type HostStatus,
  hostStatus,
  hostTrafficNames,
  problemsFromAttention,
} from "./traffic-status";

export type ProxyHostHeaderInfo = {
  name: string;
  domains: string[];
  tags: string[];
  /** Null where nothing is known but that the host is on: an L4 host has no traffic signals. */
  status: HostStatus | null;
  /** Administrators with analytics on. */
  analyticsHref: string | null;
  /** Administrators only: access logs carry every client's address. */
  logsHref: string | null;
};

export function proxyHostHeaderLinks(
  access: Access,
  host: Pick<ProxyHost, "domains" | "uuid">,
  analyticsOn: boolean,
): Pick<ProxyHostHeaderInfo, "analyticsHref" | "logsHref"> {
  // Only wildcards leaves nothing to lock the tabs to, and an empty lock would be every host.
  const named = hostTrafficNames(host.domains).length > 0;
  return {
    analyticsHref:
      analyticsOn && can(access, "analytics:read") && named
        ? proxyHostAnalyticsHref(host.uuid)
        : null,
    logsHref: can(access, "logs:read") && named ? proxyHostLogsHref(host.uuid) : null,
  };
}

export async function loadProxyHostHeader(
  host: ProxyHost,
  access: Access,
): Promise<ProxyHostHeaderInfo> {
  const { isAnalyticsEnabled } = await import("../clickhouse/client");
  const [attention, analyticsOn] = await Promise.all([
    collectAttention(access, { proxyHostId: host.id, now: Date.now() }).catch(() => null),
    isAnalyticsEnabled().catch(() => false),
  ]);
  return {
    name: host.name,
    domains: host.domains,
    tags: host.tags,
    status: hostStatus(host, attention ? problemsFromAttention(attention.items) : []),
    ...proxyHostHeaderLinks(access, host, analyticsOn),
  };
}
