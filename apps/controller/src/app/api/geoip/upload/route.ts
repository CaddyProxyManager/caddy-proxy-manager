import { type NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { checkSameOrigin } from "@/src/lib/auth";
import { extractErrorMessage } from "@/src/lib/errors/action-error";
import { domainErrorOf } from "@/src/lib/errors/domain-error";
import { isGeoipEdition, uploadGeoipDatabase } from "@/src/lib/geoip/upload";
import { ForbiddenError, requireCan } from "@/src/lib/users/permissions";

/**
 * Settings > Geo-blocking's upload, for a deployment that cannot reach MaxMind. A route, not an
 * action: City runs to tens of megabytes, past what an action body takes.
 */
export async function POST(request: NextRequest) {
  const forbidden = checkSameOrigin(request);
  if (forbidden) return forbidden;
  const [t, tErrors] = await Promise.all([getTranslations(), getTranslations("errors")]);
  try {
    const session = await requireCan("settings:write");
    const form = await request.formData();
    const edition = form.get("edition");
    const file = form.get("file");
    if (!isGeoipEdition(edition) || !(file instanceof Blob) || file.size === 0) {
      return NextResponse.json({ error: tErrors("geoipUploadMissing") }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { build } = await uploadGeoipDatabase(edition, bytes, Number(session.user.id));
    return NextResponse.json({ edition, build });
  } catch (error) {
    const domain = domainErrorOf(error);
    if (!domain) console.error("[geoip] upload failed:", error);
    return NextResponse.json(
      { error: extractErrorMessage(t, error, tErrors("geoipUploadFailed")) },
      { status: error instanceof ForbiddenError ? 403 : (domain?.status ?? 500) },
    );
  }
}
