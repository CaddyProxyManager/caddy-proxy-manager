import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { applyCaddyConfig } from "@/src/lib/caddy";

export async function POST(request: NextRequest) {
  try {
    await requireApiUser(request);
    await applyCaddyConfig();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
