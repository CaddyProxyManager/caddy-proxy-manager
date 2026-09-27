import type { CaddyCertificate } from "@cpm/shared";
import { type NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { checkSameOrigin, requireAdmin } from "@/src/lib/auth";
import { logAuditEvent } from "@/src/lib/audit";
import { listAgentCertificates } from "@/src/lib/agent/client";
import { applyCaddyConfig } from "@/src/lib/caddy";
import { requestRenewal, withEviction } from "@/src/lib/certificate-renewals";
import { isCheckableDomain } from "@/src/lib/domain-reachability";

/** The newest certificate for a name in any agent's storage. */
function currentCertificate(stored: CaddyCertificate[], name: string) {
  return stored
    .filter((cert) => cert.names.some((n) => n.toLowerCase() === name))
    .sort((a, b) => Date.parse(b.notAfter) - Date.parse(a.notAfter))[0];
}

/** No agent to ask: the caller may say which certificate it means; it only shapes the window. */
function datesFrom(body: { notBefore?: unknown; notAfter?: unknown }) {
  return typeof body.notBefore === "string" && typeof body.notAfter === "string"
    ? { notBefore: body.notBefore, notAfter: body.notAfter }
    : null;
}

/**
 * "Renew now" for a host's names - together, so the eviction reload happens once. The Certificates
 * page then watches the inventory for the new certificates.
 */
export async function POST(request: NextRequest) {
  const forbidden = checkSameOrigin(request);
  if (forbidden) return forbidden;
  const session = await requireAdmin();
  const t = await getTranslations("certificates");
  const body = await request.json().catch(() => ({}));
  const requested: unknown[] = Array.isArray(body.names) ? body.names : [body.name];
  const names = [
    ...new Set(requested.map((n) => (typeof n === "string" ? n.trim().toLowerCase() : ""))),
  ];
  if (names.length === 0 || names.length > 20 || !names.every(isCheckableDomain)) {
    return NextResponse.json({ error: t("renewInvalidName") }, { status: 400 });
  }
  // Dates from the caller only mean something for a single name.
  const hint = names.length === 1 ? datesFrom(body) : null;
  const stored = (await listAgentCertificates().catch(() => [])).flatMap(
    (agent) => agent.certificates ?? [],
  );
  for (const name of names) {
    requestRenewal(name, currentCertificate(stored, name) ?? hint);
    await logAuditEvent({
      userId: Number(session.user.id),
      action: "certificate_renew_requested",
      entityType: "certificate",
      summary: `Asked Caddy to renew the certificate for ${name}`,
    });
  }
  try {
    await withEviction(names, applyCaddyConfig).catch((error) =>
      console.error("[certificates] Evicting a renewing name failed:", error),
    );
    await applyCaddyConfig();
  } catch (error) {
    console.error("[certificates] Applying a renewal failed:", error);
    return NextResponse.json({ error: t("renewApplyFailed") }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
