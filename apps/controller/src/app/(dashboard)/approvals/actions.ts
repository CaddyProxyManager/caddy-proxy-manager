"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import {
  approveChange,
  bypassChange,
  rejectChange,
  submitOrApply,
  withdrawChange,
} from "@/src/lib/approvals";
import { orSubmitted } from "@/src/lib/approvals/action-result";
import { type ApprovalPolicy, readApprovalPolicy } from "@/src/lib/approvals/policy";
import type { ChangeStatus } from "@/src/lib/approvals/types";
import type { ActionResult } from "@/src/lib/errors/action-result";
import { runAction } from "@/src/lib/errors/run-action";
import { currentAccess, requireCanAccess } from "@/src/lib/users/permissions";

const PAGE = "/approvals";

/** Any account: the policy, not a capability, names who approves, and the model checks it. */
export async function approveChangeAction(
  id: number,
  note: string,
): Promise<ActionResult<ChangeStatus>> {
  return runAction(async () => {
    const { access } = await currentAccess();
    const result = await approveChange(id, access, note);
    revalidatePath("/", "layout");
    return result.status;
  });
}

export async function rejectChangeAction(id: number, note: string): Promise<ActionResult> {
  return runAction(async () => {
    const { access } = await currentAccess();
    await rejectChange(id, access, note);
    revalidatePath(PAGE);
  });
}

/** The requester's own request only; the model checks it. */
export async function withdrawChangeAction(id: number): Promise<ActionResult> {
  return runAction(async () => {
    const { access } = await currentAccess();
    await withdrawChange(id, access);
    revalidatePath(PAGE);
  });
}

/** Administrators only; the model checks it. */
export async function bypassChangeAction(
  id: number,
  reason: string,
): Promise<ActionResult<ChangeStatus>> {
  return runAction(async () => {
    const { access } = await currentAccess();
    const status = await bypassChange(id, access, reason);
    revalidatePath("/", "layout");
    return status;
  });
}

/** The policy is a settings change: it waits for approval itself while settings are covered. */
export async function saveApprovalPolicyAction(
  input: ApprovalPolicy,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    const { access } = await requireCanAccess("settings:write");
    const outcome = await orSubmitted(() =>
      submitOrApply(
        { userId: access.userId },
        { kind: "approvalPolicy", payload: { policy: readApprovalPolicy(input) } },
      ),
    );
    revalidatePath(PAGE);
    if ("submittedForApproval" in outcome) return outcome.message;
    return (await getTranslations("changeApprovals"))("policy.saved");
  });
}
