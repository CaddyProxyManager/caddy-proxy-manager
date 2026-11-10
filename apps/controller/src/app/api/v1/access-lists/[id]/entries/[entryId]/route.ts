import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";

export const DELETE = apiRoute(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string; entryId: string }> },
  ) => {
    const caller = await requireApiUser(request);
    const { id, entryId } = await params;
    const list = await submitOrApply(apiSubmitter(caller), {
      kind: "accessListEntryRemove",
      payload: { id: Number(id), entryIds: [Number(entryId)] },
    });
    return NextResponse.json(list);
  },
);
