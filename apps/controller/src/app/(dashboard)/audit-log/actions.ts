"use server";

import { requireCan } from "@/src/lib/users/permissions";
import { getTranslations } from "next-intl/server";
import { logAuditEvent } from "@/src/lib/audit";
import { verifyAuditChain } from "@/src/lib/audit/chain";
import { extractErrorMessage } from "@/src/lib/errors/action-error";
import type { VerifyChainResult } from "./AuditLogClient";

export async function verifyAuditChainAction(): Promise<VerifyChainResult> {
  const t = await getTranslations();
  try {
    const session = await requireCan("audit:write");
    const verification = await verifyAuditChain();
    // After the check, so this event is the next one the following check covers.
    await logAuditEvent({
      userId: Number(session.user.id),
      action: "audit_verified",
      entityType: "audit_log",
      summary: "Verified the audit log's hash chain",
      data: {
        ok: verification.ok,
        checked: verification.checked,
        firstBroken: verification.firstBroken,
      },
    });
    return { ok: true, verification };
  } catch (error) {
    console.error("Failed to verify the audit log:", error);
    return { ok: false, message: extractErrorMessage(t, error, t("errors.auditVerifyFailed")) };
  }
}
