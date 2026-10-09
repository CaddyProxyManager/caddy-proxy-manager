import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser } from "@/src/lib/api/auth";
import { analyticsErrorResponse } from "@/src/lib/analytics/api-error";
import { getAnalyticsHosts } from "@/src/lib/analytics/db";

export async function GET(request: NextRequest) {
  try {
    await requireApiUser(request);
    const hosts = await getAnalyticsHosts();
    return NextResponse.json(hosts);
  } catch (error) {
    return analyticsErrorResponse(error);
  }
}
