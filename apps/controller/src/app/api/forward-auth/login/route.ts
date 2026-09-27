import { localUsersDisabled } from "@/src/lib/auth-policy";
import { type NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { verifyPassword } from "@/src/lib/password";
import db from "@/src/lib/db";
import { getClientIp } from "@/src/lib/client-ip";
import { isPublicOrigin } from "@/src/lib/public-url";
import { hasLiveRedirectIntent, redirectIntentWantsCaptcha } from "@/src/lib/models/forward-auth";
import { completePortalLogin } from "@/src/lib/forward-auth-portal-login";
import { issuePortalChallenge } from "@/src/lib/portal-two-factor";
import {
  CAPTCHA_PASS_CLEAR_COOKIE,
  captchaPassFromCookieHeader,
  redeemCaptchaPass,
} from "@/src/lib/captcha/pass";
import { getActiveCaptcha } from "@/src/lib/captcha/settings";
import { logAuditEvent } from "@/src/lib/audit";
import {
  accountKey,
  accountRetryAfterMs,
  isRateLimited,
  registerAccountFailure,
  registerFailedAttempt,
  resetAccountFailures,
  resetAttempts,
} from "@/src/lib/rate-limit";

export async function POST(request: NextRequest) {
  const t = await getTranslations("auth.apiErrors");
  try {
    // CSRF: the portal may be served from any of this instance's own addresses.
    if (!(await isPublicOrigin(request.headers.get("origin")))) {
      return NextResponse.json({ error: t("forbidden") }, { status: 403 });
    }

    // The portal falls back to the provider buttons.
    if (await localUsersDisabled()) {
      return NextResponse.json({ error: t("passwordSignInDisabled") }, { status: 403 });
    }

    const body = await request.json();
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const rid = typeof body.rid === "string" ? body.rid : "";

    if (!username || !password) {
      return NextResponse.json({ error: t("credentialsRequired") }, { status: 400 });
    }
    if (!rid) {
      return NextResponse.json({ error: t("missingRedirectIntent") }, { status: 400 });
    }

    const ip = (await getClientIp(request.headers)) ?? "unknown";
    const account = accountKey(username);
    const rateLimitResult = await isRateLimited(ip);
    if (rateLimitResult.blocked || accountRetryAfterMs(account) > 0) {
      return NextResponse.json({ error: t("tooManyLoginAttempts") }, { status: 429 });
    }

    // Before the password, so a request without a live intent learns nothing about credentials.
    if (!(await hasLiveRedirectIntent(rid))) {
      return NextResponse.json({ error: t("invalidRedirectIntent") }, { status: 400 });
    }

    // Same gate as the dashboard's unless this host opted out: one solve, one attempt.
    const captchaGated =
      (await getActiveCaptcha()) !== null && (await redirectIntentWantsCaptcha(rid));
    if (
      captchaGated &&
      !redeemCaptchaPass(captchaPassFromCookieHeader(request.headers.get("cookie")), username)
    ) {
      return NextResponse.json(
        { error: t("captchaRequired"), code: "CAPTCHA_REQUIRED" },
        { status: 403 },
      );
    }
    const spentHeaders: HeadersInit = captchaGated
      ? { "Set-Cookie": CAPTCHA_PASS_CLEAR_COOKIE }
      : {};

    const email = `${username}@localhost`;
    const user = await db.query.users.findFirst({
      where: (table, operators) => operators.eq(table.email, email),
    });

    if (user?.status !== "active" || !user.passwordHash) {
      await registerFailedAttempt(ip);
      registerAccountFailure(account);
      await logAuditEvent({
        userId: null,
        action: "forward_auth_login_failed",
        entityType: "user",
        summary: `Forward auth login failed for username: ${username}`,
      });
      return NextResponse.json(
        { error: t("invalidCredentials") },
        { status: 401, headers: spentHeaders },
      );
    }

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      await registerFailedAttempt(ip);
      registerAccountFailure(account);
      await logAuditEvent({
        userId: user.id,
        action: "forward_auth_login_failed",
        entityType: "user",
        entityId: user.id,
        summary: `Forward auth login failed for user ${user.email}`,
      });
      return NextResponse.json(
        { error: t("invalidCredentials") },
        { status: 401, headers: spentHeaders },
      );
    }

    resetAttempts(ip);
    resetAccountFailures(account);

    // Half a sign-in with 2FA on: the intent stays unspent until the code checks out.
    if (user.twoFactorEnabled) {
      return NextResponse.json(
        { needsSecondFactor: true, challenge: issuePortalChallenge(user.id, rid) },
        { headers: spentHeaders },
      );
    }

    return await completePortalLogin(user, rid, t, spentHeaders);
  } catch (error) {
    console.error("Forward auth login error:", error);
    return NextResponse.json({ error: t("internalServerError") }, { status: 500 });
  }
}
