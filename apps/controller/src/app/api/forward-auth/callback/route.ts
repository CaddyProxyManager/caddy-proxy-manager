import { type NextRequest, NextResponse } from "next/server";
import { redeemExchangeCode } from "@/src/lib/models/forward-auth";
import { resolveTrustedForwardAuthAudience } from "@/src/lib/forward-auth/trust";

const COOKIE_NAME = "_cpm_fa";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

/** Forward auth callback - redeems an exchange code and sets the session cookie. */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    return new NextResponse("Missing code parameter", { status: 400 });
  }

  // The origin may be reached directly, so forwarded headers need the Caddy route's proof, and
  // only count for the proxy host that route belongs to.
  const audience = await resolveTrustedForwardAuthAudience(request.headers);
  if (!audience) {
    return new NextResponse("Invalid or expired authorization code. Please try logging in again.", {
      status: 401,
    });
  }

  const result = await redeemExchangeCode(code, audience);
  if (!result) {
    return new NextResponse("Invalid or expired authorization code. Please try logging in again.", {
      status: 401,
    });
  }

  const response = NextResponse.redirect(result.redirectUri, 302);

  response.cookies.set(COOKIE_NAME, result.rawSessionToken, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE,
  });

  return response;
}
