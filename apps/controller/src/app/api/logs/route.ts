import { type NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/src/lib/auth";
import { readAgentLog } from "@/src/lib/agent/client";
import type { LogSource } from "@/src/lib/log-view";

const SOURCES: readonly LogSource[] = ["access", "waf", "caddy"];

/**
 * One page of an agent's log for the log viewer. Admin only: access logs carry every client's
 * address and every path they asked for.
 */
export async function GET(request: NextRequest) {
  const t = await getTranslations("logs");
  await requireAdmin();
  const params = request.nextUrl.searchParams;
  const agentId = params.get("agent") ?? "";
  const source = params.get("source") as LogSource;
  if (!agentId || !SOURCES.includes(source)) {
    return NextResponse.json({ error: t("readFailed") }, { status: 400 });
  }
  const page = await readAgentLog(agentId, {
    source,
    cursor: params.get("cursor"),
    limit: Number(params.get("limit") ?? 500),
  });
  if (page === null) {
    return NextResponse.json({ error: t("agentCannotRead") }, { status: 409 });
  }
  return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
}
