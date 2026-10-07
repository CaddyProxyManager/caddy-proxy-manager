import { requireCan } from "@/src/lib/users/permissions";
import type { CaddyCertificate } from "@cpm/shared";
import { type NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { checkSameOrigin } from "@/src/lib/auth";
import { logAuditEvent } from "@/src/lib/audit";
import { listAgentCertificates } from "@/src/lib/agent/client";
import { connectedAgents } from "@/src/lib/agent/registry";
import { applyCaddyConfig } from "@/src/lib/caddy";
import { requestRenewal, withEviction } from "@/src/lib/certificates/renewals";
import { isCheckableDomain } from "@/src/lib/reachability/domain";

/** The newest certificate for a name in one agent's storage. */
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

/** A host's names together, so the eviction reload happens once. */
export async function POST(request: NextRequest) {
  const forbidden = checkSameOrigin(request);
  if (forbidden) return forbidden;
  const session = await requireCan("certificates:write");
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
  // Every agent loads the name; one without the certificates capability just can't settle early.
  const inventories = new Map(
    (await listAgentCertificates().catch(() => [])).map((a) => [a.agentId, a.certificates ?? []]),
  );
  const agents = connectedAgents().map((agent) => agent.agentId);
  for (const name of names) {
    const targets = (agents.length > 0 ? agents : [""]).map((agent) => ({
      agent,
      current: currentCertificate(inventories.get(agent) ?? [], name) ?? hint,
    }));
    requestRenewal(name, targets);
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
