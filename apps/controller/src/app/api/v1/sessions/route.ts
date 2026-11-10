import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { getCurrentSessionId } from "@/src/lib/auth";
import { listUserSessions, revokeOtherUserSessions } from "@/src/lib/models/sessions";

/** GET /api/v1/sessions - list the authenticated user's active sessions. */
export const GET = apiRoute(async (request: NextRequest) => {
  const { userId } = await requireApiUser(request);
  const [list, currentId] = await Promise.all([
    listUserSessions(userId),
    getCurrentSessionId(request),
  ]);
  return NextResponse.json(list.map((s) => ({ ...s, current: s.id === currentId })));
});

/** DELETE /api/v1/sessions - revoke all of the user's OTHER sessions. */
export const DELETE = apiRoute(async (request: NextRequest) => {
  const { userId } = await requireApiUser(request);
  const currentId = await getCurrentSessionId(request);
  const revoked = await revokeOtherUserSessions(userId, currentId);
  return NextResponse.json({ revoked });
});
