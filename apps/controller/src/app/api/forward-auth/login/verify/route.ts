import { type NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import db from "@/src/lib/db";
import { localUsersDisabled } from "@/src/lib/auth/policy";
import { logAuditEvent } from "@/src/lib/audit";
import { getClientIp } from "@/src/lib/http/client-ip";
import { completePortalLogin } from "@/src/lib/forward-auth/portal-login";
import {
  redeemPortalChallenge,
  spendPortalChallenge,
} from "@/src/lib/forward-auth/portal-two-factor";
import { isPublicOrigin } from "@/src/lib/http/public-url";
import { isRateLimited, registerFailedAttempt, resetAttempts } from "@/src/lib/auth/rate-limit";
import { type SecondFactorMethod, verifySecondFactor } from "@/src/lib/forward-auth/two-factor";

/** The portal's second step: a TOTP or backup code against the password step's challenge. */
export async function POST(request: NextRequest) {
  const t = await getTranslations("auth.apiErrors");
  try {
    if (!(await isPublicOrigin(request.headers.get("origin")))) {
      return NextResponse.json({ error: t("forbidden") }, { status: 403 });
    }
    if (await localUsersDisabled()) {
      return NextResponse.json({ error: t("passwordSignInDisabled") }, { status: 403 });
    }

    const body = await request.json();
    const challenge = typeof body.challenge === "string" ? body.challenge : "";
    const rid = typeof body.rid === "string" ? body.rid : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const method: SecondFactorMethod = body.method === "backup" ? "backup" : "totp";
    if (!code) {
      return NextResponse.json({ error: t("secondFactorRequired") }, { status: 400 });
    }

    const ip = (await getClientIp(request.headers)) ?? "unknown";
    if ((await isRateLimited(ip)).blocked) {
      return NextResponse.json({ error: t("tooManyLoginAttempts") }, { status: 429 });
    }

    // Counts against the challenge; a spent or forged one sends them back to the password.
    const redeemed = await redeemPortalChallenge(challenge, rid);
    if (!redeemed) {
      return NextResponse.json(
        { error: t("secondFactorExpired"), code: "CHALLENGE_EXPIRED" },
        { status: 401 },
      );
    }

    const user = await db.query.users.findFirst({
      where: (table, operators) => operators.eq(table.id, redeemed.userId),
    });
    if (user?.status !== "active") {
      return NextResponse.json(
        { error: t("secondFactorExpired"), code: "CHALLENGE_EXPIRED" },
        { status: 401 },
      );
    }

    const result = await verifySecondFactor(user.id, method, code);
    if (result === "locked") {
      return NextResponse.json({ error: t("secondFactorLocked") }, { status: 429 });
    }
    if (result !== "ok") {
      await registerFailedAttempt(ip);
      await logAuditEvent({
        userId: user.id,
        action: "forward_auth_login_failed",
        entityType: "user",
        entityId: user.id,
        summary: `Forward auth second factor failed for user ${user.email}`,
      });
      return NextResponse.json({ error: t("invalidSecondFactor") }, { status: 401 });
    }

    await spendPortalChallenge(redeemed.nonce);
    await resetAttempts(ip);
    return await completePortalLogin(user, rid, t);
  } catch (error) {
    console.error("Forward auth second factor error:", error);
    return NextResponse.json({ error: t("internalServerError") }, { status: 500 });
  }
}
