import { requireCan } from "@/src/lib/users/permissions";
import { type NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import {
  FRESH_SESSION_MAX_AGE_MS,
  checkSameOrigin,
  getCurrentSessionInfo,
  isFreshSession,
} from "@/src/lib/auth";
import {
  MAX_CONFIG_BYTES,
  applyConfigImport,
  describeConfigFile,
  previewConfigImport,
} from "@/src/lib/config-transfer";
import { extractErrorMessage } from "@/src/lib/errors/action-error";

/**
 * Settings > Backup's config import. `step` is `describe` (the header, no passphrase), `preview`
 * (the dry run) or `apply`, which plans again rather than trusting the preview it followed.
 */
export async function POST(request: NextRequest) {
  const forbidden = checkSameOrigin(request);
  if (forbidden) return forbidden;
  const t = await getTranslations();
  try {
    const session = await requireCan("backups:write");
    const form = await request.formData();
    const upload = form.get("file");
    if (!(upload instanceof Blob) || upload.size === 0) {
      return NextResponse.json({ error: t("errors.configFileNotRecognised") }, { status: 400 });
    }
    if (upload.size > MAX_CONFIG_BYTES) {
      return NextResponse.json(
        { error: t("errors.configFileTooLarge", { max: "50 MiB" }) },
        { status: 413 },
      );
    }
    const file = Buffer.from(await upload.arrayBuffer());
    const passphrase = String(form.get("passphrase") ?? "");
    switch (form.get("step")) {
      case "describe":
        return NextResponse.json(describeConfigFile(file));
      case "apply":
        // Writes groups and grants; the dry run before it needs no fresh sign-in.
        if (!isFreshSession(await getCurrentSessionInfo(request))) {
          return NextResponse.json(
            {
              error: t("errors.configNeedsFreshSignIn", {
                minutes: FRESH_SESSION_MAX_AGE_MS / 60_000,
              }),
              code: "reauth-required",
            },
            { status: 403 },
          );
        }
        return NextResponse.json(
          await applyConfigImport(file, passphrase, Number(session.user.id)),
        );
      default:
        return NextResponse.json(await previewConfigImport(file, passphrase));
    }
  } catch (error) {
    return NextResponse.json(
      { error: extractErrorMessage(t, error, t("errors.configImportFailed")) },
      { status: 400 },
    );
  }
}
