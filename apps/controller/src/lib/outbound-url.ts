/**
 * Guards for a request the controller sends to an admin-supplied address (acme-dns, a CrowdSec
 * LAPI). Plain http is let through only where TLS is rarely set up, since what goes out carries a
 * credential. Callers map the problem to their own message.
 */

import { isIP } from "node:net";

function ipv4Private(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function ipv6Private(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::1") return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Private(mapped[1]);
  return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

/**
 * Loopback, private and link-local addresses, `localhost`, and single-label names such as a
 * Compose service.
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(host);
  if (family === 4) return ipv4Private(host);
  if (family === 6) return ipv6Private(host);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return !host.includes(".");
}

/**
 * Cloud metadata services, which hand out the instance's own cloud credentials: the classic SSRF
 * target. Nothing CPM talks to lives there, so they are refused outright. Alibaba's sits outside
 * link-local; the rest of the link-local range goes with them.
 */
const METADATA_NAMES = new Set(["metadata.google.internal", "metadata.goog"]);
const METADATA_ADDRESSES = new Set(["100.100.100.200", "fd00:ec2::254"]);

export function isMetadataHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (METADATA_NAMES.has(host) || METADATA_ADDRESSES.has(host)) return true;
  const family = isIP(host);
  if (family === 4) return host.startsWith("169.254.");
  if (family !== 6) return false;
  // URL writes an IPv4-mapped address in hex: ::ffff:169.254.x.y becomes ::ffff:a9fe:xxyy.
  const mapped = host.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):[0-9a-f]{1,4})$/);
  if (mapped) return mapped[1] ? mapped[1].startsWith("169.254.") : mapped[2] === "a9fe";
  return /^fe[89ab]/.test(host);
}

export type OutboundUrlProblem = "invalid" | "https" | "metadata";

/**
 * The URL without its trailing slashes, or why it is refused. Credentials, a query or a fragment
 * are refused rather than dropped: each would be something else than the base a path joins onto.
 */
export function parseOutboundBaseUrl(
  raw: string,
): { url: string; problem?: never } | { url?: never; problem: OutboundUrlProblem } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { problem: "invalid" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { problem: "invalid" };
  if (url.username || url.password || url.search || url.hash) return { problem: "invalid" };
  if (isMetadataHost(url.hostname)) return { problem: "metadata" };
  if (url.protocol === "http:" && !isLocalHost(url.hostname)) return { problem: "https" };
  return { url: url.toString().replace(/\/+$/, "") };
}
