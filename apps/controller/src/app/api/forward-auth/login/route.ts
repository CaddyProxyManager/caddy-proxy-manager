import { localUsersDisabled } from "@/src/lib/auth/policy";
import { randomBytes } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { hashPassword, verifyPassword } from "@/src/lib/auth/password";
import db from "@/src/lib/db";
import { getClientIp } from "@/src/lib/http/client-ip";
import { isPublicOrigin } from "@/src/lib/http/public-url";
import { hasLiveRedirectIntent, redirectIntentWantsCaptcha } from "@/src/lib/models/forward-auth";
import { completePortalLogin } from "@/src/lib/forward-auth/portal-login";
import { beginPortalLoginAttempt } from "@/src/lib/forward-auth/login-limiter";
import { issuePortalChallenge } from "@/src/lib/forward-auth/portal-two-factor";
import {
  CAPTCHA_PASS_CLEAR_COOKIE,
  captchaPassFromCookieHeader,
  redeemCaptchaPass,
} from "@/src/lib/captcha/pass";
import { getActiveCaptcha } from "@/src/lib/captcha/settings";
import { logAuditEvent } from "@/src/lib/audit";
import { accountKey, accountRetryAfterMs, isRateLimited } from "@/src/lib/auth/rate-limit";
import { authPolicy } from "@/src/lib/auth/policy";
import { getAuth } from "@/src/lib/auth/server";
import { listLdapDirectoryChoices } from "@/src/lib/models/ldap-directories";
import { resolveSignInDirectory, signInWithDirectory } from "@/src/lib/ldap/sign-in";
import { ACCOUNT_LOCKED } from "@/src/lib/auth/sign-in-error";
import { mfaStandingForAccount } from "@/src/lib/auth/two-factor/policy";
import { TWO_FACTOR_SETUP_REQUIRED } from "@/src/lib/auth/two-factor/error";

// The form posts a username, a password and a rid; anything larger is not a login.
const MAX_BODY_BYTES = 16 * 1024;
const MAX_USERNAME_LENGTH = 256;
const AUDITED_USERNAME_LENGTH = 64;

/**
 * Verified against when there is no usable account, so that answer takes as long as a wrong
 * password. Hashed once, of a discarded random string, at the cost real accounts use.
 */
let dummyPasswordHash: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  dummyPasswordHash ??= hashPassword(randomBytes(32).toString("base64url"));
  return dummyPasswordHash;
}

