import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import {
  listForwardAuthSessions,
  deleteUserForwardAuthSessions,
} from "@/src/lib/models/forward-auth";

export const GET = apiRoute(async (request: NextRequest) => {
  await requireApiUser(request);
  const sessions = await listForwardAuthSessions();
  return NextResponse.json(sessions);
});

export const DELETE = apiRoute(async (request: NextRequest) => {
  await requireApiUser(request);
  const userId = request.nextUrl.searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "userId query parameter is required" }, { status: 400 });
  }
  await deleteUserForwardAuthSessions(Number(userId));
  return new NextResponse(null, { status: 204 });
});
