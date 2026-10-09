import { type NextRequest, NextResponse } from "next/server";
import { resolveL4ProxyHostId } from "@/src/lib/models/l4-proxy-hosts";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { previewL4HostChange } from "@/src/lib/host-review";

/** What PUT /api/v1/l4-proxy-hosts/{id} would change, checked and diffed but not stored. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireApiUser(request);
    const { id } = await params;
    const hostId = await resolveL4ProxyHostId(id);
    if (hostId === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const body = await request.json();
    const reverted = request.nextUrl.searchParams.getAll("revert");
    return NextResponse.json(
      await previewL4HostChange({ id: hostId, input: body, reverted }, userId),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
