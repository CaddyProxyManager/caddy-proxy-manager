import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { getAnalyticsBlocked, resolveAnalyticsRange } from "@/src/lib/analytics/db";

export async function GET(req: NextRequest) {
  try {
    await requireApiUser(req);
    const { searchParams } = req.nextUrl;
    const hostsParam = searchParams.get("hosts") ?? "";
    const hosts = hostsParam ? hostsParam.split(",").filter(Boolean) : [];
    const page = parseInt(searchParams.get("page") ?? "1", 10);
    const { from, to } = resolveAnalyticsRange(searchParams);
    const data = await getAnalyticsBlocked(from, to, hosts, page);
    return NextResponse.json(data);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
