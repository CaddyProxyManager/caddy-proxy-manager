import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { derivePurposeKey } from "./derived-key";

/**
 * Injected by Caddy before proxying a forward-auth request to CPM: forwarded headers alone can be
 * forged by a client reaching the origin directly.
 */
export const FORWARD_AUTH_PROXY_PROOF_HEADER = "X-CPM-Forward-Auth-Proof";

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
    forwardedHost.includes(",") ||
    /[\r\n]/.test(forwardedHost)
  ) {
    return null;
  }

  try {
    const parsed = new URL(`${forwardedProto}://${forwardedHost}`);
    if (parsed.username || parsed.password) return null;
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
