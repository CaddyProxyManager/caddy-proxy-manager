import { type NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { checkSameOrigin, requireAdmin } from "@/src/lib/auth";
import { checkDomainReachability, isCheckableDomain } from "@/src/lib/reachability/domain";
import { askLetsDebug } from "@/src/lib/reachability/letsdebug";
import { getProxyHost } from "@/src/lib/models/proxy-hosts";

/**
 * Whether each of a host's domains reaches this Caddy over plain HTTP. `letsDebug` also sends one
 * to Let's Debug - only on request, since that tells a third party the name. Never fetches
 * anything but the host's own domains.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const forbidden = checkSameOrigin(request);
  if (forbidden) return forbidden;
  await requireAdmin();
  const t = await getTranslations("certificates");
  const { id } = await params;
  const host = await getProxyHost(Number(id));
  if (!host) return NextResponse.json({ error: t("downloadNotFound") }, { status: 404 });
  const body = await request.json().catch(() => ({}));

  const domains = host.domains.map((domain) => domain.trim().toLowerCase());
  if (typeof body.letsDebug === "string") {
    const domain = body.letsDebug.toLowerCase();
    if (!domains.includes(domain) || !isCheckableDomain(domain)) {
      return NextResponse.json({ error: t("renewInvalidName") }, { status: 400 });
    }
    return NextResponse.json({ domain, letsDebug: await askLetsDebug(domain) });
  }
  const results = await Promise.all(
    domains
      .slice(0, 20)
      .map((domain) =>
        domain.startsWith("*.") || isCheckableDomain(domain)
          ? checkDomainReachability(domain)
          : Promise.resolve(null),
      ),
  );
  return NextResponse.json({ results: results.filter(Boolean) });
}
