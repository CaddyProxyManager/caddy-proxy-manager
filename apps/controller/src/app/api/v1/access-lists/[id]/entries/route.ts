import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const caller = await requireApiUser(request);
    const { id } = await params;
    const body = await request.json();
    const list = await submitOrApply(apiSubmitter(caller), {
      kind: "accessListEntryAdd",
      payload: { id: Number(id), entry: body },
    });
    return NextResponse.json(list, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
