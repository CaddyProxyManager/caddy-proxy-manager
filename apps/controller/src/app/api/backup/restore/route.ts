import { type NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import {
  FRESH_SESSION_MAX_AGE_MS,
  checkSameOrigin,
  getCurrentSessionInfo,
  isFreshSession,
  requireAdmin,
} from "@/src/lib/auth";
import { logAuditEvent } from "@/src/lib/audit";
import { invalidateProviderCache } from "@/src/lib/auth-server";
import { applyCaddyConfig } from "@/src/lib/caddy";
import { describeBackup, restoreBackup } from "@/src/lib/backup/service";
import { backupErrorMessage } from "@/src/lib/backup/errors";
import { invalidateSettingsCache } from "@/src/lib/settings/resolve";

/** Large enough for years of audit log; small enough that a stray upload can't fill memory. */
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

/**
 * Settings > Backup's restore; `preview` only reads the header. A real restore replaces every
 * account, so it needs a recent sign-in, not just a session left open on someone's desk.
 */
export async function POST(request: NextRequest) {
  const forbidden = checkSameOrigin(request);
  if (forbidden) return forbidden;
  const t = await getTranslations("errors");
  try {
    const session = await requireAdmin();
    const form = await request.formData();
    const upload = form.get("file");
    if (!(upload instanceof Blob) || upload.size === 0) {
      return NextResponse.json({ error: t("backupNotRecognised") }, { status: 400 });
    }
    if (upload.size > MAX_BACKUP_BYTES) {
      return NextResponse.json({ error: t("backupTooLarge") }, { status: 413 });
    }
    const file = Buffer.from(await upload.arrayBuffer());

    if (form.get("preview") === "1") {
      return NextResponse.json(describeBackup(file));
    }

    if (!isFreshSession(await getCurrentSessionInfo(request))) {
      return NextResponse.json(
        {
          error: t("backupRestoreNeedsFreshSignIn", {
            minutes: FRESH_SESSION_MAX_AGE_MS / 60_000,
          }),
          code: "reauth-required",
        },
        { status: 403 },
      );
    }

    const result = await restoreBackup(file, String(form.get("passphrase") ?? ""), {
      keepAgents: form.get("keepAgents") === "1",
    });

    // Written after the restore, so the entry survives it; the actor may not, if the backup's
    // users differ, which is why the id is also in the summary's data.
    await logAuditEvent({
      userId: null,
      action: "backup_restored",
      entityType: "backup",
      summary: "Restored the configuration from a backup",
      data: { restoredBy: Number(session.user.id), ...result },
    });
    invalidateSettingsCache();
    invalidateProviderCache();
    await applyCaddyConfig().catch((error) =>
      console.error("[backup] Applying the restored configuration failed:", error),
    );
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: await backupErrorMessage(error) }, { status: 400 });
  }
}
