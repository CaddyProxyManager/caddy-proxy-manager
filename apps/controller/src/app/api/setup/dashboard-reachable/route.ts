import type { NextRequest } from "next/server";
import { auth } from "@/src/lib/auth";
import { dashboardHostAnswers } from "@/src/lib/dashboard-host";
import { getDashboardSettings } from "@/src/lib/settings";

/**
 * Server-side because a browser cannot read a cross-origin response. Admin-gated since it fetches
 * a URL, and only the stored, validated domain - nothing the caller sends.
 */
export async function GET(request: NextRequest): Promise<Response> {
  if ((await auth(request))?.user.role !== "admin") {
    return Response.json({ ok: false }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const ok = await dashboardHostAnswers(await getDashboardSettings());
  return Response.json({ ok }, { headers: { "Cache-Control": "no-store" } });
}
