"use server";

import { revalidatePath } from "next/cache";
import {
  assertCanManage,
  assertCanView,
  requireReach,
  requireCan,
} from "@/src/lib/users/permissions";
import {
  type HostUpstreamHealth,
  getProxyHostUpstreamHealth,
} from "@/src/lib/proxy-hosts/upstream-health";
import {
  actionError,
  actionSuccess,
  extractErrorMessage,
  INITIAL_ACTION_STATE,
  type ActionState,
} from "@/src/lib/errors/action-error";
import { type ProxyHostBulkRequest, parseProxyHostBulkRequest } from "@/src/lib/models/bulk-hosts";
import { needsApproval, submitOrApply } from "@/src/lib/approvals";
import { logWriteFailure } from "@/src/lib/approvals/submitted";
import { getTranslations } from "next-intl/server";
import { parseProxyHostCreateForm, parseProxyHostUpdateForm } from "@/src/lib/proxy-hosts/form";
import { revertedFields } from "@/src/lib/host-review/diff";
import { previewProxyHostChange, revertProxyHostInput } from "@/src/lib/host-review";
import type { HostPreviewResult } from "@/src/lib/host-review/types";
import { rollbackRevisionFrom } from "@/src/lib/host-history";
import {
  type HostEditorOptions,
  loadForwardAuthAccess,
  loadHostEditorOptions,
} from "@/src/lib/proxy-hosts/editor-options";

export async function createProxyHostAction(
  _prevState: ActionState = INITIAL_ACTION_STATE,
  formData: FormData,
): Promise<ActionState> {
  void _prevState;
  try {
    const session = await requireCan("hosts:write");
    const userId = Number(session.user.id);
    const {
      input,
      forwardAuthAccess,
      missingCertificate: missing,
    } = revertProxyHostInput(
      await parseProxyHostCreateForm(formData),
      revertedFields(formData),
      true,
    );
    await submitOrApply(
      { userId },
      { kind: "proxyHostCreate", payload: { input, forwardAuthAccess } },
    );

    revalidatePath("/proxy-hosts");

    const t = await getTranslations("proxyHosts");
    if (missing) {
      const id = String(missing.id);
      return actionSuccess(
        missing.cloudflareConfigured
          ? t("hostCreatedAutoCert", { id })
          : t("hostCreatedAutoCertNoCloudflare", { id }),
      );
    }
    return actionSuccess(t("hostCreated"));
  } catch (error) {
    const t = await getTranslations();
    logWriteFailure(error, "Failed to create proxy host:");
    return actionError(t, error, t("errors.createProxyHostFailed"));
  }
}

export async function updateProxyHostAction(
  id: number,
  _prevState: ActionState = INITIAL_ACTION_STATE,
  formData: FormData,
): Promise<ActionState> {
  void _prevState;
  try {
    // Operators may edit granted hosts but not create them: a grant names an existing host.
    // updateProxyHost keeps the raw Caddy config fields admin-only.
    const access = await requireReach("hosts:write");
    assertCanManage(access, "proxyHost", id);
    const userId = access.userId;
    const {
      input,
      forwardAuthAccess,
      missingCertificate: missing,
    } = revertProxyHostInput(
      await parseProxyHostUpdateForm(formData),
      revertedFields(formData),
      false,
    );
    const rollbackFrom = await rollbackRevisionFrom(formData, "http", id);
    await submitOrApply(
      { userId },
      { kind: "proxyHostUpdate", payload: { id, input, forwardAuthAccess, rollbackFrom } },
    );

    revalidatePath("/proxy-hosts");

    const t = await getTranslations("proxyHosts");
    if (missing) {
      const id = String(missing.id);
      return actionSuccess(
        missing.cloudflareConfigured
          ? t("hostUpdatedAutoCert", { id })
          : t("hostUpdatedAutoCertNoCloudflare", { id }),
      );
    }
    return actionSuccess(t("hostUpdated"));
  } catch (error) {
    const t = await getTranslations();
    logWriteFailure(error, "Failed to update proxy host:", id);
    return actionError(t, error, t("errors.updateProxyHostFailed"));
  }
}

export async function deleteProxyHostAction(
  id: number,
  _prevState: ActionState = INITIAL_ACTION_STATE,
): Promise<ActionState> {
  void _prevState;
  try {
    const access = await requireReach("hosts:write");
    assertCanManage(access, "proxyHost", id);
    await submitOrApply({ userId: access.userId }, { kind: "proxyHostDelete", payload: { id } });
    revalidatePath("/proxy-hosts");
    const t = await getTranslations("proxyHosts");
    return actionSuccess(t("hostDeleted"));
  } catch (error) {
    const t = await getTranslations();
    logWriteFailure(error, "Failed to delete proxy host:", id);
    return actionError(t, error, t("errors.deleteProxyHostFailed"));
  }
}

export async function toggleProxyHostAction(id: number, enabled: boolean): Promise<ActionState> {
  try {
    const access = await requireReach("hosts:write");
    assertCanManage(access, "proxyHost", id);
    await submitOrApply(
      { userId: access.userId },
      { kind: "proxyHostUpdate", payload: { id, input: { enabled } } },
    );
    revalidatePath("/proxy-hosts");
    const t = await getTranslations("proxyHosts");
    return actionSuccess(enabled ? t("hostEnabledResult") : t("hostDisabledResult"));
  } catch (error) {
    const t = await getTranslations();
    logWriteFailure(error, "Failed to toggle proxy host:", id);
    return actionError(t, error, t("errors.toggleProxyHostFailed"));
  }
}

