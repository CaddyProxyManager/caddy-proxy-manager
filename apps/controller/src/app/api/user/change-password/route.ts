import { localUsersDisabled } from "@/src/lib/auth/policy";
import { type NextRequest, NextResponse } from "next/server";
import {
  auth,
  checkSameOrigin,
  FRESH_SESSION_MAX_AGE_MS,
  getCurrentSessionInfo,
  isFreshSession,
} from "@/src/lib/auth";
import { getUserById, getUserPasswordHash, updateUserPassword } from "@/src/lib/models/user";
import { revokeSessionsAfterPasswordChange } from "@/src/lib/models/sessions";
import { createAuditEvent } from "@/src/lib/models/audit";
import { isRateLimited, registerFailedAttempt, resetAttempts } from "@/src/lib/auth/rate-limit";
import { hashPassword, verifyPassword } from "@/src/lib/auth/password";
import { getTranslations } from "next-intl/server";
import { isDemoAdmin } from "@/src/lib/demo/mode";
import { passwordPolicyMessage } from "@/src/lib/auth/password/policy-message";
import { hasDirectoryAccount } from "@/src/lib/models/ldap-directories";

export async function POST(request: NextRequest) {
  const originCheck = checkSameOrigin(request);
  if (originCheck) return originCheck;

  // Outside the try so the catch answers in the reader's language too; callers show `error` as is.
  const t = await getTranslations();
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: t("auth.apiErrors.unauthorized") }, { status: 401 });
    }

    // In OIDC-only mode a local password would be a way in around the IdP.
    if (await localUsersDisabled()) {
      return NextResponse.json(
        { error: t("auth.apiErrors.passwordManagementDisabled") },
        { status: 403 },
      );
    }

    // Before the rate limit: this is not a guess, and the model would refuse it anyway.
    if (isDemoAdmin(Number(session.user.id))) {
      return NextResponse.json({ error: t("errors.demoAdminProtected") }, { status: 403 });
    }

    // Stops brute-forcing the current password.
    const rateLimitKey = `password-change:${session.user.id}`;
    const rateCheck = await isRateLimited(rateLimitKey);
    if (rateCheck.blocked) {
      return NextResponse.json(
        { error: t("auth.apiErrors.tooManyAttempts") },
        {
          status: 429,
          headers: rateCheck.retryAfterMs
            ? { "Retry-After": String(Math.ceil(rateCheck.retryAfterMs / 1000)) }
            : undefined,
        },
      );
    }

    const body = await request.json();
    const { currentPassword, newPassword } = body;

    const policyError = passwordPolicyMessage(
      t,
      newPassword ?? "",
      t("passwordPolicy.subject.newPassword"),
    );
    if (policyError) {
      return NextResponse.json({ error: policyError }, { status: 400 });
    }

    const userId = Number(session.user.id);
    const user = await getUserById(userId);

    if (!user) {
      return NextResponse.json({ error: t("auth.apiErrors.userNotFound") }, { status: 404 });
    }

    const currentSession = await getCurrentSessionInfo(request);
    // Self-registration keeps the hash on the credential account only.
    const currentHash = await getUserPasswordHash(user);

    // A first password for a directory account would outlive the directory disabling it.
    if (!currentHash && (await hasDirectoryAccount(userId))) {
      return NextResponse.json({ error: t("errors.passwordManagedByDirectory") }, { status: 403 });
    }

    if (currentHash) {
      if (!currentPassword) {
        return NextResponse.json(
          { error: t("auth.apiErrors.currentPasswordRequired") },
          { status: 400 },
        );
      }

      const isValid = await verifyPassword(currentPassword, currentHash);
      if (!isValid) {
        await registerFailedAttempt(rateLimitKey);
        return NextResponse.json(
          { error: t("auth.apiErrors.currentPasswordIncorrect") },
          { status: 401 },
        );
      }
    } else if (!isFreshSession(currentSession)) {
      // A first password is a new way in (and lets the IdP be unlinked), so a borrowed session is
      // not enough; with no current password to ask for, a recent provider sign-in is the proof.
      return NextResponse.json(
        {
          error: t("profile.reauthRequiredToSetPassword", {
            minutes: FRESH_SESSION_MAX_AGE_MS / 60_000,
          }),
          code: "reauth-required",
        },
        { status: 403 },
      );
    }

    await resetAttempts(rateLimitKey);

    const newPasswordHash = await hashPassword(newPassword);

    await updateUserPassword(userId, newPasswordHash);

    // A changed password has to end whoever else was signed in with the old one.
    await revokeSessionsAfterPasswordChange(userId, currentSession?.id ?? null);

    await createAuditEvent({
      userId,
      action: currentHash ? "password_changed" : "password_set",
      entityType: "user",
      entityId: userId,
      summary: currentHash ? "User changed their password" : "User set a password",
    });

    // No message: both clients word the outcome themselves.
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Password change error:", error);
    return NextResponse.json({ error: t("auth.passwordChange.failed") }, { status: 500 });
  }
}
