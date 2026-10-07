import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { getCampaign } from "@/src/lib/access-reviews";
import { campaignCsvRows } from "@/src/lib/access-reviews/csv";
import { logAuditEvent } from "@/src/lib/audit";
import { listRoles } from "@/src/lib/roles/store";
import { requireCanAccess } from "@/src/lib/users/permissions";
import { csvFileName, toCsv } from "@/src/app/(dashboard)/analytics/explore/csv";

const BUILT_IN = ["admin", "operator", "user", "viewer"] as const;

/** Every item and decision of one campaign, as CSV. Audited: it lists who holds what. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { session, access } = await requireCanAccess("users:read");
  const [t, tUsers, tRoot, roles] = await Promise.all([
    getTranslations("accessReviews"),
    getTranslations("users"),
    getTranslations(),
    listRoles(),
  ]);
  const detail = await getCampaign(Number((await params).id), access);
  if (!detail) return NextResponse.json({ error: t("notFound") }, { status: 404 });
  const names = new Map(roles.map((role) => [role.key, role.name]));
  const { header, rows } = campaignCsvRows(detail.items, {
    header: (column) => t(`csv.${column}`),
    value: (kind, value) => {
      if (kind !== "role") return value;
      return (BUILT_IN as readonly string[]).includes(value)
        ? tUsers(`roles.${value as (typeof BUILT_IN)[number]}`)
        : (names.get(value) ?? value);
    },
    reason: (code) => {
      const key = `errors.${code}`;
      return tRoot.has(key as never) ? tRoot(key as never) : code;
    },
  });
  await logAuditEvent({
    userId: Number(session.user.id),
    action: "access_review_exported",
    entityType: "access_review",
    entityId: detail.campaign.id,
    summary: `Exported access review ${detail.campaign.name}`,
  });
  // A BOM, so a spreadsheet reads the UTF-8 rather than guessing a legacy code page.
  return new NextResponse(String.fromCharCode(0xfeff) + toCsv(header, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFileName("access-review", detail.campaign.name)}"`,
      "Cache-Control": "no-store",
    },
  });
}
