/**
 * Proves a domain reaches *this* instance by requesting it - no third-party IP echo - and
 * checking an HMAC of the nonce, since any server can echo one. Split-horizon DNS can pass yet
 * fail ACME, and a missing NAT hairpin can fail while the world gets through; the toggle is only
 * a default.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { derivePurposeKey } from "../secrets/derived-key";

/** Path the probe asks for. Public, and already exempt from authentication in `proxy.ts`. */
export const PROBE_PATH = "/api/health";

export const PROBE_PARAM = "probe";

/**
 * Bounded so the endpoint cannot be turned into a signing oracle for arbitrary long inputs, and
 * so a nonce is unmistakably a nonce.
 */
export const MAX_NONCE_LENGTH = 64;

/** The signature this instance answers a nonce with, under a key no other HMAC here uses. */
export function signProbe(nonce: string): string {
  return createHmac("sha256", derivePurposeKey("reachability-probe:v1"))
    .update(nonce)
    .digest("hex");
}

export function createProbeNonce(): string {
  return randomBytes(16).toString("hex");
}

/** Constant-time, so a wrong answer cannot be walked towards a right one. */
export function probeSignatureMatches(nonce: string, answer: string): boolean {
  const expected = Buffer.from(signProbe(nonce), "utf8");
  const received = Buffer.from(answer, "utf8");
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
