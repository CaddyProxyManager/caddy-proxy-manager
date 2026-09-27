import { NextResponse } from "next/server";
import type { getTranslations } from "next-intl/server";
import { logAuditEvent } from "./audit";
import {
  checkHostAccess,
  consumeRedirectIntent,
  createExchangeCode,
  createForwardAuthSession,
} from "./models/forward-auth";

type ApiErrors = Awaited<ReturnType<typeof getTranslations<"auth.apiErrors">>>;

/** Finishes a portal sign-in once every factor passed: the password step, or the 2FA code step. */
export async function completePortalLogin(
  user: { id: number; email: string },
  rid: string,
  t: ApiErrors,
  headers: HeadersInit = {},
): Promise<NextResponse> {
  // One-time: the intent is deleted as it is read, and it carries the redirect URI server-side.
  const intent = await consumeRedirectIntent(rid);
  if (!intent) {
    return NextResponse.json({ error: t("invalidRedirectIntent") }, { status: 400, headers });
  }

  const targetUrl = new URL(intent.redirectUri);

  // Against the exact proxy-host audience captured by the intent. Re-resolving by hostname would
  // let a changed wildcard mapping silently change the authorization target mid-flow.
  if (!(await checkHostAccess(user.id, intent.audience.proxyHostId))) {
    await logAuditEvent({
      userId: user.id,
      action: "forward_auth_access_denied",
      entityType: "proxy_host",
      summary: `Forward auth access denied for user ${user.email} to host ${targetUrl.hostname}`,
    });
    return NextResponse.json({ error: t("noAccessToApplication") }, { status: 403, headers });
  }

  const { session } = await createForwardAuthSession(user.id, intent.audience);
  const { rawCode } = await createExchangeCode(session.id, intent.redirectUri, intent.audience);

  await logAuditEvent({
    userId: user.id,
    action: "forward_auth_login",
    entityType: "user",
    entityId: user.id,
    summary: `Forward auth login for user ${user.email} to ${targetUrl.hostname}`,
  });

  const callbackUrl = new URL("/.cpm-auth/callback", intent.audience.origin);
  callbackUrl.searchParams.set("code", rawCode);
  return NextResponse.json({ redirectTo: callbackUrl.toString() }, { headers });
}
