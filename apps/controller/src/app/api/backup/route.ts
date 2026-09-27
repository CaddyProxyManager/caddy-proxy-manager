import { type NextRequest, NextResponse } from "next/server";
import { checkSameOrigin, requireAdmin } from "@/src/lib/auth";
import { logAuditEvent } from "@/src/lib/audit";
import { createBackup } from "@/src/lib/backup/service";
import { backupDownload } from "@/src/lib/backup/respond";
import { backupErrorMessage } from "@/src/lib/backup/errors";

/** Settings > Backup's download. POST, so the passphrase never lands in a URL or a log. */
export async function POST(request: NextRequest) {
  const forbidden = checkSameOrigin(request);
  if (forbidden) return forbidden;
  try {
    const session = await requireAdmin();
    const body = await request.json();
    const file = await createBackup(String(body.passphrase ?? ""), {
      auditLog: body.auditLog === true,
      settingsHistory: body.settingsHistory === true,
    });
    await logAuditEvent({
      userId: Number(session.user.id),
      action: "backup_created",
      entityType: "backup",
      summary: "Downloaded a configuration backup",
    });
    return backupDownload(file);
  } catch (error) {
    return NextResponse.json({ error: await backupErrorMessage(error) }, { status: 400 });
  }
}
