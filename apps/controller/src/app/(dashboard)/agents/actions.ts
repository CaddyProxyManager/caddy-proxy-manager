"use server";

/**
 * Only rebuild and rename per agent: pairing and disabling are fleet questions, so they stay on
 * Settings, which needs `agents:write` over every agent.
 */

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import {
  type ActionState,
  INITIAL_ACTION_STATE,
  actionError,
  actionSuccess,
} from "@/src/lib/errors/action-error";
import { agentStatusMessage } from "@/src/lib/agent/status-message";
import { applyCaddyBuild } from "@/src/lib/caddy/image-build";
import { renameAgent } from "@/src/lib/models/agents";
import { assertCanManage, requireReach } from "@/src/lib/users/permissions";

export async function rebuildAgentCaddyAction(
  agentRowId: number,
  _prevState: ActionState = INITIAL_ACTION_STATE,
): Promise<ActionState> {
  void _prevState;
  try {
    const access = await requireReach("agents:write");
    assertCanManage(access, "agent", agentRowId);
    const status = await applyCaddyBuild(agentRowId);
    revalidatePath("/agents");
    const t = await getTranslations();
    return actionSuccess(agentStatusMessage(t, status) ?? t("settings.results.rebuildTriggered"));
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to trigger a Caddy rebuild for agent:", agentRowId, error);
    return actionError(t, error, t("errors.rebuildCaddyFailed"));
  }
}

export async function renameAgentAction(
  agentRowId: number,
  _prevState: ActionState = INITIAL_ACTION_STATE,
  formData?: FormData,
): Promise<ActionState> {
  void _prevState;
  try {
    const access = await requireReach("agents:write");
    assertCanManage(access, "agent", agentRowId);
    const name = String(formData?.get("name") ?? "").trim();
    const t = await getTranslations();
    if (!name) return actionError(t, null, t("agents.nameRequired"));
    await renameAgent(agentRowId, name);
    revalidatePath("/agents");
    return actionSuccess(t("agents.renamed"));
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to rename agent:", agentRowId, error);
    return actionError(t, error, t("errors.renameAgentFailed"));
  }
}
