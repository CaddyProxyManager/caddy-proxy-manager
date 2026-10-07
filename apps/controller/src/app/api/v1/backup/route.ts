import type { NextRequest } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { logAuditEvent } from "@/src/lib/audit";
import { createBackup } from "@/src/lib/backup/service";
import { backupDownload } from "@/src/lib/backup/respond";

/**
 * For scripts and cron. POST, so the passphrase stays out of the query string; restoring stays
 * in the UI, behind a recent sign-in.
 */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiUser(request);
    const body = await request.json().catch(() => ({}));
    const file = await createBackup(String(body.passphrase ?? ""), {
      auditLog: body.auditLog === true,
      settingsHistory: body.settingsHistory === true,
    });
    await logAuditEvent({
      userId,
      action: "backup_created",
      entityType: "backup",
      summary: "Downloaded a configuration backup",
    });
    return backupDownload(file);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
