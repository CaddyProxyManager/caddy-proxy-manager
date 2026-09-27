import { type NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { getCurrentSessionInfo, isFreshSession, requireAdmin } from "@/src/lib/auth";
import { logAuditEvent } from "@/src/lib/audit";
import { getCertificate } from "@/src/lib/models/certificates";

/** An imported certificate's PEM, and its key under the same rules as a stored one's. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  const t = await getTranslations("certificates");
  const { id } = await params;
  const includeKey = request.nextUrl.searchParams.get("key") === "1";
  if (includeKey && !isFreshSession(await getCurrentSessionInfo(request))) {
    return NextResponse.json({ error: t("keyNeedsFreshSignIn") }, { status: 403 });
  }
  const certificate = await getCertificate(Number(id));
  if (!certificate?.certificatePem) {
    return NextResponse.json({ error: t("downloadNotFound") }, { status: 404 });
  }
  if (includeKey) {
    await logAuditEvent({
      userId: Number(session.user.id),
      action: "certificate_key_exported",
      entityType: "certificate",
      entityId: certificate.id,
      summary: `Downloaded the private key of the certificate for ${certificate.name}`,
    });
  }
  return NextResponse.json(
    {
      certificatePem: certificate.certificatePem,
      ...(includeKey && certificate.privateKeyPem && { keyPem: certificate.privateKeyPem }),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
