import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { addGroupMember, assertMayAddToGroup } from "@/src/lib/models/groups";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { userId: actorUserId, access } = await requireApiUser(request);
    const { id } = await params;
    const body = await request.json();
    if (!body.userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }
    await assertMayAddToGroup(access.capabilities, Number(id));
    const group = await addGroupMember(Number(id), Number(body.userId), actorUserId);
    return NextResponse.json(group, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
