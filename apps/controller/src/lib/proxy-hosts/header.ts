/**
 * What heads each of a proxy host's pages: its name, status, domains and tags, and the links out to
 * its analytics and logs. The overview reads the status off attention it gathers anyway; the other
 * tabs gather only what this needs.
 */

import { collectAttention } from "../attention";
import { DEFAULT_EXPLORE_STATE, serializeExploreState } from "../analytics/explore-state";
import type { ProxyHost } from "../models/proxy-hosts";
import { type Access, can } from "../users/permissions";
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
  status: HostStatus;
  /** Administrators with analytics on. */
  analyticsHref: string | null;
  /** Administrators only: access logs carry every client's address. */
  logsHref: string | null;
};

export function proxyHostHeaderLinks(
  access: Access,
  host: Pick<ProxyHost, "domains">,
  analyticsOn: boolean,
): Pick<ProxyHostHeaderInfo, "analyticsHref" | "logsHref"> {
  const primaryName = hostTrafficNames(host.domains)[0];
  return {
    analyticsHref:
      analyticsOn && can(access, "analytics:read") && primaryName
        ? `/analytics?${serializeExploreState({
            ...DEFAULT_EXPLORE_STATE,
            filters: [{ field: "host", op: "is", value: primaryName }],
          }).toString()}`
        : null,
    logsHref:
      can(access, "logs:read") && primaryName
        ? `/logs?source=access&host=${encodeURIComponent(primaryName)}`
        : null,
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
