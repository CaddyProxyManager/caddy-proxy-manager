import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { resolveAnalyticsRange } from "@/src/lib/analytics/db";
import {
  countWafEventsInRange,
  getTopWafRulesWithHosts,
  getWafEventCountries,
} from "@/src/lib/models/waf-events";

export async function GET(req: NextRequest) {
  try {
    await requireApiUser(req);
    const { from, to } = resolveAnalyticsRange(req.nextUrl.searchParams);
    const [total, topRules, byCountry] = await Promise.all([
      countWafEventsInRange(from, to),
      getTopWafRulesWithHosts(from, to, 10),
      getWafEventCountries(from, to),
    ]);
    return NextResponse.json({ total, topRules, byCountry });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
