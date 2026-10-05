import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { deleteApiToken } from "@/src/lib/models/api-tokens";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId, role } = await requireApiUser(request);
    const { id } = await params;
    await deleteApiToken(Number(id), userId, role === "admin");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
