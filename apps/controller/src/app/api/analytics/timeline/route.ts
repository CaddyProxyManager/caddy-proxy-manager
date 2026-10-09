import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser } from "@/src/lib/api/auth";
import { analyticsErrorResponse } from "@/src/lib/analytics/api-error";
import { getAnalyticsTimeline, resolveAnalyticsRange } from "@/src/lib/analytics/db";

export async function GET(req: NextRequest) {
  try {
    await requireApiUser(req);
    const { searchParams } = req.nextUrl;
    const hostsParam = searchParams.get("hosts") ?? "";
    const hosts = hostsParam ? hostsParam.split(",").filter(Boolean) : [];
    const { from, to } = resolveAnalyticsRange(searchParams);
    const data = await getAnalyticsTimeline(from, to, hosts);
    return NextResponse.json(data);
  } catch (error) {
    return analyticsErrorResponse(error);
  }
}
