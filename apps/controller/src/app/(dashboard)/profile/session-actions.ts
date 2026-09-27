"use server";

import { revalidatePath } from "next/cache";
import { requireUser, getCurrentSessionId } from "@/src/lib/auth";
import { revokeUserSession, revokeOtherUserSessions } from "@/src/lib/models/sessions";

export async function revokeSessionAction(sessionId: number) {
  const session = await requireUser();
  const userId = Number(session.user.id);
  await revokeUserSession(userId, sessionId);
  revalidatePath("/profile");
}

/** All but the session making this request. */
export async function revokeOtherSessionsAction() {
  const session = await requireUser();
  const userId = Number(session.user.id);
  const currentId = await getCurrentSessionId();
  await revokeOtherUserSessions(userId, currentId);
  revalidatePath("/profile");
}
