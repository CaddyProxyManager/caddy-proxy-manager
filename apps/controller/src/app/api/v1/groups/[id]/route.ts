import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { getGroup, updateGroup, deleteGroup } from "@/src/lib/models/groups";

type Params = { params: Promise<{ id: string }> };

export const GET = apiRoute(async (request: NextRequest, { params }: Params) => {
  await requireApiUser(request);
  const { id } = await params;
  const group = await getGroup(Number(id));
  if (!group) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }
  return NextResponse.json(group);
});

export const PATCH = apiRoute(async (request: NextRequest, { params }: Params) => {
  const { userId } = await requireApiUser(request);
  const { id } = await params;
  const body = await request.json();
  const group = await updateGroup(Number(id), body, userId);
  return NextResponse.json(group);
});

export const DELETE = apiRoute(async (request: NextRequest, { params }: Params) => {
  const { userId } = await requireApiUser(request);
  const { id } = await params;
  await deleteGroup(Number(id), userId);
  return new NextResponse(null, { status: 204 });
});
