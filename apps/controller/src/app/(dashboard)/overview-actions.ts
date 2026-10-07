"use server";

/**
 * The overview's Needs attention and setup checklist. Loaded after the page renders: a provider
 * may take its whole budget, and the rest of the overview should not wait for it.
 */

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { collectAttention } from "@/src/lib/attention";
import type { AttentionList } from "@/src/lib/attention/types";
import { actionError, actionSuccess, type ActionState } from "@/src/lib/errors/action-error";
import {
  getSetupChecklist,
  setSetupChecklistHidden,
  setSetupStepDone,
  type SetupChecklist,
} from "@/src/lib/setup-checklist";
import { can, currentAccess, requireCan } from "@/src/lib/users/permissions";

export async function loadAttentionAction(): Promise<AttentionList | null> {
  const { access } = await currentAccess();
  try {
    return await collectAttention(access);
  } catch (error) {
    console.error("Failed to collect Needs attention:", error);
    return null;
  }
}

export async function loadSetupChecklistAction(): Promise<SetupChecklist | null> {
  const { access } = await currentAccess();
  if (!can(access, "overview:read")) return null;
  try {
    return await getSetupChecklist();
  } catch (error) {
    console.error("Failed to read the setup checklist:", error);
    return null;
  }
}

export async function setSetupStepDoneAction(step: string, done: boolean): Promise<ActionState> {
  try {
    const session = await requireCan("overview:write");
    await setSetupStepDone(step, done, Number(session.user.id));
    revalidatePath("/");
    return actionSuccess();
  } catch (error) {
    const t = await getTranslations();
    return actionError(t, error, t("errors.setupChecklistFailed"));
  }
}

export async function setSetupChecklistHiddenAction(hidden: boolean): Promise<ActionState> {
  try {
    const session = await requireCan("overview:write");
    await setSetupChecklistHidden(hidden, Number(session.user.id));
    revalidatePath("/");
    return actionSuccess();
  } catch (error) {
    const t = await getTranslations();
    return actionError(t, error, t("errors.setupChecklistFailed"));
  }
}
