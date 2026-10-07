"use server";

import { revalidatePath } from "next/cache";
import { assertCanManage, requireReach, requireCan } from "@/src/lib/users/permissions";
import { getTranslations } from "next-intl/server";
import {
  actionError,
  actionSuccess,
  extractErrorMessage,
  INITIAL_ACTION_STATE,
  type ActionState,
} from "@/src/lib/errors/action-error";
import { type L4HostBulkRequest, parseL4HostBulkRequest } from "@/src/lib/models/bulk-hosts";
import { needsApproval, submitOrApply } from "@/src/lib/approvals";
import { logWriteFailure } from "@/src/lib/approvals/submitted";
import { parseL4CreateForm, parseL4UpdateForm } from "@/src/lib/l4/form";
import { revertedFields, withoutReverted } from "@/src/lib/host-review/diff";
import { previewL4HostChange } from "@/src/lib/host-review";
import type { HostPreviewResult } from "@/src/lib/host-review/types";
import { rollbackRevisionFrom } from "@/src/lib/host-history";

export async function createL4ProxyHostAction(
  _prevState: ActionState = INITIAL_ACTION_STATE,
  formData: FormData,
): Promise<ActionState> {
  void _prevState;
  try {
    const session = await requireCan("hosts:write");
    const userId = Number(session.user.id);

    const input = withoutReverted(
      "l4",
      parseL4CreateForm(formData),
      revertedFields(formData),
      true,
    );

    await submitOrApply({ userId }, { kind: "l4HostCreate", payload: { input } });
    revalidatePath("/l4-proxy-hosts");
    const t = await getTranslations("l4ProxyHosts");
    return actionSuccess(t("hostCreated"));
  } catch (error) {
    const t = await getTranslations();
    logWriteFailure(error, "Failed to create L4 proxy host:");
    return actionError(t, error, t("errors.createL4HostFailed"));
  }
}

export async function updateL4ProxyHostAction(
  id: number,
  _prevState: ActionState = INITIAL_ACTION_STATE,
  formData: FormData,
): Promise<ActionState> {
  void _prevState;
  try {
    // An operator may edit a host their groups were granted; creating one stays with admins,
    // because a grant names a host that already exists.
    const access = await requireReach("hosts:write");
    assertCanManage(access, "l4ProxyHost", id);
    const userId = access.userId;

    const input = withoutReverted(
      "l4",
      parseL4UpdateForm(formData),
      revertedFields(formData),
      false,
    );

    const rollbackFrom = await rollbackRevisionFrom(formData, "l4", id);
    await submitOrApply({ userId }, { kind: "l4HostUpdate", payload: { id, input, rollbackFrom } });
    revalidatePath("/l4-proxy-hosts");
    const t = await getTranslations("l4ProxyHosts");
    return actionSuccess(t("hostUpdated"));
  } catch (error) {
    const t = await getTranslations();
    logWriteFailure(error, "Failed to update L4 proxy host:", id);
    return actionError(t, error, t("errors.updateL4HostFailed"));
  }
}

export async function deleteL4ProxyHostAction(
  id: number,
  _prevState: ActionState = INITIAL_ACTION_STATE,
): Promise<ActionState> {
  void _prevState;
  try {
    const access = await requireReach("hosts:write");
    assertCanManage(access, "l4ProxyHost", id);
    await submitOrApply({ userId: access.userId }, { kind: "l4HostDelete", payload: { id } });
    revalidatePath("/l4-proxy-hosts");
    const t = await getTranslations("l4ProxyHosts");
    return actionSuccess(t("hostDeleted"));
  } catch (error) {
    const t = await getTranslations();
    logWriteFailure(error, "Failed to delete L4 proxy host:", id);
    return actionError(t, error, t("errors.deleteL4HostFailed"));
  }
}

export async function toggleL4ProxyHostAction(id: number, enabled: boolean): Promise<ActionState> {
  try {
    const access = await requireReach("hosts:write");
    assertCanManage(access, "l4ProxyHost", id);
    await submitOrApply(
      { userId: access.userId },
      { kind: "l4HostUpdate", payload: { id, input: { enabled } } },
    );
    revalidatePath("/l4-proxy-hosts");
    const t = await getTranslations("l4ProxyHosts");
    return actionSuccess(enabled ? t("hostEnabledMessage") : t("hostDisabledMessage"));
  } catch (error) {
    const t = await getTranslations();
    logWriteFailure(error, "Failed to toggle L4 proxy host:", id);
    return actionError(t, error, t("errors.toggleL4HostFailed"));
  }
}

/** All or nothing, as for proxy hosts. */
export async function bulkL4ProxyHostsAction(request: L4HostBulkRequest): Promise<ActionState> {
  try {
    const access = await requireReach("hosts:write");
    const parsed = parseL4HostBulkRequest(request);
    for (const id of parsed.ids) assertCanManage(access, "l4ProxyHost", id);
    const count = await submitOrApply(
      { userId: access.userId },
      { kind: "l4HostBulk", payload: parsed },
    );
    revalidatePath("/l4-proxy-hosts");
    const t = await getTranslations("ui");
    return actionSuccess(
      parsed.action === "delete"
        ? t("bulk.deletedResult", { count })
        : t("bulk.updatedResult", { count }),
    );
  } catch (error) {
    const t = await getTranslations();
    logWriteFailure(error, "Failed to change L4 proxy hosts in bulk:");
    return actionError(t, error, t("errors.bulkHostsFailed"));
  }
}

/**
 * The editor's review step: the diff and impact of saving this form, with `revertField` entries
 * taken out, and nothing stored. Null previews a create, which stays with admins.
 */
export async function previewL4ProxyHostAction(
  id: number | null,
  formData: FormData,
): Promise<HostPreviewResult> {
  try {
    let userId: number;
    if (id === null) {
      userId = Number((await requireCan("hosts:write")).user.id);
    } else {
      const access = await requireReach("hosts:write");
      assertCanManage(access, "l4ProxyHost", id);
      userId = access.userId;
    }
    const input = id === null ? parseL4CreateForm(formData) : parseL4UpdateForm(formData);
    const preview = await previewL4HostChange(
      { id, input, reverted: revertedFields(formData) },
      userId,
    );
    const approval = await needsApproval(
      { userId },
      id === null
        ? { kind: "l4HostCreate", payload: { input } }
        : { kind: "l4HostUpdate", payload: { id, input } },
    );
    return { ok: true, preview, approval };
  } catch (error) {
    const t = await getTranslations();
    return { ok: false, message: extractErrorMessage(t, error, t("errors.previewHostFailed")) };
  }
}

/** Admin only, as a create is: a deleted host has no grants left to check. */
export async function restoreL4ProxyHostAction(
  revisionId: number,
  dropMissingReferences: boolean,
): Promise<ActionState> {
  try {
    const session = await requireCan("hosts:write");
    await submitOrApply(
      { userId: Number(session.user.id) },
      { kind: "hostRestore", payload: { revisionId, dropMissingReferences, kind: "l4" } },
    );
    revalidatePath("/l4-proxy-hosts");
    const t = await getTranslations("hostHistory");
    return actionSuccess(t("restored"));
  } catch (error) {
    const t = await getTranslations();
    logWriteFailure(error, "Failed to restore L4 proxy host:", revisionId);
    return actionError(t, error, t("errors.restoreHostFailed"));
  }
}
