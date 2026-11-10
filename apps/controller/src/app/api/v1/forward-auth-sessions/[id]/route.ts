import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { deleteForwardAuthSession } from "@/src/lib/models/forward-auth";

type Params = { params: Promise<{ id: string }> };

export const DELETE = apiRoute(async (request: NextRequest, { params }: Params) => {
  await requireApiUser(request);
  const { id } = await params;
  await deleteForwardAuthSession(Number(id));
  return new NextResponse(null, { status: 204 });
});
