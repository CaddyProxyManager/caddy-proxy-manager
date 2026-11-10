import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { listCrsRegistry } from "@/src/lib/models/crs-plugins";

export const GET = apiRoute(async (request: NextRequest) => {
  await requireApiUser(request);
  return NextResponse.json(await listCrsRegistry());
});
