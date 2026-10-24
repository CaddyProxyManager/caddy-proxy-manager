/** The `dynamic_dns` app. Split from dynamic-dns.ts because credentials decrypt with node:crypto. */

import type { DynamicDnsRecordSet, DynamicDnsSettings } from "./dynamic-dns";
import { buildDnsProviderConfig } from "./provider-credentials";

export type DynamicDnsTarget = {
  /** The agent this document is for; null for the direct transport. */
  agentId: string | null;
  /** Where a set without an agent goes: the bundled agent, else the direct transport. */
  bundledAgentId: string | null;
};

/**
 * Only this Caddy's sets, each on exactly one: two agents updating one name would flip it between
 * their addresses on every check.
 */
export function recordSetsFor(
  settings: DynamicDnsSettings,
  target: DynamicDnsTarget,
): DynamicDnsRecordSet[] {
  return settings.recordSets.filter(
    (set) => (set.agentId ?? target.bundledAgentId) === target.agentId,
  );
}

/**
 * `app` is null when there is nothing for this Caddy to update. A set whose provider has no credentials
 * or no compiled-in module is skipped, so one stale set does not fail the whole config.
 */
export function buildDynamicDnsApp(
  settings: DynamicDnsSettings,
  options: DynamicDnsTarget & {
    providerCredentials: Record<string, Record<string, string>>;
    isProviderUsable: (provider: string) => boolean;
  },
): { app: Record<string, unknown> | null; skipped: DynamicDnsRecordSet[] } {
  if (!settings.enabled) return { app: null, skipped: [] };

  const byProvider = new Map<string, Record<string, string[]>>();
  const skipped: DynamicDnsRecordSet[] = [];
  for (const set of recordSetsFor(settings, options)) {
    if (!options.providerCredentials[set.provider] || !options.isProviderUsable(set.provider)) {
      skipped.push(set);
      continue;
    }
    const domains = byProvider.get(set.provider) ?? {};
    domains[set.zone] = [...new Set([...(domains[set.zone] ?? []), ...set.names])];
    byProvider.set(set.provider, domains);
  }

  const providers = [...byProvider].flatMap(([provider, domains]) => {
    const dnsProvider = buildDnsProviderConfig(provider, options.providerCredentials[provider]);
    return dnsProvider ? [{ dns_provider: dnsProvider, domains }] : [];
  });
  if (providers.length === 0) return { app: null, skipped };

  const app: Record<string, unknown> = {
    providers,
    versions: { ipv4: settings.ipv4, ipv6: settings.ipv6 },
    check_interval: settings.checkInterval,
  };
  if (settings.ttl) app.ttl = settings.ttl;
  if (settings.updateOnly) app.update_only = true;
  if (settings.ipEndpoints.length > 0) {
    app.ip_sources = [{ source: "simple_http", endpoints: settings.ipEndpoints }];
  }
  return { app, skipped };
}
