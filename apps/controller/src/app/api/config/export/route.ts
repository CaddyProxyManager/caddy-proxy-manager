import { type NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { checkSameOrigin, requireAdmin } from "@/src/lib/auth";
import {
  CONFIG_SECTIONS,
  type ConfigSection,
  exportConfigAudited,
} from "@/src/lib/config-transfer";
import { extractErrorMessage } from "@/src/lib/errors/action-error";

/** Settings > Backup's config export. POST, so the passphrase never lands in a URL or a log. */
export async function POST(request: NextRequest) {
  const forbidden = checkSameOrigin(request);
  if (forbidden) return forbidden;
  try {
    const session = await requireAdmin();
    const body = await request.json();
    const sections = Array.isArray(body.sections)
      ? body.sections.filter((s: unknown): s is ConfigSection =>
          CONFIG_SECTIONS.includes(s as ConfigSection),
        )
      : undefined;
    const file = await exportConfigAudited(
      String(body.passphrase ?? ""),
      { sections },
      Number(session.user.id),
    );
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="cpm-config-${stamp}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const t = await getTranslations();
    return NextResponse.json(
      { error: extractErrorMessage(t, error, t("errors.configExportFailed")) },
      { status: 400 },
    );
  }
}
