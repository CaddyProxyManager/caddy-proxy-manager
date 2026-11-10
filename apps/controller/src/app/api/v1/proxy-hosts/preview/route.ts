import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { previewProxyHostChange } from "@/src/lib/host-review";

/** What POST /api/v1/proxy-hosts would create, checked and diffed but not stored. */
export const POST = apiRoute(async (request: NextRequest) => {
  const { userId } = await requireApiUser(request);
  const body = await request.json();
  const reverted = request.nextUrl.searchParams.getAll("revert");
  return NextResponse.json(
    await previewProxyHostChange({ id: null, input: body, reverted }, userId),
  );
});
