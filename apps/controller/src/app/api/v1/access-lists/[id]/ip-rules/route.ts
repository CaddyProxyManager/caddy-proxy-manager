import { type NextRequest, NextResponse } from "next/server";
import { requireApiAdmin, apiErrorResponse } from "@/src/lib/api-auth";
import { getAccessList, setAccessListIpRules } from "@/src/lib/models/access-lists";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireApiAdmin(request);
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
    const { userId } = await requireApiAdmin(request);
    const { id } = await params;
    const list = await setAccessListIpRules(Number(id), await request.json(), userId);
    return NextResponse.json(list.ipRules);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