export async function setProxyHostMaintenanceAction(
  id: number,
  enabled: boolean,
): Promise<ActionState> {
  try {
    const access = await requireReach("hosts:write");
    assertCanManage(access, "proxyHost", id);
    await submitOrApply(
      { userId: access.userId },
      { kind: "proxyHostMaintenance", payload: { id, enabled } },
    );
    revalidatePath("/proxy-hosts");
    const t = await getTranslations("proxyHosts");
    return actionSuccess(enabled ? t("maintenanceOnResult") : t("maintenanceOffResult"));
  } catch (error) {
    const t = await getTranslations();
    logWriteFailure(error, "Failed to switch maintenance mode:", id);
    return actionError(t, error, t("errors.toggleMaintenanceFailed"));
  }
}

/** All or nothing: one host the operator may not manage refuses the whole batch. */
export async function bulkProxyHostsAction(request: ProxyHostBulkRequest): Promise<ActionState> {
  try {
    const access = await requireReach("hosts:write");
    const parsed = parseProxyHostBulkRequest(request);
    for (const id of parsed.ids) assertCanManage(access, "proxyHost", id);
    const count = await submitOrApply(
      { userId: access.userId },
      { kind: "proxyHostBulk", payload: parsed },
    );
    revalidatePath("/proxy-hosts");
    const t = await getTranslations("ui");
    return actionSuccess(
      parsed.action === "delete"
        ? t("bulk.deletedResult", { count })
        : t("bulk.updatedResult", { count }),
    );
  } catch (error) {
    const t = await getTranslations();
    logWriteFailure(error, "Failed to change proxy hosts in bulk:");
    return actionError(t, error, t("errors.bulkHostsFailed"));
  }
}

/** What the editor and the bulk bar choose from, read when one first opens. */
export async function hostEditorOptionsAction(): Promise<
  { ok: true; options: HostEditorOptions } | { ok: false; message: string }
> {
  try {
    await requireReach("hosts:write");
    return { ok: true, options: await loadHostEditorOptions() };
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to read the host editor's options:", error);
    return {
      ok: false,
      message: extractErrorMessage(t, error, t("errors.hostEditorOptionsFailed")),
    };
  }
}

/** A host's forward-auth grants, read as its editor opens; seeing the host is enough. */
export async function hostForwardAuthAccessAction(
  id: number,
): Promise<
  { ok: true; access: { userIds: number[]; groupIds: number[] } } | { ok: false; message: string }
> {
  try {
    const access = await requireReach("hosts:read");
    assertCanView(access, "proxyHost", id);
    return { ok: true, access: await loadForwardAuthAccess(id) };
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to read forward auth access:", id, error);
    return {
      ok: false,
      message: extractErrorMessage(t, error, t("errors.hostEditorOptionsFailed")),
    };
  }
}

/** Read-only, so viewing the host is enough: anyone who can see its upstreams sees their health. */
export async function proxyHostUpstreamHealthAction(
  id: number,
): Promise<{ ok: true; health: HostUpstreamHealth } | { ok: false; message: string }> {
  try {
    const access = await requireReach("hosts:read");
    assertCanView(access, "proxyHost", id);
    return { ok: true, health: await getProxyHostUpstreamHealth(id) };
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to read upstream health:", id, error);
    return { ok: false, message: extractErrorMessage(t, error, t("errors.upstreamHealthFailed")) };
  }
}

/**
 * The editor's review step: the diff and impact of saving this form, with `revertField` entries
 * taken out, and nothing stored. Null previews a create, which stays with admins.
 */
export async function previewProxyHostAction(
  id: number | null,
  formData: FormData,
): Promise<HostPreviewResult> {
  try {
    let userId: number;
    if (id === null) {
      userId = Number((await requireCan("hosts:write")).user.id);
    } else {
      const access = await requireReach("hosts:write");
      assertCanManage(access, "proxyHost", id);
      userId = access.userId;
    }
    const parsed =
      id === null
        ? await parseProxyHostCreateForm(formData)
        : await parseProxyHostUpdateForm(formData);
    const preview = await previewProxyHostChange(
      {
        id,
        input: parsed.input,
        forwardAuthAccess: parsed.forwardAuthAccess,
        reverted: revertedFields(formData),
      },
      userId,
    );
    const approval = await needsApproval(
      { userId },
      id === null
        ? { kind: "proxyHostCreate", payload: { input: parsed.input } }
        : { kind: "proxyHostUpdate", payload: { id, input: parsed.input } },
    );
    return { ok: true, preview, approval };
  } catch (error) {
    const t = await getTranslations();
    return { ok: false, message: extractErrorMessage(t, error, t("errors.previewHostFailed")) };
  }
}

/** Admin only, as a create is: a deleted host has no grants left to check. */
export async function restoreProxyHostAction(
  revisionId: number,
  dropMissingReferences: boolean,
): Promise<ActionState> {
  try {
    const session = await requireCan("hosts:write");
    await submitOrApply(
      { userId: Number(session.user.id) },
      { kind: "hostRestore", payload: { revisionId, dropMissingReferences, kind: "http" } },
    );
    revalidatePath("/proxy-hosts");
    const t = await getTranslations("hostHistory");
    return actionSuccess(t("restored"));
  } catch (error) {
    const t = await getTranslations();
    logWriteFailure(error, "Failed to restore proxy host:", revisionId);
    return actionError(t, error, t("errors.restoreHostFailed"));
  }
}
