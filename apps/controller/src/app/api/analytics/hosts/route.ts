import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { getAnalyticsHosts } from "@/src/lib/analytics/db";

export async function GET(request: NextRequest) {
  try {
    await requireApiUser(request);
    const hosts = await getAnalyticsHosts();
    return NextResponse.json(hosts);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
