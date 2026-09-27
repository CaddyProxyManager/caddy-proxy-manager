import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { derivePurposeKey } from "./derived-key";
import { type ForwardAuthAudience, resolveForwardAuthAudience } from "./models/forward-auth";

/**
 * Injected by Caddy before proxying a forward-auth request to CPM: forwarded headers alone can be
 * forged by a client reaching the origin directly.
 */
export const FORWARD_AUTH_PROXY_PROOF_HEADER = "X-CPM-Forward-Auth-Proof";

/**
 * The proxy host whose route sent the subrequest. Caddy picked that route from the raw Host, so the
 * audience must be that host rather than whichever one a re-parsed hostname resolves to.
 */
export const FORWARD_AUTH_PROXY_HOST_ID_HEADER = "X-CPM-Proxy-Host-Id";

/** Set by verify on a 401/403: the portal's `rd` value, already encoded for a query string. */
export const FORWARD_AUTH_PORTAL_TARGET_HEADER = "X-CPM-Portal-Target";

/**
 * LDH labels or a bracketed IPv6 literal, plus a port. Anything else (percent-encoding, non-ASCII,
 * IPv4 shorthand) the URL parser could normalise into a hostname Caddy never matched.
 */
const FORWARDED_HOST_RE =
  /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

// v1 was an HMAC under the raw session secret, which the public /api/health probe also signed with.
const PROOF_CONTEXT = "cpm-forward-auth-proxy-proof:v2";
const LEGACY_PROOF_CONTEXT = "cpm-forward-auth-proxy-proof:v1";

/** Keeps SESSION_SECRET itself out of the Caddy config its readers can see. */
export function getForwardAuthProxyProof(): string {
  return createHmac("sha256", derivePurposeKey("forward-auth-proxy-proof:v2"))
    .update(PROOF_CONTEXT)
    .digest("hex");
}

function hexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

let warnedLegacyProof = false;

function hasValidProxyProof(headers: Headers): boolean {
  const supplied = headers.get(FORWARD_AUTH_PROXY_PROOF_HEADER);
  if (!supplied || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  if (hexEqual(supplied, getForwardAuthProxyProof())) return true;

  // Never accepted, since it may have been harvested through the old probe - but a Caddy still
  // serving a pre-upgrade config would otherwise fail every forward-auth request without a trace.
  if (!warnedLegacyProof) {
    const legacy = createHmac("sha256", config.sessionSecret)
      .update(LEGACY_PROOF_CONTEXT)
      .digest("hex");
    if (hexEqual(supplied, legacy)) {
      warnedLegacyProof = true;
      console.warn(
        "[forward-auth] Caddy sent a proxy proof from an older release; forward auth fails until the Caddy configuration is re-applied.",
      );
    }
  }
  return false;
}

/** No Host fallback: a direct request must never be able to manufacture an audience. */
export function getTrustedForwardAuthOrigin(headers: Headers): string | null {
  if (!hasValidProxyProof(headers)) return null;

  const forwardedProto = headers.get("x-forwarded-proto")?.trim().toLowerCase();
  const forwardedHost = headers.get("x-forwarded-host")?.trim();
  if (
    (forwardedProto !== "http" && forwardedProto !== "https") ||
    !forwardedHost ||
    !FORWARDED_HOST_RE.test(forwardedHost)
  ) {
    return null;
  }

  try {
    const parsed = new URL(`${forwardedProto}://${forwardedHost}`);
    if (parsed.username || parsed.password) return null;
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    // Exactly what Caddy saw, case aside.
    const rawHostname = forwardedHost.startsWith("[")
      ? forwardedHost.slice(0, forwardedHost.indexOf("]") + 1)
      : forwardedHost.replace(/:\d+$/, "");
    if (parsed.hostname !== rawHostname.toLowerCase()) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Escapes all but "/", ":", "?" and "=", which are unambiguous in a query value and stay readable. */
function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/%(?:2F|3A|3F|3D)/g, (escaped) =>
    decodeURIComponent(escaped),
  );
}

/** The portal `rd` for the request Caddy is verifying, query-encoded; null if not a Caddy subrequest. */
export function getForwardAuthPortalTarget(headers: Headers): string | null {
  const origin = getTrustedForwardAuthOrigin(headers);
  if (!origin) return null;
  // Caddy sends the origin-form request URI, which is printable ASCII.
  const uri = headers.get("x-forwarded-uri") ?? "";
  if (!/^\/[\x21-\x7e]*$/.test(uri)) return null;
  return encodeQueryValue(`${origin}${uri}`);
}

/** The proxy-host ID pinned by the generated route, or null. */
export function getTrustedForwardAuthProxyHostId(headers: Headers): number | null {
  if (!hasValidProxyProof(headers)) return null;
  const raw = headers.get(FORWARD_AUTH_PROXY_HOST_ID_HEADER)?.trim() ?? "";
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
  return Number(raw);
}

/** A proof-checked origin that resolves to the very proxy host whose route sent the subrequest. */
export async function resolveTrustedForwardAuthAudience(
  headers: Headers,
): Promise<ForwardAuthAudience | null> {
  const origin = getTrustedForwardAuthOrigin(headers);
  const pinnedProxyHostId = getTrustedForwardAuthProxyHostId(headers);
  if (!origin || pinnedProxyHostId === null) return null;
  const audience = await resolveForwardAuthAudience(origin);
  return audience?.proxyHostId === pinnedProxyHostId ? audience : null;
}
