/**
 * Probes like an HTTP-01 check, for a token only this deployment serves - a router's login page
 * answers 200 too. It runs from the controller, so split-horizon DNS or missing hairpin NAT can
 * differ from the internet's view; the UI offers Let's Debug for that.
 */
import { createHmac } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { derivePurposeKey } from "../secrets/derived-key";

export const REACHABILITY_PATH = "/.well-known/cpm-reachability";
const TIMEOUT_MS = 5000;

/** Not a secret; just ours. */
export function reachabilityToken(): string {
  const mac = createHmac("sha256", derivePurposeKey("reachability-probe:v1"))
    .update("domain-probe")
    .digest("hex")
    .slice(0, 32);
  return `cpm-reachability:${mac}`;
}

export function reachabilityRoute(): Record<string, unknown> {
  return {
    match: [{ path: [REACHABILITY_PATH] }],
    handle: [
      {
        handler: "static_response",
        status_code: 200,
        body: reachabilityToken(),
        headers: { "Content-Type": ["text/plain"], "Cache-Control": ["no-store"] },
      },
    ],
    terminal: true,
  };
}

export type DomainReachability = {
  domain: string;
  addresses: string[];
  caa: string[];
  result: "reached" | "unresolved" | "noAnswer" | "otherServer" | "wildcard";
  /** What answered instead, for `otherServer`. */
  status?: number;
};

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;

export function isCheckableDomain(domain: string): boolean {
  return HOSTNAME.test(domain);
}

async function caaRecords(resolver: Resolver, domain: string): Promise<string[]> {
  // CAA is inherited from the parent names, so walk up until one has records.
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    try {
      const records = await resolver.resolveCaa(labels.slice(i).join("."));
      if (records.length > 0) {
        return records.map((record) => {
          const [tag, value] = Object.entries(record).find(([key]) => key !== "critical") ?? [];
          return `${tag ?? "?"} "${value ?? ""}"`;
        });
      }
    } catch {
      // NODATA or NXDOMAIN at this level; keep walking.
    }
  }
  return [];
}

export async function checkDomainReachability(domain: string): Promise<DomainReachability> {
  const name = domain.trim().toLowerCase();
  if (name.startsWith("*.")) {
    // A wildcard can only be issued over DNS-01.
    return { domain: name, addresses: [], caa: [], result: "wildcard" };
  }
  const resolver = new Resolver({ timeout: TIMEOUT_MS, tries: 2 });
  const [v4, v6, caa] = await Promise.all([
    resolver.resolve4(name).catch(() => [] as string[]),
    resolver.resolve6(name).catch(() => [] as string[]),
    caaRecords(resolver, name),
  ]);
  const addresses = [...v4, ...v6];
  if (addresses.length === 0) return { domain: name, addresses, caa, result: "unresolved" };

  try {
    // outbound: reachability
    const response = await fetch(`http://${name}${REACHABILITY_PATH}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "Cache-Control": "no-cache" },
    });
    const body = (await response.text()).slice(0, 200).trim();
    if (response.status === 200 && body === reachabilityToken()) {
      return { domain: name, addresses, caa, result: "reached" };
    }
    return { domain: name, addresses, caa, result: "otherServer", status: response.status };
  } catch {
    return { domain: name, addresses, caa, result: "noAnswer" };
  }
}
