import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { getAccessList } from "@/src/lib/models/access-lists";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser(request);
    const { id } = await params;
    const list = await getAccessList(Number(id));
    if (!list) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(list.ipRules);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Replaces the list's IP rules with the array sent, in its order. */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const caller = await requireApiUser(request);
    const { id } = await params;
    const list = await submitOrApply(apiSubmitter(caller), {
      kind: "accessListRules",
      payload: { id: Number(id), rules: await request.json() },
    });
    return NextResponse.json(list.ipRules);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
