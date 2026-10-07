import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { previewL4HostChange } from "@/src/lib/host-review";

/** What PUT /api/v1/l4-proxy-hosts/{id} would change, checked and diffed but not stored. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireApiUser(request);
    const { id } = await params;
    const body = await request.json();
    const reverted = request.nextUrl.searchParams.getAll("revert");
    return NextResponse.json(
      await previewL4HostChange({ id: Number(id), input: body, reverted }, userId),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
