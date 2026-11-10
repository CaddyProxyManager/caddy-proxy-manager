import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { addGroupMember, assertMayAddToGroup } from "@/src/lib/models/groups";

type Params = { params: Promise<{ id: string }> };

export const POST = apiRoute(async (request: NextRequest, { params }: Params) => {
  const { userId: actorUserId, access } = await requireApiUser(request);
  const { id } = await params;
  const body = await request.json();
  if (!body.userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }
  await assertMayAddToGroup(access.capabilities, Number(id));
  const group = await addGroupMember(Number(id), Number(body.userId), actorUserId);
  return NextResponse.json(group, { status: 201 });
});
