/**
 * Claim resolution for OIDC providers driving group-based roles. better-auth's `getUserInfo` stops
 * once the ID token has `sub` and `email`, so groups exposed only on userinfo never surface - with
 * group mapping on we read the ID token and fall back to userinfo.
 */

import { readClaim } from "./groups";
import { isMetadataHost } from "../../http/outbound-url";

export type OidcTokens = {
  idToken?: string | null;
  accessToken?: string | null;
};

export type ClaimSourceConfig = {
  issuer: string | null;
  userinfoUrl: string | null;
};

/** Discovery documents change rarely; cache them briefly to avoid a fetch per sign-in. */
const DISCOVERY_TTL_MS = 10 * 60 * 1000;

/** The endpoints read out of a discovery document. Absent ones stay null and are cached as such. */
export type DiscoveredEndpoints = {
  userinfoUrl: string | null;
  jwksUri: string | null;
};

const discoveryCache = new Map<string, { endpoints: DiscoveredEndpoints; expiresAt: number }>();

/** Exposed for tests - discovery results are process-wide state. */
export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}

/** Decodes a JWT payload without verifying it. */
export function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// The issuer is admin-configured, so these are bounds rather than a guard: a provider that hangs or
// streams forever must not hold a sign-in open. The global fetch stays, since the issuer may well be
// a private address the outbound client's checks are not written for.
const DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_DOCUMENT_BYTES = 256 * 1024;

/** The body, with a declared length capped: a discovery document or userinfo is a few kilobytes. */
async function readJsonDocument(response: Response): Promise<unknown> {
  const declared = Number(response.headers?.get?.("content-length") ?? 0);
  if (declared > MAX_DOCUMENT_BYTES) throw new Error("response too large");
  return response.json() as Promise<unknown>;
}

function pointsAtMetadataHost(url: string): boolean {
  try {
    return isMetadataHost(new URL(url).hostname);
  } catch {
    return true;
  }
}

/** Decoded, never verified - it came over the back-channel exchange, as better-auth trusts it. */
async function discover(issuer: string): Promise<DiscoveredEndpoints> {
  const discoveryUrl = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const cached = discoveryCache.get(discoveryUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.endpoints;

  const endpoints: DiscoveredEndpoints = { userinfoUrl: null, jwksUri: null };
  try {
    // outbound: oidcProvider
    const response = await fetch(discoveryUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (response.ok) {
      const doc = (await readJsonDocument(response)) as Record<string, unknown>;
      const userinfo = doc.userinfo_endpoint;
      if (typeof userinfo === "string" && userinfo) endpoints.userinfoUrl = userinfo;
      // The JWKS is fetched by jose, outside the guarded client, so the one check that matters
      // for a discovered address is made here.
      const jwks = doc.jwks_uri;
      if (typeof jwks === "string" && jwks && !pointsAtMetadataHost(jwks)) endpoints.jwksUri = jwks;
    }
  } catch (error) {
    console.warn("[oidc-claims] OIDC discovery failed for", discoveryUrl, error);
  }

  discoveryCache.set(discoveryUrl, { endpoints, expiresAt: Date.now() + DISCOVERY_TTL_MS });
  return endpoints;
}

export async function resolveUserinfoUrl(cfg: ClaimSourceConfig): Promise<string | null> {
  if (cfg.userinfoUrl) return cfg.userinfoUrl;
  if (cfg.issuer) return (await discover(cfg.issuer)).userinfoUrl;
  return null;
}

/**
 * Where to fetch the issuer's signing keys. Discovery only - unlike userinfo there is no column to
 * configure it by hand, because a provider that cannot be discovered cannot sign a logout token
 * this app is able to verify either.
 */
export async function resolveJwksUri(issuer: string | null): Promise<string | null> {
  if (!issuer) return null;
  return (await discover(issuer)).jwksUri;
}

async function fetchUserinfoClaims(
  cfg: ClaimSourceConfig,
  accessToken: string,
): Promise<Record<string, unknown> | null> {
  const url = await resolveUserinfoUrl(cfg);
  if (!url) return null;
  try {
    // outbound: oidcProvider
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[oidc-claims] userinfo request failed with status ${response.status}`);
      return null;
    }
    const body: unknown = await readJsonDocument(response);
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch (error) {
    console.warn("[oidc-claims] userinfo request failed:", error);
    return null;
  }
}

/**
 * The full claim set for a sign-in: ID token claims, plus userinfo when the group claim is absent.
 * userinfo wins on conflict, being the fresher profile.
 */
export async function fetchOidcClaims(
  cfg: ClaimSourceConfig,
  tokens: OidcTokens,
  claimPaths: string | readonly string[],
): Promise<Record<string, unknown> | null> {
  const idTokenClaims = decodeJwtPayload(tokens.idToken) ?? {};
  let claims: Record<string, unknown> = { ...idTokenClaims };

  const paths = typeof claimPaths === "string" ? [claimPaths] : claimPaths;
  const hasClaims = paths.every((path) => readClaim(claims, path) !== undefined);
  const needsUserinfo = !hasClaims || !claims.sub || !claims.email;
  if (needsUserinfo && tokens.accessToken) {
    const userinfo = await fetchUserinfoClaims(cfg, tokens.accessToken);
    if (userinfo) claims = { ...claims, ...userinfo };
  }

  if (!claims.sub || typeof claims.email !== "string") return null;
  return claims;
}

/** Shapes claims for better-auth's generic-OAuth plugin, keeping the raw claims alongside. */
export function toOAuthUserInfo(claims: Record<string, unknown>): Record<string, unknown> {
  return {
    ...claims,
    id: String(claims.sub),
    email: claims.email,
    emailVerified: claims.email_verified === true,
    image: typeof claims.picture === "string" ? claims.picture : undefined,
    name:
      typeof claims.name === "string"
        ? claims.name
        : typeof claims.preferred_username === "string"
          ? claims.preferred_username
          : undefined,
  };
}
