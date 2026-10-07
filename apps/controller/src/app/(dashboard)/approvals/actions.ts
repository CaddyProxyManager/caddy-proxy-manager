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
import { withTranslatedErrors } from "@/src/lib/errors/translated-action";
import { currentAccess, requireCanAccess } from "@/src/lib/users/permissions";

const PAGE = "/approvals";

/** Any account: the policy, not a capability, names who approves, and the model checks it. */
export async function approveChangeAction(id: number, note: string): Promise<ChangeStatus> {
  const { access } = await currentAccess();
  return withTranslatedErrors(async () => {
    const result = await approveChange(id, access, note);
    revalidatePath("/", "layout");
    return result.status;
  });
}

export async function rejectChangeAction(id: number, note: string): Promise<void> {
  const { access } = await currentAccess();
  await withTranslatedErrors(async () => {
    await rejectChange(id, access, note);
    revalidatePath(PAGE);
  });
}

/** The requester's own request only; the model checks it. */
export async function withdrawChangeAction(id: number): Promise<void> {
  const { access } = await currentAccess();
  await withTranslatedErrors(async () => {
    await withdrawChange(id, access);
    revalidatePath(PAGE);
  });
}

/** Administrators only; the model checks it. */
export async function bypassChangeAction(id: number, reason: string): Promise<ChangeStatus> {
  const { access } = await currentAccess();
  return withTranslatedErrors(async () => {
    const status = await bypassChange(id, access, reason);
    revalidatePath("/", "layout");
    return status;
  });
}

/** The policy is a settings change: it waits for approval itself while settings are covered. */
export async function saveApprovalPolicyAction(input: ApprovalPolicy): Promise<string> {
  const { access } = await requireCanAccess("settings:write");
  return withTranslatedErrors(async () => {
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
