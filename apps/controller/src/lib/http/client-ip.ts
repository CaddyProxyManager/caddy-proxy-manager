import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getIPFromHeader, isValidIP, normalizeIP } from "@better-auth/core/utils/ip";
import { expandPrivateRanges } from "../caddy/utils";
import { config } from "../config";
import { PEER_ADDRESS_HEADER, isPeerAddressStamped } from "./peer-address";
import { lastHeaderValue } from "./request-headers";

/** better-auth's rate limiter reads the address from this alone. */
export const CLIENT_IP_HEADER = "x-cpm-client-ip";

const LOOPBACK = ["127.0.0.0/8", "::1/128"];
const TRUSTED_CACHE_MS = 30_000;
let trustedCache: { at: number; ranges: string[] } | null = null;

/** The admin URL's `caddy-admin` alias is another network; requests come from this name. */
const CADDY_SERVICE_NAME = "caddy";

/** Loopback, the administered Caddy, and Settings -> Trusted Proxies. */
async function trustedProxies(): Promise<string[]> {
  if (trustedCache && Date.now() - trustedCache.at < TRUSTED_CACHE_MS) return trustedCache.ranges;

  const ranges = [...LOOPBACK];
  let adminHost = "";
  try {
    adminHost = new URL(config.caddyApiUrl).hostname.replace(/^\[|\]$/g, "");
  } catch {
    // An unparseable admin URL vouches for nobody.
  }
  for (const host of new Set([adminHost, CADDY_SERVICE_NAME])) {
    if (!host) continue;
    if (isIP(host)) {
      ranges.push(host);
      continue;
    }
    try {
      ranges.push(...(await lookup(host, { all: true })).map((a) => a.address));
    } catch {
      // Not resolvable from here: only the configured ranges vouch for anyone.
    }
  }
  try {
    // Lazily, so reading headers never drags in the database.
    const { getTrustedProxiesSettings } = await import("../settings");
    ranges.push(...expandPrivateRanges((await getTrustedProxiesSettings())?.ranges ?? []));
  } catch {
    // The peer address is never worse than trusting a header.
  }

  trustedCache = { at: Date.now(), ranges };
  return ranges;
}

/**
 * For rate limiting. X-Forwarded-For counts only from a trusted peer, walked right to left as
 * better-auth does; X-Real-IP never, since nothing in the stack sets or strips it.
 */
export async function getClientIp(headers: Headers, trusted?: string[]): Promise<string | null> {
  const forwardedFor = headers.get("x-forwarded-for");

  if (!isPeerAddressStamped()) {
    // No socket address under `vite dev`/`vinext start`: the hop the nearest proxy appended is the best
    // left, and a client reaching the port directly can forge it - the per-account limit still holds.
    const last = lastHeaderValue(forwardedFor);
    return isValidIP(last) ? normalizeIP(last) : null;
  }

  const peer = headers.get(PEER_ADDRESS_HEADER)?.trim() ?? "";
  if (!isValidIP(peer)) return null;

  const ranges = trusted ?? (await trustedProxies());
  // Null exactly when the lone address is itself trusted.
  const peerIsTrusted = getIPFromHeader(peer, { trustedProxies: ranges }) === null;
  if (!peerIsTrusted || !forwardedFor) return normalizeIP(peer);
  return getIPFromHeader(forwardedFor, { trustedProxies: ranges }) ?? normalizeIP(peer);
}
