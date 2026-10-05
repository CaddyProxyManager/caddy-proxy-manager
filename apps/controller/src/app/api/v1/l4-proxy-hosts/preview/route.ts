import { type NextRequest, NextResponse } from "next/server";
import { requireApiAdmin, apiErrorResponse } from "@/src/lib/api/auth";
import { previewL4HostChange } from "@/src/lib/host-review";

/** What POST /api/v1/l4-proxy-hosts would create, checked and diffed but not stored. */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiAdmin(request);
    const body = await request.json();
    const reverted = request.nextUrl.searchParams.getAll("revert");
    return NextResponse.json(
      await previewL4HostChange({ id: null, input: body, reverted }, userId),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
