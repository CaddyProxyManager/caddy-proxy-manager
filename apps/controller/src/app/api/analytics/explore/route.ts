import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { getAnalyticsReport } from "@/src/lib/analytics/explore";
import { parseExploreState } from "@/src/lib/analytics/explore-state";

/** The analytics page's query string in, the whole page's data out. */
export async function GET(req: NextRequest) {
  try {
    await requireApiUser(req);
    const report = await getAnalyticsReport(parseExploreState(req.nextUrl.searchParams));
    return NextResponse.json(report);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
