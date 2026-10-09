import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/src/lib/api/auth";
import { ANALYTICS_STARTING, analyticsStarting } from "./starting";

/** apiErrorResponse, except that ClickHouse still starting is a 503 the pages show as a wait. */
export function analyticsErrorResponse(error: unknown): NextResponse {
  if (analyticsStarting(error)) {
    return NextResponse.json(
      { error: "Analytics is still starting", code: ANALYTICS_STARTING },
      { status: 503 },
    );
  }
  return apiErrorResponse(error);
}
