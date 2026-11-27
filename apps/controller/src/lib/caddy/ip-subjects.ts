import { BlockList, isIP } from "node:net";

/** Ranges no public CA will validate: private, loopback, link-local, CGNAT, reserved. */
const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
  ["2001:db8::", 32],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv6");
}

export function isIpSubject(subject: string): boolean {
  return isIP(subject) !== 0;
}

export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NON_PUBLIC.check(address, "ipv4");
  if (family !== 6) return false;
  // BlockList does not look through an IPv4-mapped address on its own.
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIp(mapped[1]);
  return !NON_PUBLIC.check(address, "ipv6");
}

/**
 * Policies for IP subjects. DNS-01 cannot prove an address, and only a public one can pass
 * HTTP-01, so a private one goes straight to Caddy's local CA. A public one tries ACME first
 * (Let's Encrypt issues IP certificates on its short-lived profile only) and falls back to it.
 */
export function buildIpAutomationPolicies(
  subjects: string[],
  acmeIssuer: (options: { ipProfile: boolean }) => Record<string, unknown>,
  customCa: boolean,
): Record<string, unknown>[] {
  const internal = { module: "internal" };
  const publicIps = subjects.filter(isPublicIp);
  const privateIps = subjects.filter((subject) => !isPublicIp(subject));
  const policies: Record<string, unknown>[] = [];
  if (publicIps.length > 0) {
    policies.push({
      subjects: publicIps,
      issuers: [acmeIssuer({ ipProfile: !customCa }), internal],
    });
  }
  if (privateIps.length > 0) {
    policies.push({ subjects: privateIps, issuers: [internal] });
  }
  return policies;
}

/**
 * Clients send no SNI for an IP address (RFC 6066), so no `sni: [ip]` policy ever matches one.
 * Caddy matches an empty SNI against "", and `default_sni` picks the certificate when the local
 * address does not - it never does behind Docker's NAT.
 */
export function noSniPolicyForIpHosts<T extends { match?: { sni?: string[] } }>(
  policies: T[],
): (Omit<T, "match"> & { match: { sni: string[] }; default_sni: string }) | null {
  for (const policy of policies) {
    const ip = policy.match?.sni?.find(isIpSubject);
    if (ip) return { ...policy, match: { sni: [""] }, default_sni: ip };
  }
  return null;
}
