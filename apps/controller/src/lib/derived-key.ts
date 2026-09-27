import { hkdfSync } from "node:crypto";
import { config } from "./config";

/**
 * An independent key per purpose, derived from SESSION_SECRET, so a value one feature signs can
 * never pass another's check - the public probe once answered with the forward-auth proof.
 */
export type KeyPurpose =
  | "secret:v1"
  | "reachability-probe:v1"
  | "forward-auth-proxy-proof:v2"
  | "captcha-pass:v1"
  | "portal-2fa:v1";

const derived = new Map<KeyPurpose, { secret: string; key: Buffer }>();

/** `secret` is only ever another deployment's, for the migration importer reading its database. */
export function derivePurposeKey(purpose: KeyPurpose, secret = config.sessionSecret): Buffer {
  const cached = derived.get(purpose);
  if (cached?.secret === secret) return cached.key;
  const key = Buffer.from(
    hkdfSync("sha256", secret, Buffer.alloc(0), `caddy-proxy-manager:${purpose}`, 32),
  );
  derived.set(purpose, { secret, key });
  return key;
}
