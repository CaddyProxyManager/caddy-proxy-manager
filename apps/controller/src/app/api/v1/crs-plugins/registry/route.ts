import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { listCrsRegistry } from "@/src/lib/models/crs-plugins";

export async function GET(request: NextRequest) {
  try {
    await requireApiUser(request);
    return NextResponse.json(await listCrsRegistry());
  } catch (error) {
    return apiErrorResponse(error);
  }
}
