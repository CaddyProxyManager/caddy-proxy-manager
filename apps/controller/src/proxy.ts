import { NextResponse } from "next/server";
import { domainErrorMessage } from "@/src/lib/errors/domain-error";
import { TWO_FACTOR_SETUP_PATH, mustEnrollTwoFactor } from "@/src/lib/auth/two-factor/policy";
import {
  CONSOLE_ENABLE_USER_PATH,
  CONSOLE_LIFT_MFA_POLICY_PATH,
  CONSOLE_RESET_TWO_FACTOR_PATH,
} from "@/src/lib/users/console-command";
import type { NextRequest } from "next/server";
import crypto from "node:crypto";
import { auth } from "@/src/lib/auth";
import { config as appConfig } from "@/src/lib/config";
import { buildCsp, type CspAdditions } from "@/src/lib/http/csp";

/** Next.js Proxy: defense-in-depth auth at the edge, before page components. Node runtime. */

const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), interest-cohort=()";

function applySecurityHeaders(response: NextResponse, csp: string): NextResponse {
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", PERMISSIONS_POLICY);
  // Only over HTTPS: a browser pinned to a scheme this origin does not serve cannot be unpinned.
  if (appConfig.baseUrl.toLowerCase().startsWith("https:")) {
    response.headers.set("Strict-Transport-Security", "max-age=31536000");
  }
  return response;
}

/** vinext reads the nonce from the request's copy of the CSP. */
function nonceCspResponse(req: NextRequest, extra?: CspAdditions): NextResponse {
  const nonce = crypto.randomBytes(16).toString("base64");
  const csp = buildCsp(nonce, extra);
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("Content-Security-Policy", csp);
  return applySecurityHeaders(NextResponse.next({ request: { headers: requestHeaders } }), csp);
}

/** Only the sign-in pages may load from the CAPTCHA's origins. */
async function loginCspAdditions(): Promise<CspAdditions | undefined> {
  try {
    const [{ getActiveCaptcha }, { captchaCspSources }] = await Promise.all([
      import("@/src/lib/captcha/settings"),
      import("@/src/lib/captcha/providers"),
    ]);
    const captcha = await getActiveCaptcha();
    return captcha ? captchaCspSources(captcha) : undefined;
  } catch (error) {
    // The widget will be blocked and the form says so; the sign-in page itself must still load.
    console.warn("[proxy] Could not read the CAPTCHA settings:", error);
    return undefined;
  }
}

export default async function proxy(req: NextRequest) {
  const pathname = req.nextUrl.pathname;

  // Setup before an account exists; the settings step runs after sign-in. Not `/api/setup/*`:
  // that also holds /api/setup/backup, which streams every account and is admin-only.
  const isSetupEntry =
    pathname === "/setup" ||
    pathname === "/setup/migrate" ||
    pathname === "/api/setup" ||
    pathname === "/api/setup/migrate" ||
    pathname === "/api/setup/restart";

  const publicResponse = async () => {
    // The sign-in forms are what an injected script would most want to read.
    if (pathname === "/portal") return nonceCspResponse(req, await loginCspAdditions());
    if (!pathname.startsWith("/api/")) return nonceCspResponse(req);

    // Framing still applies to an API response a browser renders (better-auth's error page).
    const response = applySecurityHeaders(NextResponse.next(), "frame-ancestors 'none'");
    // In the protocol, since old integrations never read the docs.
    if (pathname.startsWith("/api/v1/")) {
      response.headers.set("Deprecation", "true");
      response.headers.set("Link", '</api/graphql>; rel="successor-version"');
    }
    return response;
  };

  // Not `/login`: returning early would skip the setup redirect, stranding a fresh deployment on
  // a sign-in form for an account that does not exist. It is handled after the setup check.
  if (
    pathname === "/portal" ||
    isSetupEntry ||
    pathname.startsWith("/api/auth") ||
    pathname === "/api/health" ||
    // Branding, not a secret; the pages before a session need it too.
    pathname === "/api/branding/favicon" ||
    // The push service worker: the browser's update check carries no guarantee of a session.
    pathname === "/sw.js" ||
    pathname.startsWith("/api/v1/") ||
    // Authenticates itself (Bearer, session or agent signature); a redirect to HTML would break
    // GraphQL clients and the agent protocol.
    pathname === "/api/graphql" ||
    // Authenticates itself; an unsigned caller gets a 404.
    pathname.startsWith("/api/agent/") ||
    pathname.startsWith("/api/forward-auth/") ||
    pathname === "/api/sign-in/captcha" ||
    // For someone who cannot sign in; each route is rate-limited and answers nothing about accounts.
    pathname.startsWith("/api/password-reset/") ||
    // Signed by `cpm-server --reset-2fa`, `--enable-user` and `--lift-mfa-policy`, answered only to
    // loopback; see the routes.
    pathname === CONSOLE_RESET_TWO_FACTOR_PATH ||
    pathname === CONSOLE_ENABLE_USER_PATH ||
    pathname === CONSOLE_LIFT_MFA_POLICY_PATH
  ) {
    return publicResponse();
  }

  const session = await auth(req);
  const isAuthenticated = !!session?.user;

  // Before the sign-in redirect, after auth (the stage depends on being signed in), pages only.
  if (!pathname.startsWith("/api/")) {
    const { getSetupState, SETUP_PATHS } = await import("@/src/lib/setup");
    const { stage, required } = await getSetupState(isAuthenticated);
    const destination = SETUP_PATHS[stage];
    if (required && pathname !== destination) {
      return NextResponse.redirect(new URL(destination, req.url));
    }
    // /setup/done is the post-completion migration summary, and guards itself.
    if (!required && pathname.startsWith("/setup") && pathname !== "/setup/done") {
      return NextResponse.redirect(new URL("/", req.url));
    }
  }

  if (!isAuthenticated && !pathname.startsWith("/login")) {
    const loginUrl = new URL("/login", req.url);
    return NextResponse.redirect(loginUrl);
  }

  // Caught by the 2FA policy: only enrolling, or signing out under /api/auth, until then.
  if (
    isAuthenticated &&
    pathname !== TWO_FACTOR_SETUP_PATH &&
    (await mustEnrollTwoFactor(session))
  ) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { code: "TWO_FACTOR_REQUIRED", error: domainErrorMessage("twoFactorRequired") },
        { status: 403 },
      );
    }
    return NextResponse.redirect(new URL(TWO_FACTOR_SETUP_PATH, req.url));
  }

  if (pathname.startsWith("/login")) {
    return nonceCspResponse(req, await loginCspAdditions());
  }

  return nonceCspResponse(req);
}

export const config = {
  matcher: [
    // maplibre's tile worker must load with an expired session, or a /login redirect parses as JS.
    "/((?!_next/static|_next/image|favicon.ico|maplibre/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
