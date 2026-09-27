"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { type ActionState, actionError, actionSuccess } from "@/src/lib/actions";
import { logAuditEvent } from "@/src/lib/audit";
import { getCurrentSessionId, requireUser } from "@/src/lib/auth";
import { domainError } from "@/src/lib/domain-error";
import { startViewAs, stopViewAs } from "@/src/lib/view-as";

async function startViewAsActionUntranslated(role: string, groupIds: number[]) {
  const session = await requireUser();
  if (session.viewAs) throw domainError("viewAsAlreadyActive");
  if (session.user.role !== "admin") throw domainError("adminRequired");
  const sessionId = await getCurrentSessionId();
  // A bearer token has no session to narrow.
  if (sessionId === null) throw domainError("adminRequired");

  const view = await startViewAs(sessionId, role, groupIds);
  await logAuditEvent({
    userId: Number(session.user.id),
    action: "view_as_started",
    entityType: "session",
    entityId: sessionId,
    summary: `Started viewing the dashboard as ${view.role}`,
    data: { groupIds: view.groupIds },
  });
  revalidatePath("/", "layout");
}

export async function startViewAsAction(role: string, groupIds: number[]): Promise<ActionState> {
  try {
    await startViewAsActionUntranslated(role, groupIds);
    return actionSuccess();
  } catch (error) {
    const t = await getTranslations();
    return actionError(t, error, t("errors.viewAsStartFailed"));
  }
}

/** Open to any session: all it can do is put the caller back to their own role. */
export async function stopViewAsAction(): Promise<void> {
  const session = await requireUser();
  const sessionId = await getCurrentSessionId();
  if (!session.viewAs || sessionId === null) return;
  await stopViewAs(sessionId);
  await logAuditEvent({
    userId: Number(session.user.id),
    action: "view_as_stopped",
    entityType: "session",
    entityId: sessionId,
    summary: `Stopped viewing the dashboard as ${session.viewAs.role}`,
  });
  revalidatePath("/", "layout");
}