/** The body as text, or null past MAX_BODY_BYTES; counted as it streams, not trusted from a header. */
async function readBodyText(request: NextRequest): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(request: NextRequest) {
  const t = await getTranslations("auth.apiErrors");
  try {
    // CSRF: the portal may be served from any of this instance's own addresses.
    if (!(await isPublicOrigin(request.headers.get("origin")))) {
      return NextResponse.json({ error: t("forbidden") }, { status: 403 });
    }

    // The portal falls back to the provider buttons, unless a directory still takes passwords.
    const localDisabled = await localUsersDisabled();
    if (localDisabled && (await listLdapDirectoryChoices()).length === 0) {
      return NextResponse.json({ error: t("passwordSignInDisabled") }, { status: 403 });
    }

    const text = await readBodyText(request);
    if (text === null) {
      return NextResponse.json({ error: t("requestTooLarge") }, { status: 413 });
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      body =
        typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return NextResponse.json({ error: t("invalidRequestBody") }, { status: 400 });
    }
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const rid = typeof body.rid === "string" ? body.rid : "";
    const directoryId =
      typeof body.directoryId === "string" && body.directoryId ? body.directoryId : null;

    if (!username || !password) {
      return NextResponse.json({ error: t("credentialsRequired") }, { status: 400 });
    }
    if (username.length > MAX_USERNAME_LENGTH) {
      return NextResponse.json({ error: t("usernameTooLong") }, { status: 400 });
    }
    if (!rid) {
      return NextResponse.json({ error: t("missingRedirectIntent") }, { status: 400 });
    }

    const ip = (await getClientIp(request.headers)) ?? "unknown";
    const account = accountKey(username);
    const rateLimitResult = await isRateLimited(ip);
    if (rateLimitResult.blocked) {
      return NextResponse.json({ error: t("tooManyLoginAttempts") }, { status: 429 });
    }
    const lockedMs = await accountRetryAfterMs(account);
    if (lockedMs > 0) {
      const retryAfter = Math.ceil(lockedMs / 1000);
      return NextResponse.json(
        { error: t("tooManyLoginAttempts"), code: ACCOUNT_LOCKED, retryAfter },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
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
      !(await redeemCaptchaPass(
        captchaPassFromCookieHeader(request.headers.get("cookie")),
        username,
      ))
    ) {
      return NextResponse.json(
        { error: t("captchaRequired"), code: "CAPTCHA_REQUIRED" },
        { status: 403 },
      );
    }
    const spentHeaders: HeadersInit = captchaGated
      ? { "Set-Cookie": CAPTCHA_PASS_CLEAR_COOKIE }
      : {};

    const attempt = await beginPortalLoginAttempt(username, ip);
    if (!attempt) {
      return NextResponse.json(
        { error: t("tooManyLoginAttempts") },
        { status: 429, headers: spentHeaders },
      );
    }

    let user: Awaited<ReturnType<typeof db.query.users.findFirst>>;
    let isValid = false;
    try {
      // Picking a directory skips the local account, as on /login.
      if (!directoryId && !localDisabled) {
        const email = `${username}@localhost`;
        user = await db.query.users.findFirst({
          where: (table, operators) => operators.eq(table.email, email),
        });
        const passwordHash = user?.status === "active" ? user.passwordHash : null;
        // One verify either way, so a missing, inactive or passwordless account answers as slowly.
        const matches = await verifyPassword(
          password,
          passwordHash || (await getDummyPasswordHash()),
        );
        isValid = Boolean(passwordHash) && matches;
      }
      if (!isValid) {
        const directory = await resolveSignInDirectory(directoryId);
        if (directory) {
          const [{ internalAdapter }, { allowOauthRegistration }] = await Promise.all([
            (await getAuth()).$context,
            authPolicy(),
          ]);
          const ldapUserId = await signInWithDirectory(
            internalAdapter,
            directory,
            username,
            password,
            allowOauthRegistration,
          );
          if (ldapUserId !== null) {
            user = await db.query.users.findFirst({
              where: (table, operators) => operators.eq(table.id, ldapUserId),
            });
            isValid = user?.status === "active";
          }
        }
      }
    } catch (error) {
      attempt.release();
      throw error;
    }

    if (!user || !isValid) {
      // Only a picked directory skips the local account; see auth/account-failures.ts.
      await attempt.fail(directoryId || localDisabled ? "directory" : "local");
      await logAuditEvent({
        userId: user?.id ?? null,
        action: "forward_auth_login_failed",
        entityType: "user",
        ...(user ? { entityId: user.id } : {}),
        summary: `Forward auth login failed for username: ${username.slice(0, AUDITED_USERNAME_LENGTH)}`,
      });
      return NextResponse.json(
        { error: t("invalidCredentials") },
        { status: 401, headers: spentHeaders },
      );
    }
    await attempt.succeed();

    // Half a sign-in with 2FA on: the intent stays unspent until the code checks out.
    if (user.twoFactorEnabled) {
      return NextResponse.json(
        { needsSecondFactor: true, challenge: issuePortalChallenge(user.id, rid) },
        { headers: spentHeaders },
      );
    }

    // The dashboard would send this account to set up 2FA; the portal has no setup, so it refuses.
    // An account whose factor is a passkey stands satisfied, and the portal takes passkeys.
    const standing = await mfaStandingForAccount({
      id: user.id,
      role: user.role,
      hasPassword: Boolean(user.passwordHash),
      twoFactorEnabled: false,
    });
    if (standing.status === "required") {
      await logAuditEvent({
        userId: user.id,
        action: "forward_auth_login_failed",
        entityType: "user",
        entityId: user.id,
        summary: `Forward auth login refused for user ${user.email}: two-factor setup is required`,
      });
      return NextResponse.json(
        { error: t("twoFactorSetupRequired"), code: TWO_FACTOR_SETUP_REQUIRED },
        { status: 403, headers: spentHeaders },
      );
    }

    return await completePortalLogin(user, rid, t, spentHeaders);
  } catch (error) {
    console.error("Forward auth login error:", error);
    return NextResponse.json({ error: t("internalServerError") }, { status: 500 });
  }
}
