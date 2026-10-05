/**
 * Stands in for `app/(dashboard)/overview-actions` in the demos (aliased in astro.config.mjs). The
 * overview demo passes its Needs attention and checklist as previews, so nothing loads; a change
 * fails as one with no controller would.
 */
import type { ActionState } from "@cpm/controller/src/lib/errors/action-error";
import type { AttentionList } from "@cpm/controller/src/lib/attention/types";
import type { SetupChecklist } from "@cpm/controller/src/lib/setup-checklist/steps";

const refused: ActionState = {
  status: "error",
  message: "There is no controller behind the documentation site.",
};

export async function loadAttentionAction(): Promise<AttentionList | null> {
  return { items: [], skipped: [], truncated: 0 };
}

export async function loadSetupChecklistAction(): Promise<SetupChecklist | null> {
  return null;
}

export async function setSetupStepDoneAction(_step: string, _done: boolean): Promise<ActionState> {
  return refused;
}

export async function setSetupChecklistHiddenAction(_hidden: boolean): Promise<ActionState> {
  return refused;
}
