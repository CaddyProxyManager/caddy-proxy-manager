"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { requireUser, getCurrentSessionId } from "@/src/lib/auth";
import { revokeUserSession, revokeOtherUserSessions } from "@/src/lib/models/sessions";

// Bare form actions: there is nowhere to show a failure, and a thrown one would crash the page.

export async function revokeSessionAction(sessionId: number): Promise<void> {
  try {
    const session = await requireUser();
    const userId = Number(session.user.id);
    await revokeUserSession(userId, sessionId);
    revalidatePath("/profile");
  } catch (error) {
    unstable_rethrow(error);
    console.error("Failed to revoke a session:", error);
  }
}

/** All but the session making this request. */
export async function revokeOtherSessionsAction(): Promise<void> {
  try {
    const session = await requireUser();
    const userId = Number(session.user.id);
    const currentId = await getCurrentSessionId();
    await revokeOtherUserSessions(userId, currentId);
    revalidatePath("/profile");
  } catch (error) {
    unstable_rethrow(error);
    console.error("Failed to revoke the other sessions:", error);
  }
}
