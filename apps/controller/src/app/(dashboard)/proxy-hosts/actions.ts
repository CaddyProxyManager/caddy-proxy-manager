"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/src/lib/auth";
import { assertCanManage, assertCanView, requireAccess } from "@/src/lib/users/permissions";
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
import {
  createProxyHost,
  deleteProxyHost,
  setProxyHostMaintenance,
  updateProxyHost,
} from "@/src/lib/models/proxy-hosts";
import {
  type ProxyHostBulkRequest,
  bulkUpdateProxyHosts,
  parseProxyHostBulkRequest,
} from "@/src/lib/models/bulk-hosts";
import { setForwardAuthAccess } from "@/src/lib/models/forward-auth";
import { getTranslations } from "next-intl/server";
import { parseProxyHostCreateForm, parseProxyHostUpdateForm } from "@/src/lib/proxy-hosts/form";
import { revertedFields } from "@/src/lib/host-review/diff";
import { previewProxyHostChange, revertProxyHostInput } from "@/src/lib/host-review";
import type { HostPreviewResult } from "@/src/lib/host-review/types";

export async function createProxyHostAction(
  _prevState: ActionState = INITIAL_ACTION_STATE,
  formData: FormData,
): Promise<ActionState> {
  void _prevState;
  try {
    const session = await requireAdmin();
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
    const host = await createProxyHost(input, userId);
    if (forwardAuthAccess && host.cpmForwardAuth?.enabled) {
      await setForwardAuthAccess(host.id, forwardAuthAccess, userId);
    }

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
    console.error("Failed to create proxy host:", error);
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
    const access = await requireAccess();
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
    await updateProxyHost(id, input, userId);
    if (forwardAuthAccess) {
      await setForwardAuthAccess(id, forwardAuthAccess, userId);
    }

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
    console.error("Failed to update proxy host:", id, error);
    return actionError(t, error, t("errors.updateProxyHostFailed"));
  }
}

export async function deleteProxyHostAction(
  id: number,
  _prevState: ActionState = INITIAL_ACTION_STATE,
): Promise<ActionState> {
  void _prevState;
  try {
    const access = await requireAccess();
    assertCanManage(access, "proxyHost", id);
    await deleteProxyHost(id, access.userId);
    revalidatePath("/proxy-hosts");
    const t = await getTranslations("proxyHosts");
    return actionSuccess(t("hostDeleted"));
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to delete proxy host:", id, error);
    return actionError(t, error, t("errors.deleteProxyHostFailed"));
  }
}

export async function toggleProxyHostAction(id: number, enabled: boolean): Promise<ActionState> {
  try {
    const access = await requireAccess();
    assertCanManage(access, "proxyHost", id);
    await updateProxyHost(id, { enabled }, access.userId);
    revalidatePath("/proxy-hosts");
    const t = await getTranslations("proxyHosts");
    return actionSuccess(enabled ? t("hostEnabledResult") : t("hostDisabledResult"));
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to toggle proxy host:", id, error);
    return actionError(t, error, t("errors.toggleProxyHostFailed"));
  }
}

export async function setProxyHostMaintenanceAction(
  id: number,
  enabled: boolean,
): Promise<ActionState> {
  try {
    const access = await requireAccess();
    assertCanManage(access, "proxyHost", id);
    await setProxyHostMaintenance(id, enabled, access.userId);
    revalidatePath("/proxy-hosts");
    const t = await getTranslations("proxyHosts");
    return actionSuccess(enabled ? t("maintenanceOnResult") : t("maintenanceOffResult"));
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to switch maintenance mode:", id, error);
    return actionError(t, error, t("errors.toggleMaintenanceFailed"));
  }
}

/** All or nothing: one host the operator may not manage refuses the whole batch. */
export async function bulkProxyHostsAction(request: ProxyHostBulkRequest): Promise<ActionState> {
  try {
    const access = await requireAccess();
    const parsed = parseProxyHostBulkRequest(request);
    for (const id of parsed.ids) assertCanManage(access, "proxyHost", id);
    const { count } = await bulkUpdateProxyHosts(parsed, access.userId);
    revalidatePath("/proxy-hosts");
    const t = await getTranslations("ui");
    return actionSuccess(
      parsed.action === "delete"
        ? t("bulk.deletedResult", { count })
        : t("bulk.updatedResult", { count }),
    );
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to change proxy hosts in bulk:", error);
    return actionError(t, error, t("errors.bulkHostsFailed"));
  }
}

/** Read-only, so viewing the host is enough: anyone who can see its upstreams sees their health. */
export async function proxyHostUpstreamHealthAction(
  id: number,
): Promise<{ ok: true; health: HostUpstreamHealth } | { ok: false; message: string }> {
  try {
    const access = await requireAccess();
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
      userId = Number((await requireAdmin()).user.id);
    } else {
      const access = await requireAccess();
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
    return { ok: true, preview };
  } catch (error) {
    const t = await getTranslations();
    return { ok: false, message: extractErrorMessage(t, error, t("errors.previewHostFailed")) };
  }
}
