import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; entryId: string }> },
) {
  try {
    const caller = await requireApiUser(request);
    const { id, entryId } = await params;
    const list = await submitOrApply(apiSubmitter(caller), {
      kind: "accessListEntryRemove",
      payload: { id: Number(id), entryIds: [Number(entryId)] },
    });
    return NextResponse.json(list);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
