"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/src/lib/auth";
import { assertCanManage, requireAccess } from "@/src/lib/users/permissions";
import { getTranslations } from "next-intl/server";
import {
  actionError,
  actionSuccess,
  extractErrorMessage,
  INITIAL_ACTION_STATE,
  type ActionState,
} from "@/src/lib/errors/action-error";
import {
  createL4ProxyHost,
  deleteL4ProxyHost,
  updateL4ProxyHost,
} from "@/src/lib/models/l4-proxy-hosts";
import {
  type L4HostBulkRequest,
  bulkUpdateL4ProxyHosts,
  parseL4HostBulkRequest,
} from "@/src/lib/models/bulk-hosts";
import { parseL4CreateForm, parseL4UpdateForm } from "@/src/lib/l4/form";
import { revertedFields, withoutReverted } from "@/src/lib/host-review/diff";
import { previewL4HostChange } from "@/src/lib/host-review";
import type { HostPreviewResult } from "@/src/lib/host-review/types";

export async function createL4ProxyHostAction(
  _prevState: ActionState = INITIAL_ACTION_STATE,
  formData: FormData,
): Promise<ActionState> {
  void _prevState;
  try {
    const session = await requireAdmin();
    const userId = Number(session.user.id);

    const input = withoutReverted(
      "l4",
      parseL4CreateForm(formData),
      revertedFields(formData),
      true,
    );

    await createL4ProxyHost(input, userId);
    revalidatePath("/l4-proxy-hosts");
    const t = await getTranslations("l4ProxyHosts");
    return actionSuccess(t("hostCreated"));
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to create L4 proxy host:", error);
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
    const access = await requireAccess();
    assertCanManage(access, "l4ProxyHost", id);
    const userId = access.userId;

    const input = withoutReverted(
      "l4",
      parseL4UpdateForm(formData),
      revertedFields(formData),
      false,
    );

    await updateL4ProxyHost(id, input, userId);
    revalidatePath("/l4-proxy-hosts");
    const t = await getTranslations("l4ProxyHosts");
    return actionSuccess(t("hostUpdated"));
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to update L4 proxy host:", id, error);
    return actionError(t, error, t("errors.updateL4HostFailed"));
  }
}

export async function deleteL4ProxyHostAction(
  id: number,
  _prevState: ActionState = INITIAL_ACTION_STATE,
): Promise<ActionState> {
  void _prevState;
  try {
    const access = await requireAccess();
    assertCanManage(access, "l4ProxyHost", id);
    await deleteL4ProxyHost(id, access.userId);
    revalidatePath("/l4-proxy-hosts");
    const t = await getTranslations("l4ProxyHosts");
    return actionSuccess(t("hostDeleted"));
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to delete L4 proxy host:", id, error);
    return actionError(t, error, t("errors.deleteL4HostFailed"));
  }
}

export async function toggleL4ProxyHostAction(id: number, enabled: boolean): Promise<ActionState> {
  try {
    const access = await requireAccess();
    assertCanManage(access, "l4ProxyHost", id);
    await updateL4ProxyHost(id, { enabled }, access.userId);
    revalidatePath("/l4-proxy-hosts");
    const t = await getTranslations("l4ProxyHosts");
    return actionSuccess(enabled ? t("hostEnabledMessage") : t("hostDisabledMessage"));
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to toggle L4 proxy host:", id, error);
    return actionError(t, error, t("errors.toggleL4HostFailed"));
  }
}

/** All or nothing, as for proxy hosts. */
export async function bulkL4ProxyHostsAction(request: L4HostBulkRequest): Promise<ActionState> {
  try {
    const access = await requireAccess();
    const parsed = parseL4HostBulkRequest(request);
    for (const id of parsed.ids) assertCanManage(access, "l4ProxyHost", id);
    const { count } = await bulkUpdateL4ProxyHosts(parsed, access.userId);
    revalidatePath("/l4-proxy-hosts");
    const t = await getTranslations("ui");
    return actionSuccess(
      parsed.action === "delete"
        ? t("bulk.deletedResult", { count })
        : t("bulk.updatedResult", { count }),
    );
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to change L4 proxy hosts in bulk:", error);
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
      userId = Number((await requireAdmin()).user.id);
    } else {
      const access = await requireAccess();
      assertCanManage(access, "l4ProxyHost", id);
      userId = access.userId;
    }
    const input = id === null ? parseL4CreateForm(formData) : parseL4UpdateForm(formData);
    const preview = await previewL4HostChange(
      { id, input, reverted: revertedFields(formData) },
      userId,
    );
    return { ok: true, preview };
  } catch (error) {
    const t = await getTranslations();
    return { ok: false, message: extractErrorMessage(t, error, t("errors.previewHostFailed")) };
  }
}
