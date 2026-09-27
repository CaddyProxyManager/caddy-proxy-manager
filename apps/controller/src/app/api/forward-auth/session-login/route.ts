import { type NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { auth } from "@/src/lib/auth";
import { isPublicOrigin } from "@/src/lib/public-url";
import {
  createForwardAuthSession,
  createExchangeCode,
  checkHostAccess,
  consumeRedirectIntent,
} from "@/src/lib/models/forward-auth";
import { logAuditEvent } from "@/src/lib/audit";

/** Turns a dashboard session into a forward auth one, for a portal visitor already signed in. */
export async function POST(request: NextRequest) {
  const t = await getTranslations("auth.apiErrors");
  try {
    // CSRF: only the portal, on whichever of this instance's own addresses served it.
    if (!(await isPublicOrigin(request.headers.get("origin")))) {
      return NextResponse.json({ error: t("forbidden") }, { status: 403 });
    }

    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: t("notAuthenticated") }, { status: 401 });
    }
    // View-as is a dashboard preview; it doesn't carry into the hosts behind forward auth.
    if (session.viewAs) {
      return NextResponse.json({ error: t("viewAsForbidden") }, { status: 403 });
    }

    const body = await request.json();
    const rid = typeof body.rid === "string" ? body.rid : "";

    if (!rid) {
      return NextResponse.json({ error: t("missingRedirectIntent") }, { status: 400 });
    }

    const intent = await consumeRedirectIntent(rid);
    if (!intent) {
      return NextResponse.json({ error: t("invalidRedirectIntent") }, { status: 400 });
    }

    const targetUrl = new URL(intent.redirectUri);
    const userId = Number(session.user.id);

    // Authorize the concrete proxy host captured by the one-time intent.
    const hasAccess = await checkHostAccess(userId, intent.audience.proxyHostId);
    if (!hasAccess) {
      await logAuditEvent({
        userId,
        action: "forward_auth_access_denied",
        entityType: "proxy_host",
        summary: `Forward auth access denied for user ${session.user.email} to host ${targetUrl.hostname}`,
      });
      return NextResponse.json({ error: t("noAccessToApplication") }, { status: 403 });
    }

    const { session: faSession } = await createForwardAuthSession(userId, intent.audience);
    const { rawCode } = await createExchangeCode(faSession.id, intent.redirectUri, intent.audience);

    await logAuditEvent({
      userId,
      action: "forward_auth_login",
      entityType: "user",
      entityId: userId,
      summary: `Forward auth login (session) for user ${session.user.email} to ${targetUrl.hostname}`,
    });

    const callbackUrl = new URL("/.cpm-auth/callback", intent.audience.origin);
    callbackUrl.searchParams.set("code", rawCode);

    return NextResponse.json({ redirectTo: callbackUrl.toString() });
  } catch (error) {
    console.error("Forward auth session login error:", error);
    return NextResponse.json({ error: t("internalServerError") }, { status: 500 });
  }
}
