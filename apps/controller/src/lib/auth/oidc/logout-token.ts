/**
 * OIDC Back-Channel Logout token validation (Back-Channel Logout 1.0, §2.4). No browser or cookie,
 * so the signature alone vouches and every check is load-bearing. Returns a reason rather than
 * throwing, so the 400 says which check failed.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { resolveJwksUri } from "./claims";

const BACKCHANNEL_LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";

/** Clock slack for `iat`: the token is delivered immediately. */
const MAX_TOKEN_AGE_SECONDS = 5 * 60;

export type LogoutTokenClaims = {
  issuer: string;
  /** Absent when the token identifies a session and not a user. */
  subject: string | null;
  /** Absent when the token identifies a user and not one session. */
  sessionId: string | null;
  jti: string;
};

export type LogoutTokenResult =
  | { ok: true; claims: LogoutTokenClaims }
  | { ok: false; reason: string };

/** `jose` caches per set, so one set per URI keeps that cache alive across requests. */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** For tests: process-wide state. */
export function clearJwksCache(): void {
  jwksCache.clear();
}

function jwksFor(uri: string): ReturnType<typeof createRemoteJWKSet> {
  let set = jwksCache.get(uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(uri));
    jwksCache.set(uri, set);
  }
  return set;
}

function hasLogoutEvent(events: unknown): boolean {
  // Only the key is checked: providers vary on the value.
  if (!events || typeof events !== "object" || Array.isArray(events)) return false;
  return Object.hasOwn(events as Record<string, unknown>, BACKCHANNEL_LOGOUT_EVENT);
}

/** `issuer` and `clientId` come from the provider row, never from the token itself. */
export async function verifyLogoutToken(
  token: string,
  provider: { issuer: string | null; clientId: string },
): Promise<LogoutTokenResult> {
  if (!token) return { ok: false, reason: "no logout_token was supplied" };
  if (!provider.issuer) return { ok: false, reason: "the provider has no issuer configured" };

  const jwksUri = await resolveJwksUri(provider.issuer);
  if (!jwksUri) {
    return { ok: false, reason: "the provider's discovery document exposes no jwks_uri" };
  }

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, jwksFor(jwksUri), {
      // Exact string equality (OIDC Core §2): Authentik and others end `iss` with a slash.
      issuer: provider.issuer,
      audience: provider.clientId,
      maxTokenAge: MAX_TOKEN_AGE_SECONDS,
      // Asymmetric only, so a token cannot downgrade to a MAC over a shared secret.
      algorithms: ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512"],
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    return { ok: false, reason: `signature or claim check failed: ${describe(error)}` };
  }

  // §2.6: a nonce means an ID token being replayed as a logout token.
  if (payload.nonce !== undefined) {
    return { ok: false, reason: "a logout token must not carry a nonce" };
  }

  if (!hasLogoutEvent(payload.events)) {
    return { ok: false, reason: "the events claim does not name a back-channel logout" };
  }

  if (typeof payload.iat !== "number") {
    return { ok: false, reason: "the token has no iat" };
  }

  const subject = typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  const sessionId = typeof payload.sid === "string" && payload.sid ? payload.sid : null;
  if (!subject && !sessionId) {
    return { ok: false, reason: "the token identifies neither a subject nor a session" };
  }

  const jti = typeof payload.jti === "string" && payload.jti ? payload.jti : null;
  if (!jti) return { ok: false, reason: "the token has no jti" };

  return {
    ok: true,
    claims: { issuer: provider.issuer, subject, sessionId, jti },
  };
}

/**
 * Replay protection (§2.6): a `jti` once per issuer while its token could verify. In memory: a
 * replayed logout grants nothing, so a second instance's own set costs a duplicate revocation.
 */
const seenJtis = new Map<string, number>();

export function rememberLogoutJti(issuer: string, jti: string): boolean {
  const now = Date.now();
  for (const [key, expiresAt] of seenJtis) {
    if (expiresAt <= now) seenJtis.delete(key);
  }
  const key = `${issuer}\u0000${jti}`;
  if (seenJtis.has(key)) return false;
  seenJtis.set(key, now + MAX_TOKEN_AGE_SECONDS * 1000);
  return true;
}

/** For tests: process-wide state. */
export function clearLogoutJtis(): void {
  seenJtis.clear();
}

function describe(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.message : "unknown error";
}
