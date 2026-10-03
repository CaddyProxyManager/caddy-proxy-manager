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
  PASSKEY_MANAGE_PATHS,
  TWO_FACTOR_MANAGE_PATHS,
  hasTwoFactorChallengeCookie,
} from "@/src/lib/auth-sign-in-paths";
import { isDemoAdmin, isDemoMode } from "@/src/lib/demo-mode";
import { createAuditEvent } from "@/src/lib/models/audit";

export const dynamic = "force-dynamic";

const PASSWORD_SIGN_IN_PATHS = new Set(CREDENTIAL_SIGN_IN_PATHS.map((path) => `/api/auth${path}`));
/** Demo-locked: the second factor and the passkeys, the account's credentials beyond its password. */
const CREDENTIAL_MANAGE = new Set(
  [...TWO_FACTOR_MANAGE_PATHS, ...PASSKEY_MANAGE_PATHS].map((path) => `/api/auth${path}`),
);

/**
 * Confirming a new authenticator hits verify-totp with no sign-in challenge cookie. A passkey
 * sign-in is audited by the session hook, like any sign-in without a password.
 */
function credentialManageAudit(
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
    case "/api/auth/passkey/verify-registration":
      return { action: "passkey_added", summary: "User added a passkey" };
    case "/api/auth/passkey/delete-passkey":
      return { action: "passkey_removed", summary: "User removed a passkey" };
  }
  return null;
}

/** Every demo visitor shares one account, and a second factor or passkey would lock the next out. */
async function isDemoAdminRequest(request: Request): Promise<boolean> {
  if (!isDemoMode()) return false;
  const session = await (await getAuth()).api.getSession({ headers: request.headers });
  return session?.user ? isDemoAdmin(Number(session.user.id)) : false;
}

/** better-auth rate-limits on CLIENT_IP_HEADER alone, so a client-sent copy is replaced. */
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

async function signInName(request: Request): Promise<string | null> {
  try {
    const body = (await request.json()) as { username?: unknown; email?: unknown };
    const name = typeof body.username === "string" ? body.username : body.email;
    return typeof name === "string" && name.trim() ? name : null;
  } catch {
    return null;
  }
}

async function demoLocked(): Promise<Response> {
  const t = await getTranslations("errors");
  return Response.json({ code: "DEMO_LOCKED", message: t("demoAdminProtected") }, { status: 403 });
}

export async function GET(request: Request) {
  // Registration starts with a GET that issues the challenge.
  if (CREDENTIAL_MANAGE.has(new URL(request.url).pathname) && (await isDemoAdminRequest(request))) {
    return demoLocked();
  }
  return toNextJsHandler(await getAuth()).GET(await withClientIp(request));
}

export async function POST(request: Request) {
  const forwarded = await withClientIp(request);
  const pathname = new URL(request.url).pathname;
  if (CREDENTIAL_MANAGE.has(pathname) && (await isDemoAdminRequest(request))) {
    return demoLocked();
  }
  const managedAudit = credentialManageAudit(pathname, request.headers.get("cookie"));
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
  // Passkey sign-in included: it has no name to throttle or CAPTCHA against, and a guess needs
  // the private key. Better Auth's per-address request limit still applies.
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

  // The endpoint is reachable without the form. After the throttle, so a refusal keeps the solve.
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

/** The session hook skips password sign-ins, as the 2FA plugin may yet delete that session. */
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
