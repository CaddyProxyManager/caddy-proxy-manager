import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { removeGroupMember } from "@/src/lib/models/groups";

type Params = { params: Promise<{ id: string; userId: string }> };

export const DELETE = apiRoute(async (request: NextRequest, { params }: Params) => {
  const { userId: actorUserId } = await requireApiUser(request);
  const { id, userId } = await params;
  const group = await removeGroupMember(Number(id), Number(userId), actorUserId);
  return NextResponse.json(group);
});
