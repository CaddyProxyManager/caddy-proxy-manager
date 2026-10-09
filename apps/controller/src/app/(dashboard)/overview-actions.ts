"use server";

/**
 * The overview's Needs attention and setup checklist. Loaded after the page renders: a provider
 * may take its whole budget, and the rest of the overview should not wait for it.
 */

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { collectAttention } from "@/src/lib/attention";
import {
  acknowledgeAttention,
  getAcknowledgements,
  withoutAcknowledged,
} from "@/src/lib/attention/acknowledged";
import type { OverviewAttention } from "@/src/lib/attention/types";
import { actionError, actionSuccess, type ActionState } from "@/src/lib/errors/action-error";
import {
  getSetupChecklist,
  setSetupChecklistHidden,
  setSetupStepDone,
  type SetupChecklist,
} from "@/src/lib/setup-checklist";
import { can, currentAccess, requireCan } from "@/src/lib/users/permissions";

export async function loadAttentionAction(): Promise<OverviewAttention | null> {
  try {
    const { access } = await currentAccess();
    const [list, acknowledgements] = await Promise.all([
      collectAttention(access),
      getAcknowledgements(),
    ]);
    return {
      ...withoutAcknowledged(list, acknowledgements),
      canAcknowledge: can(access, "overview:write"),
    };
  } catch (error) {
    unstable_rethrow(error);
    console.error("Failed to collect Needs attention:", error);
    return null;
  }
}

export async function acknowledgeAttentionAction(id: string, code: string): Promise<ActionState> {
  try {
    const session = await requireCan("overview:write");
    if (!(await acknowledgeAttention({ id, code }, Number(session.user.id)))) {
      const t = await getTranslations();
      return actionError(t, null, t("errors.attentionAcknowledgeFailed"));
    }
    return actionSuccess();
  } catch (error) {
    unstable_rethrow(error);
    const t = await getTranslations();
    return actionError(t, error, t("errors.attentionAcknowledgeFailed"));
  }
}

export async function loadSetupChecklistAction(): Promise<SetupChecklist | null> {
  try {
    const { access } = await currentAccess();
    if (!can(access, "overview:read")) return null;
    return await getSetupChecklist();
  } catch (error) {
    unstable_rethrow(error);
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
    unstable_rethrow(error);
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
    unstable_rethrow(error);
    const t = await getTranslations();
    return actionError(t, error, t("errors.setupChecklistFailed"));
  }
}
