import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser } from "@/src/lib/api/auth";
import { analyticsErrorResponse } from "@/src/lib/analytics/api-error";
import { getAnalyticsTopList } from "@/src/lib/analytics/explore";
import {
  TOP_DIMENSIONS,
  parseExploreState,
  type TopDimension,
} from "@/src/lib/analytics/explore-state";

/** One top list at "view all" length, under the same filters as the page. */
export async function GET(req: NextRequest) {
  try {
    await requireApiUser(req);
    const { searchParams } = req.nextUrl;
    const dimension = searchParams.get("dimension");
    if (!(TOP_DIMENSIONS as readonly (string | null)[]).includes(dimension)) {
      return NextResponse.json(
        { error: "Unknown dimension", code: "ANALYTICS_UNKNOWN_DIMENSION" },
        { status: 400 },
      );
    }
    const rows = await getAnalyticsTopList(
      parseExploreState(searchParams),
      dimension as TopDimension,
    );
    return NextResponse.json(rows);
  } catch (error) {
    return analyticsErrorResponse(error);
  }
}
