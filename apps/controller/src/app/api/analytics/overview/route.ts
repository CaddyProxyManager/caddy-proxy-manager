import { type NextRequest, NextResponse } from "next/server";
import { requireApiAdmin, apiErrorResponse } from "@/src/lib/api-auth";
import {
  getOverviewAnalytics,
  type TrafficEventFilter,
  resolveAnalyticsRange,
} from "@/src/lib/analytics-db";

const FILTERS: TrafficEventFilter[] = ["all", "server-errors", "client-errors", "largest"];
const DEFAULT_LIMIT = 40;
const DEFAULT_INTERVAL = "24h";

export async function GET(req: NextRequest) {
  try {
    await requireApiAdmin(req);
    const { searchParams } = req.nextUrl;
    const hostsParam = searchParams.get("hosts") ?? "";
    const hosts = hostsParam ? hostsParam.split(",").filter(Boolean) : [];

    // A stale client asking for a dropped filter still gets a log, not a broken pane.
    const requested = searchParams.get("filter") ?? "all";
    const filter = FILTERS.includes(requested as TrafficEventFilter)
      ? (requested as TrafficEventFilter)
      : "all";

    const limitParam = parseInt(searchParams.get("limit") ?? "", 10);
    const limit = Number.isFinite(limitParam) ? limitParam : DEFAULT_LIMIT;

    const { from, to } = resolveAnalyticsRange(searchParams, DEFAULT_INTERVAL);
    const data = await getOverviewAnalytics(from, to, hosts, filter, limit);
    return NextResponse.json(data);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
