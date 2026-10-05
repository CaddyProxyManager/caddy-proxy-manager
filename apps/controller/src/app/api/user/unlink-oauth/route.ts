import { type NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { auth, checkSameOrigin } from "@/src/lib/auth";
import { getPasswordSignInUsername, getUserById, getUserPasswordHash } from "@/src/lib/models/user";
import { createAuditEvent } from "@/src/lib/models/audit";
import { isRateLimited, registerFailedAttempt, resetAttempts } from "@/src/lib/auth/rate-limit";
import { verifyPassword } from "@/src/lib/auth/password";
import db from "@/src/lib/db";
import { accounts } from "@/src/lib/db/schema";
import { and, eq, ne } from "drizzle-orm";

/**
 * Unlink the signed-in user's providers, leaving their password as the only way in.
 *
 * The current password is asked for, as remove-password asks for it from the other side: a
 * borrowed session must not be enough to strip the owner's single sign-on.
 */
export async function POST(request: NextRequest) {
  const originCheck = checkSameOrigin(request);
  if (originCheck) return originCheck;

  const t = await getTranslations("profile");
  try {
    const session = await auth();
    if (!session?.user?.id) {
      const tApi = await getTranslations("auth.apiErrors");
      return NextResponse.json({ error: tApi("unauthorized") }, { status: 401 });
    }

    const userId = Number(session.user.id);
    // The change-password budget: every route verifying this password shares one counter.
    const rateLimitKey = `password-change:${userId}`;
    const rateCheck = await isRateLimited(rateLimitKey);
    if (rateCheck.blocked) {
      return NextResponse.json(
        { error: t("tooManyAttempts") },
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
      const tApi = await getTranslations("auth.apiErrors");
      return NextResponse.json({ error: tApi("userNotFound") }, { status: 404 });
    }

    // The login page must still work: a username plus the password on the credential account.
    const passwordHash = await getUserPasswordHash(user);
    if (!passwordHash) {
      return NextResponse.json({ error: t("unlinkPasswordRequired") }, { status: 400 });
    }
    if (!(await getPasswordSignInUsername(userId))) {
      return NextResponse.json({ error: t("unlinkSignInUnavailable") }, { status: 400 });
    }

    const oauthAccounts = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, userId), ne(accounts.providerId, "credential")));

    if (oauthAccounts.length === 0) {
      return NextResponse.json({ error: t("noOauthToUnlink") }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
    if (!currentPassword) {
      return NextResponse.json({ error: t("currentPasswordRequired") }, { status: 400 });
    }
    if (!(await verifyPassword(currentPassword, passwordHash))) {
      await registerFailedAttempt(rateLimitKey);
      return NextResponse.json({ error: t("currentPasswordIncorrect") }, { status: 401 });
    }
    resetAttempts(rateLimitKey);

    const previousProvider = oauthAccounts[0].providerId;

    await db
      .delete(accounts)
      .where(and(eq(accounts.userId, userId), ne(accounts.providerId, "credential")));

    // Re-derive users.provider/subject from the (now OAuth-free) accounts rows
    // so the Profile page stops reporting the account as linked (#261).
    const { syncUserOAuthIdentity } = await import("@/src/lib/models/user");
    await syncUserOAuthIdentity(userId);

    await createAuditEvent({
      userId,
      action: "oauth_unlinked",
      entityType: "user",
      entityId: userId,
      summary: `User unlinked OAuth account: ${previousProvider}`,
      data: JSON.stringify({ provider: previousProvider }),
    });

    // No message: the profile page says its own, and reloads.
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("OAuth unlink error:", error);
    return NextResponse.json({ error: t("unlinkFailed") }, { status: 500 });
  }
}
