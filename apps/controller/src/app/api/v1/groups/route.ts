import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { listGroups, createGroup } from "@/src/lib/models/groups";

export const GET = apiRoute(async (request: NextRequest) => {
  await requireApiUser(request);
  const allGroups = await listGroups();
  return NextResponse.json(allGroups);
});

export const POST = apiRoute(async (request: NextRequest) => {
  const { userId } = await requireApiUser(request);
  const body = await request.json();
  const group = await createGroup(body, userId);
  return NextResponse.json(group, { status: 201 });
});
