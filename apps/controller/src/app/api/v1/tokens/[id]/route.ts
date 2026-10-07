import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { deleteApiToken } from "@/src/lib/models/api-tokens";
import { can } from "@/src/lib/users/permissions";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId, access } = await requireApiUser(request);
    const { id } = await params;
    await deleteApiToken(Number(id), userId, can(access, "tokens:write"));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
