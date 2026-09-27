/** Sets the password an emailed link was for. The link is spent only once the password passes. */

import type { NextRequest } from "next/server";
import { getTranslations } from "next-intl/server";
import { checkSameOrigin } from "@/src/lib/auth";
import { getClientIp } from "@/src/lib/client-ip";
import { DomainError } from "@/src/lib/domain-error";
import { passwordPolicyMessage } from "@/src/lib/password-policy-message";
import { takeFromWindow } from "@/src/lib/rate-limit";
import { completeEmailedLink } from "@/src/lib/services/emailed-links";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const originCheck = checkSameOrigin(request);
  if (originCheck) return originCheck;

  const t = await getTranslations();
  const ip = await getClientIp(request.headers);
  if (!takeFromWindow(`password-link:complete:${ip ?? "unknown"}`, 10, 15 * 60_000)) {
    return Response.json(
      { code: "TOO_MANY_REQUESTS", error: t("auth.apiErrors.tooManyAttempts") },
      { status: 429 },
    );
  }

  let body: { token?: unknown; password?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ code: "BAD_REQUEST" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token : "";
  const password = typeof body.password === "string" ? body.password : "";

  const policyError = passwordPolicyMessage(t, password, t("passwordPolicy.subject.newPassword"));
  if (policyError) {
    return Response.json({ code: "PASSWORD_POLICY", error: policyError }, { status: 400 });
  }

  try {
    const { purpose } = await completeEmailedLink(token, password);
    return Response.json({ ok: true, purpose });
  } catch (error) {
    if (error instanceof DomainError && error.code === "passwordLinkInvalid") {
      return Response.json(
        { code: "INVALID_LINK", error: t("errors.passwordLinkInvalid") },
        { status: 404 },
      );
    }
    console.error("[password-reset] Could not set the password:", error);
    return Response.json(
      { code: "FAILED", error: t("auth.passwordReset.failed") },
      { status: 500 },
    );
  }
}
