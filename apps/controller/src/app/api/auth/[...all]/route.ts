import { getAuth } from "@/src/lib/auth-server";
import { toNextJsHandler } from "better-auth/next-js";
import { getTranslations } from "next-intl/server";
import { CLIENT_IP_HEADER, getClientIp } from "@/src/lib/client-ip";
import {
  CAPTCHA_PASS_CLEAR_COOKIE,
  captchaPassFromCookieHeader,
  redeemCaptchaPass,
} from "@/src/lib/captcha/pass";
import { getActiveCaptcha } from "@/src/lib/captcha/settings";
import {
  accountKey,
  accountRetryAfterMs,
  registerAccountFailure,
  resetAccountFailures,
} from "@/src/lib/rate-limit";
import {
  CREDENTIAL_SIGN_IN_PATHS,
  TWO_FACTOR_MANAGE_PATHS,
  hasTwoFactorChallengeCookie,
} from "@/src/lib/auth-sign-in-paths";
import { isDemoAdmin, isDemoMode } from "@/src/lib/demo-mode";
import { createAuditEvent } from "@/src/lib/models/audit";

export const dynamic = "force-dynamic";

const PASSWORD_SIGN_IN_PATHS = new Set(CREDENTIAL_SIGN_IN_PATHS.map((path) => `/api/auth${path}`));
const TWO_FACTOR_MANAGE = new Set(TWO_FACTOR_MANAGE_PATHS.map((path) => `/api/auth${path}`));

/**
 * How a signed-in user's own 2FA change is logged. Confirming a new authenticator hits verify-totp
 * with no sign-in challenge cookie, which tells it apart from a code entered while signing in.
 */
function twoFactorManageAudit(
  pathname: string,
  cookies: string | null,
): { action: string; summary: string } | null {
  switch (pathname) {
    case "/api/auth/two-factor/verify-totp":
      return hasTwoFactorChallengeCookie(cookies)
        ? null
        : { action: "two_factor_enabled", summary: "User turned on two-factor sign-in" };
    case "/api/auth/two-factor/disable":
      return { action: "two_factor_disabled", summary: "User turned off two-factor sign-in" };
    case "/api/auth/two-factor/generate-backup-codes":
      return { action: "two_factor_backup_codes", summary: "User replaced their backup codes" };
  }
  return null;
}

/** Every demo visitor shares one account, and a second factor on it would lock the next one out. */
async function isDemoAdminRequest(request: Request): Promise<boolean> {
  if (!isDemoMode()) return false;
  const session = await (await getAuth()).api.getSession({ headers: request.headers });
  return session?.user ? isDemoAdmin(Number(session.user.id)) : false;
}

/** better-auth keys its rate limiter on CLIENT_IP_HEADER alone, so a client-sent copy is replaced. */
async function withClientIp(request: Request): Promise<Request> {
  const headers = new Headers(request.headers);
  headers.delete(CLIENT_IP_HEADER);
  const ip = await getClientIp(request.headers);
  if (ip) headers.set(CLIENT_IP_HEADER, ip);
  // Rebuilt from the URL: Bun's `new Request(request, { headers })` keeps a header the init omits.
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(request.url, {
    method: request.method,
    headers,
    body: hasBody ? request.body : null,
    signal: request.signal,
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}

/** The name a password sign-in is for, as sent. */
async function signInName(request: Request): Promise<string | null> {
  try {
    const body = (await request.json()) as { username?: unknown; email?: unknown };
    const name = typeof body.username === "string" ? body.username : body.email;
    return typeof name === "string" && name.trim() ? name : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  return toNextJsHandler(await getAuth()).GET(await withClientIp(request));
}

export async function POST(request: Request) {
  const forwarded = await withClientIp(request);
  const pathname = new URL(request.url).pathname;
  if (TWO_FACTOR_MANAGE.has(pathname) && (await isDemoAdminRequest(request))) {
    const t = await getTranslations("errors");
    return Response.json(
      { code: "DEMO_LOCKED", message: t("demoAdminProtected") },
      { status: 403 },
    );
  }
  const managedAudit = twoFactorManageAudit(pathname, request.headers.get("cookie"));
  if (managedAudit) {
    const session = await (await getAuth()).api.getSession({ headers: request.headers });
    const response = await toNextJsHandler(await getAuth()).POST(forwarded);
    if (response.ok && session?.user) {
      await createAuditEvent({
        userId: Number(session.user.id),
        action: managedAudit.action,
        entityType: "user",
        entityId: Number(session.user.id),
        summary: managedAudit.summary,
      }).catch(() => {});
    }
    return response;
  }
  if (!PASSWORD_SIGN_IN_PATHS.has(pathname)) {
    return toNextJsHandler(await getAuth()).POST(forwarded);
  }

  const name = await signInName(forwarded.clone());

  // Shares its counter with the forward-auth portal, whatever address the guesses come from.
  const account = name ? accountKey(name) : null;
  const retryAfterMs = account ? accountRetryAfterMs(account) : 0;
  if (retryAfterMs > 0) {
    const t = await getTranslations("auth.apiErrors");
    return Response.json(
      { code: "TOO_MANY_REQUESTS", message: t("tooManyLoginAttempts") },
      { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } },
    );
  }

  // Enforced here, not only by the form: the endpoint is reachable without it. After the throttle,
  // so a request refused for that does not spend the solve.
  const captcha = await getActiveCaptcha();
  // No name, no pass: an empty one would be the account key of the username "@localhost".
  if (
    captcha &&
    (!name || !redeemCaptchaPass(captchaPassFromCookieHeader(request.headers.get("cookie")), name))
  ) {
    const t = await getTranslations("auth.apiErrors");
    return Response.json(
      { code: "CAPTCHA_REQUIRED", message: t("captchaRequired") },
      { status: 403 },
    );
  }

  const response = await toNextJsHandler(await getAuth()).POST(forwarded);
  if (account) {
    if (response.status === 401) registerAccountFailure(account);
    else if (response.ok) resetAccountFailures(account);
  }
  if (captcha) response.headers.append("Set-Cookie", CAPTCHA_PASS_CLEAR_COOKIE);
  if (response.ok) await auditCompletedSignIn(response);
  return response;
}

/**
 * The session hook skips password sign-ins, because the two-factor plugin may yet delete the
 * session it made. One that comes back without a challenge is final, so it's recorded here.
 */
async function auditCompletedSignIn(response: Response): Promise<void> {
  try {
    const body = (await response.clone().json()) as {
      twoFactorRedirect?: boolean;
      user?: { id?: string | number };
    };
    const userId = Number(body.user?.id);
    if (body.twoFactorRedirect || !Number.isInteger(userId)) return;
    await createAuditEvent({
      userId,
      action: "login_success",
      entityType: "session",
      entityId: null,
      summary: "User signed in",
    });
  } catch {
    // Never fail a sign-in over its audit entry.
  }
}
