import type { L4ProxyHost } from "../models/l4-proxy-hosts";
import type { ProxyHost } from "../models/proxy-hosts";

/**
 * What "Duplicate" prefills the create editor with. Domains are left for the operator to enter,
 * since two hosts cannot serve the same ones, and a secret stored on the host is not carried
 * into a new one. Anything shared by reference (certificate, access list, mTLS roles) stays.
 */
export function duplicateProxyHostDraft(host: ProxyHost): ProxyHost {
  return {
    ...host,
    domains: [],
    loadBalancer: host.loadBalancer ? { ...host.loadBalancer, policyCookieSecret: null } : null,
  };
}

/** An L4 host's hostnames are its domains: the matcher type stays, its names do not. */
export function duplicateL4ProxyHostDraft(host: L4ProxyHost): L4ProxyHost {
  return { ...host, matcherValue: [] };
}
