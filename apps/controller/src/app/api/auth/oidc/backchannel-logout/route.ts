/**
 * OIDC Back-Channel Logout 1.0: register https://<cpm>/api/auth/oidc/backchannel-logout as the
 * IdP's `backchannel_logout_uri`. One URL serves every provider - the token's issuer selects it.
 * No CSRF or same-origin check: the caller is the IdP's server, and the signed token is the
 * whole of the authentication.
 */

import { type NextRequest, NextResponse } from "next/server";
import { listEnabledOAuthProviders } from "@/src/lib/models/oauth-providers";
import { decodeJwtPayload } from "@/src/lib/auth/oidc/claims";
import { rememberLogoutJti, verifyLogoutToken } from "@/src/lib/auth/oidc/logout-token";
import { revokeSessionsForLogoutToken } from "@/src/lib/services/oidc-logout";

export const dynamic = "force-dynamic";

/** §2.8 requires `no-store` on both the success and the error response. */
const NO_STORE = { "Cache-Control": "no-store" } as const;

function ok(): NextResponse {
  return new NextResponse(null, { status: 200, headers: NO_STORE });
}

/**
 * §2.8: a 400 with JSON `error`/`error_description`. The description names the failed check,
 * or every misconfiguration of a provider nobody can debug from here would look identical.
 */
function bad(description: string): NextResponse {
  return NextResponse.json(
    { error: "invalid_request", error_description: description },
    { status: 400, headers: NO_STORE },
  );
}

/**
 * Exact equality, as `jwtVerify` compares (a trailing slash is part of an issuer). A lenient
 * match here would surface a mistyped issuer as a JOSE error code a few lines later.
 */
function issuedBy(provider: { issuer: string | null }, claimedIssuer: string): boolean {
  return provider.issuer === claimedIssuer;
}

export async function POST(request: NextRequest) {
  // The spec posts a form, not JSON. Anything else is a misconfigured provider rather than a
  // caller worth guessing for.
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return bad("expected an application/x-www-form-urlencoded body");
  }

  let token: string;
  try {
    token = String((await request.formData()).get("logout_token") ?? "");
  } catch {
    return bad("the request body could not be read as a form");
  }
  if (!token) return bad("no logout_token was supplied");

  // The issuer is read unverified only to pick which provider to verify against - every claim is
  // checked again, against that provider's configuration, inside verifyLogoutToken.
  const claimedIssuer = unverifiedIssuer(token);
  if (!claimedIssuer) return bad("the logout_token is not a JWT with an iss claim");

  const enabled = await listEnabledOAuthProviders();
  const providers = enabled.filter((provider) => issuedBy(provider, claimedIssuer));
  if (providers.length === 0) {
    // The mismatch is almost always a configured issuer that differs from the one the IdP sends by
    // a trailing slash. Name both in the log, where only the operator sees them - the response
    // stays vague because this endpoint answers anyone who can reach it.
    console.warn(
      `[backchannel-logout] No enabled provider has issuer "${claimedIssuer}". Configured: ${
        enabled.map((provider) => `"${provider.issuer ?? "(none)"}"`).join(", ") || "(none)"
      }`,
    );
    return bad("no enabled provider is configured for that issuer");
  }

  // More than one provider can share an issuer - two client registrations against the same
  // Keycloak realm, say - so the token is offered to each until one accepts it by audience.
  let failure = "the logout_token could not be verified";
  for (const provider of providers) {
    const result = await verifyLogoutToken(token, provider);
    if (!result.ok) {
      failure = result.reason;
      continue;
    }

    if (!(await rememberLogoutJti(result.claims.issuer, result.claims.jti))) {
      // Already acted on. A replay is answered 200: the sessions it names are gone, which is what
      // the provider is asking for, and a 400 would invite it to keep retrying.
      return ok();
    }

    const revoked = await revokeSessionsForLogoutToken({
      providerId: provider.id,
      subject: result.claims.subject,
      sessionId: result.claims.sessionId,
    });
    console.log(
      `[backchannel-logout] ${provider.name}: ended ${revoked.sessions} session(s) for ${revoked.userIds.length} user(s)`,
    );
    // Zero sessions is still a success. The subject may never have signed in to CPM, or may have
    // signed out already, and reporting that as a failure would have the IdP retry forever.
    return ok();
  }

  return bad(failure);
}

/** The `iss` from an unverified JWT payload, used only to select a provider. */
function unverifiedIssuer(token: string): string | null {
  const iss = decodeJwtPayload(token)?.iss;
  return typeof iss === "string" && iss ? iss : null;
}

/** Anything but a POST is a misconfiguration; say so rather than rendering a 404. */
export async function GET() {
  return NextResponse.json(
    { error: "invalid_request", error_description: "this endpoint accepts POST only" },
    { status: 405, headers: NO_STORE },
  );
}
