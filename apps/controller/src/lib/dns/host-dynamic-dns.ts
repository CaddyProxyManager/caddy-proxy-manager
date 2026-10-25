/** A host's dynamic DNS as it is saved: its provider checked and its zone found. */

import { Resolver } from "node:dns/promises";
import { domainError } from "../errors/domain-error";
import { getDnsProviderSettings } from "../settings";
import { type HostDynamicDnsConfig, hostRecordNames } from "./dynamic-dns";

const ZONE_LOOKUP_TIMEOUT_MS = 3000;

/**
 * The zone holding a name: the nearest enclosing name with an SOA record, as an ACME client finds
 * one. Null when none answers, which includes a name nobody delegated yet.
 */
export async function findDnsZone(
  hostname: string,
  resolveSoa: (name: string) => Promise<unknown> = (name) =>
    new Resolver({ timeout: ZONE_LOOKUP_TIMEOUT_MS, tries: 1 }).resolveSoa(name),
): Promise<string | null> {
  const labels = hostname.replace(/^\*\./, "").split(".");
  // A bare TLD is never the zone a person can write to.
  for (let start = 0; start < labels.length - 1; start++) {
    const candidate = labels.slice(start).join(".");
    try {
      await resolveSoa(candidate);
      return candidate;
    } catch {
      // ENODATA: a name inside the zone, so try its parent.
    }
  }
  return null;
}

/**
 * Throws a DomainError when a switched-on config cannot work: no provider credentials, no names,
 * a zone DNS does not know, or a name outside the zone. Off, it is stored as it came.
 */
export async function completeHostDynamicDns(
  config: HostDynamicDnsConfig,
  hostnames: readonly string[],
): Promise<HostDynamicDnsConfig> {
  if (!config.enabled) return config;

  const dnsProviders = await getDnsProviderSettings();
  const provider = config.provider ?? dnsProviders?.default ?? null;
  if (!provider) throw domainError("dynamicDnsNoDefaultProvider", {}, { status: 400 });
  if (!dnsProviders?.providers[provider]) {
    throw domainError("dynamicDnsProviderNotConfigured", { provider }, { status: 400 });
  }

  if (hostnames.length === 0) throw domainError("dynamicDnsHostnamesRequired", {}, { status: 400 });
  const zone = config.zone || (await findDnsZone(hostnames[0]));
  if (!zone) {
    throw domainError("dynamicDnsZoneNotFound", { hostname: hostnames[0] }, { status: 400 });
  }
  hostRecordNames(hostnames, zone);
  return { ...config, zone };
}

/** Selects the Dynamic DNS module and has the agents build it, as switching it on in Settings does. */
export async function selectDynamicDnsModule(): Promise<void> {
  // Lazy: the image build reads the host models, which import this module.
  const { ensureDynamicDnsModule } = await import("../caddy/image-build");
  if (!(await ensureDynamicDnsModule())) return;
  const { pushDesiredState } = await import("../agent/desired-state");
  await pushDesiredState();
}
