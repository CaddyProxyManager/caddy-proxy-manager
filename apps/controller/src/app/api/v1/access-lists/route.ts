import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { listAccessLists } from "@/src/lib/models/access-lists";

export async function GET(request: NextRequest) {
  try {
    await requireApiUser(request);
    const lists = await listAccessLists();
    return NextResponse.json(lists);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const caller = await requireApiUser(request);
    const body = await request.json();
    const list = await submitOrApply(apiSubmitter(caller), {
      kind: "accessListCreate",
      payload: { input: body },
    });
    return NextResponse.json(list, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
