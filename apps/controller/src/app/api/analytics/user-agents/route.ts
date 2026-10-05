import { type NextRequest, NextResponse } from "next/server";
import { requireApiAdmin, apiErrorResponse } from "@/src/lib/api/auth";
import { getAnalyticsUserAgents, resolveAnalyticsRange } from "@/src/lib/analytics/db";

export async function GET(req: NextRequest) {
  try {
    await requireApiAdmin(req);
    const { searchParams } = req.nextUrl;
    const hostsParam = searchParams.get("hosts") ?? "";
    const hosts = hostsParam ? hostsParam.split(",").filter(Boolean) : [];
    const { from, to } = resolveAnalyticsRange(searchParams);
    const data = await getAnalyticsUserAgents(from, to, hosts);
    return NextResponse.json(data);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
