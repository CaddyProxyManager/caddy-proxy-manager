import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { applyCaddyConfig } from "@/src/lib/caddy";

export const POST = apiRoute(async (request: NextRequest) => {
  await requireApiUser(request);
  await applyCaddyConfig();
  return NextResponse.json({ ok: true });
});
