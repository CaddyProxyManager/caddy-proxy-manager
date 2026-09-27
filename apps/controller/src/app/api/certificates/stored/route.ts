import { type NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { getCurrentSessionInfo, isFreshSession, requireAdmin } from "@/src/lib/auth";
import { logAuditEvent } from "@/src/lib/audit";
import { readAgentCertificate } from "@/src/lib/agent/client";

/**
 * A certificate Caddy obtained, from one agent's storage. The private key only for a recent
 * sign-in, and every key handed out is in the audit log.
 */
export async function GET(request: NextRequest) {
  const session = await requireAdmin();
  const t = await getTranslations("certificates");
  const params = request.nextUrl.searchParams;
  const includeKey = params.get("key") === "1";
  if (includeKey && !isFreshSession(await getCurrentSessionInfo(request))) {
    return NextResponse.json({ error: t("keyNeedsFreshSignIn") }, { status: 403 });
  }
  const files = await readAgentCertificate(params.get("agent") ?? "", {
    issuerKey: params.get("issuer") ?? "",
    name: params.get("name") ?? "",
    includeKey,
  }).catch(() => null);
  if (!files) return NextResponse.json({ error: t("downloadNotFound") }, { status: 404 });
  if (includeKey) {
    await logAuditEvent({
      userId: Number(session.user.id),
      action: "certificate_key_exported",
      entityType: "certificate",
      summary: `Downloaded the private key of the certificate for ${params.get("name")}`,
    });
  }
  return NextResponse.json(files, { headers: { "Cache-Control": "no-store" } });
}
