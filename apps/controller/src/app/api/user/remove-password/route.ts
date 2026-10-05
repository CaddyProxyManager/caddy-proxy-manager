import { type NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { isDemoAdmin } from "@/src/lib/demo/mode";
import { auth, checkSameOrigin } from "@/src/lib/auth";
import { getUserById, listUserOAuthProviders, removeUserPassword } from "@/src/lib/models/user";
import { createAuditEvent } from "@/src/lib/models/audit";
import { isRateLimited, registerFailedAttempt, resetAttempts } from "@/src/lib/auth/rate-limit";
import { verifyPassword } from "@/src/lib/auth/password";
import { countUserPasskeys } from "@/src/lib/auth/passkeys";

/**
 * The inverse of unlink-oauth: refuses to leave the account without a provider or a passkey. Asks
 * for the current password, so a borrowed session cannot lock the owner out.
 */
export async function POST(request: NextRequest) {
  const originCheck = checkSameOrigin(request);
  if (originCheck) return originCheck;

  const t = await getTranslations();
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: t("auth.apiErrors.unauthorized") }, { status: 401 });
    }

    const userId = Number(session.user.id);
    // Before the rate limit: this is not a guess, and the model would refuse it anyway.
    if (isDemoAdmin(userId)) {
      return NextResponse.json({ error: t("errors.demoAdminProtected") }, { status: 403 });
    }

    // Shares change-password's budget, or a session holder would get twice the guesses.
    const rateLimitKey = `password-change:${userId}`;
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

    const user = await getUserById(userId);
    if (!user) {
      return NextResponse.json({ error: t("auth.apiErrors.userNotFound") }, { status: 404 });
    }
    if (!user.passwordHash) {
      return NextResponse.json({ error: t("profile.noPasswordToRemove") }, { status: 400 });
    }

    const [providers, passkeyCount] = await Promise.all([
      listUserOAuthProviders(userId),
      countUserPasskeys(userId),
    ]);
    if (providers.length === 0 && passkeyCount === 0) {
      return NextResponse.json(
        { error: t("profile.linkProviderBeforeRemovingPassword") },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    if (!currentPassword) {
      return NextResponse.json(
        { error: t("auth.apiErrors.currentPasswordRequired") },
        { status: 400 },
      );
    }
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      await registerFailedAttempt(rateLimitKey);
      return NextResponse.json(
        { error: t("auth.apiErrors.currentPasswordIncorrect") },
        { status: 401 },
      );
    }
    resetAttempts(rateLimitKey);

    await removeUserPassword(userId);

    // "passkey" reads as one more provider id in the summary the audit log parses back.
    const methods = [
      ...providers.map((p) => p.providerId),
      ...(passkeyCount > 0 ? ["passkey"] : []),
    ];
    await createAuditEvent({
      userId,
      action: "password_removed",
      entityType: "user",
      entityId: userId,
      summary: `User removed their password; signs in with ${methods.join(", ")}`,
      data: JSON.stringify({
        providers: providers.map((p) => p.providerId),
        passkeys: passkeyCount,
      }),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Remove password error:", error);
    return NextResponse.json({ error: t("profile.removePasswordFailed") }, { status: 500 });
  }
}
