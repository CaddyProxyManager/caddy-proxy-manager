import { type NextRequest, NextResponse } from "next/server";
import { requireApiAdmin, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { getAnalyticsCountryBreakdown, resolveAnalyticsRange } from "@/src/lib/analytics-db";

/**
 * One country's breakdown. Anything but two capitals is a 400, not a query matching nothing; "XX"
 * is how the countries list names requests GeoIP could not place.
 */
export async function GET(req: NextRequest) {
  try {
    await requireApiAdmin(req);
    const { searchParams } = req.nextUrl;
    const code = (searchParams.get("code") ?? "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) {
      throw new ApiValidationError("code must be a two-letter country code");
    }
    const hostsParam = searchParams.get("hosts") ?? "";
    const hosts = hostsParam ? hostsParam.split(",").filter(Boolean) : [];
    const { from, to } = resolveAnalyticsRange(searchParams);
    const data = await getAnalyticsCountryBreakdown(from, to, hosts, code);
    return NextResponse.json(data);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
