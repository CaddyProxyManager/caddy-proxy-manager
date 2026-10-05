"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/src/lib/auth";
import { assertCanManage, requireAccess } from "@/src/lib/users/permissions";
import {
  actionError,
  actionSuccess,
  INITIAL_ACTION_STATE,
  type ActionState,
} from "@/src/lib/errors/action-error";
import {
  createProxyHost,
  deleteProxyHost,
  setProxyHostMaintenance,
  updateProxyHost,
} from "@/src/lib/models/proxy-hosts";
import { parseAgentIds } from "@/src/lib/models/host-agents";
import {
  type ProxyHostBulkRequest,
  bulkUpdateProxyHosts,
  parseProxyHostBulkRequest,
} from "@/src/lib/models/bulk-hosts";
import { setForwardAuthAccess } from "@/src/lib/models/forward-auth";
import { getTranslations } from "next-intl/server";
import {
  parseCsv,
  parseUpstreams,
  parseCheckbox,
  parseOptionalText,
  parseCertificateId,
  parseAccessListId,
} from "@/src/lib/forms/form-parse";
import {
  parseAuthentikConfig,
  parseCpmForwardAuthConfig,
  parseForwardAuthConfig,
  parseDnsResolverConfig,
  parseErrorPagesConfig,
  parseGeoBlockConfig,
  parseLoadBalancerConfig,
  parseLocationRulesConfig,
  parseMtlsConfig,
  parsePathAllowsConfig,
  parsePathBlocksConfig,
  parsePathRewritesConfig,
  parseProxyHostOptionUpdates,
  parseCacheConfig,
  parseCompressionMode,
  parseMaintenanceConfig,
  parseUpstreamTimeoutsConfig,
  parseRateLimitConfig,
  parseCrowdSecEnabled,
  parseAnubisConfig,
  parseRedirectsConfig,
  parseRewriteConfig,
  parseTailscaleConfig,
  parseUpstreamDnsResolutionConfig,
  parseWafConfig,
  validateAndSanitizeCertificateId,
} from "@/src/lib/proxy-hosts/form";

export async function createProxyHostAction(
  _prevState: ActionState = INITIAL_ACTION_STATE,
  formData: FormData,
): Promise<ActionState> {
  void _prevState;
  try {
    const session = await requireAdmin();
    const userId = Number(session.user.id);
    const boolField = (key: string) =>
      formData.has(`${key}Present`) ? parseCheckbox(formData.get(key)) : undefined;

    const { certificateId, warning, missing } = await validateAndSanitizeCertificateId(
      parseCertificateId(formData.get("certificateId")),
    );

    if (warning) {
      console.warn(`[createProxyHostAction] ${warning}`);
    }

    const host = await createProxyHost(
      {
        name: String(formData.get("name") ?? "Untitled"),
        description: formData.has("description") ? String(formData.get("description")) : undefined,
        domains: parseCsv(formData.get("domains")),
        upstreams: parseUpstreams(formData.get("upstreams")),
        // Empty means every agent, as an absent field does, so older clients keep working.
        agentIds: parseAgentIds(formData.getAll("agentId")),
        certificateId: certificateId,
        accessListId: parseAccessListId(formData.get("accessListId")),
        // An absent marker takes the model's default, so a form without a toggle keeps it on.
        sslForced: boolField("sslForced"),
        hstsEnabled: boolField("hstsEnabled"),
        hstsSubdomains: parseCheckbox(formData.get("hstsSubdomains")),
        allowWebsocket: boolField("allowWebsocket"),
        preserveHostHeader: boolField("preserveHostHeader"),
        skipHttpsHostnameValidation: parseCheckbox(formData.get("skipHttpsHostnameValidation")),
        discourageIndexing: boolField("discourageIndexing"),
        enabled: parseCheckbox(formData.get("enabled")),
        customPreHandlersJson: parseOptionalText(formData.get("customPreHandlersJson")),
        customReverseProxyJson: parseOptionalText(formData.get("customReverseProxyJson")),
        customCaddyfile: parseOptionalText(formData.get("customCaddyfile")),
        authentik: parseAuthentikConfig(formData),
        forwardAuth: parseForwardAuthConfig(formData),
        cpmForwardAuth: parseCpmForwardAuthConfig(formData),
        tailscale: parseTailscaleConfig(formData),
        loadBalancer: parseLoadBalancerConfig(formData),
        dnsResolver: parseDnsResolverConfig(formData),
        upstreamDnsResolution: parseUpstreamDnsResolutionConfig(formData),
        ...parseGeoBlockConfig(formData),
        ...parseWafConfig(formData),
        mtls: parseMtlsConfig(formData),
        redirects: parseRedirectsConfig(formData),
        rewrite: parseRewriteConfig(formData),
        cache: parseCacheConfig(formData) ?? null,
        compression: parseCompressionMode(formData),
        maintenance: parseMaintenanceConfig(formData),
        upstreamTimeouts: parseUpstreamTimeoutsConfig(formData),
        rateLimit: parseRateLimitConfig(formData),
        crowdsec: parseCrowdSecEnabled(formData),
        anubis: parseAnubisConfig(formData),
        locationRules: parseLocationRulesConfig(formData),
        pathAllows: parsePathAllowsConfig(formData),
        pathBlocks: parsePathBlocksConfig(formData),
        pathRewrites: parsePathRewritesConfig(formData),
        errorPages: parseErrorPagesConfig(formData),
      },
      userId,
    );

    const faUserIds = formData
      .getAll("cpmFaUserId")
      .map((v) => Number(v))
      .filter((n) => n > 0);
    const faGroupIds = formData
      .getAll("cpmFaGroupId")
      .map((v) => Number(v))
      .filter((n) => n > 0);
    if (host.cpmForwardAuth?.enabled && (faUserIds.length > 0 || faGroupIds.length > 0)) {
      await setForwardAuthAccess(host.id, { userIds: faUserIds, groupIds: faGroupIds }, userId);
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
    const boolField = (key: string) =>
      formData.has(`${key}Present`) ? parseCheckbox(formData.get(key)) : undefined;

    let certificateId: number | null | undefined;
    let warning: string | undefined;
    let missing: { id: number; cloudflareConfigured: boolean } | undefined;

    if (formData.has("certificateId")) {
      const validation = await validateAndSanitizeCertificateId(
        parseCertificateId(formData.get("certificateId")),
      );
      certificateId = validation.certificateId;
      warning = validation.warning;
      missing = validation.missing;

      if (warning) {
        console.warn(`[updateProxyHostAction] ${warning}`);
      }
    }

    await updateProxyHost(
      id,
      {
        name: formData.get("name") ? String(formData.get("name")) : undefined,
        description: formData.has("description") ? String(formData.get("description")) : undefined,
        domains: formData.get("domains") ? parseCsv(formData.get("domains")) : undefined,
        upstreams: formData.get("upstreams")
          ? parseUpstreams(formData.get("upstreams"))
          : undefined,
        // Gated on the marker: an empty list is a real edit ("everywhere"), not an absent field.
        agentIds: formData.has("agentAssignmentPresent")
          ? parseAgentIds(formData.getAll("agentId"))
          : undefined,
        certificateId: certificateId,
        accessListId: formData.has("accessListId")
          ? parseAccessListId(formData.get("accessListId"))
          : undefined,
        ...parseProxyHostOptionUpdates(formData),
        enabled: boolField("enabled"),
      },
      userId,
    );

    if (formData.has("cpmForwardAuthPresent")) {
      const faUserIds = formData
        .getAll("cpmFaUserId")
        .map((v) => Number(v))
        .filter((n) => n > 0);
      const faGroupIds = formData
        .getAll("cpmFaGroupId")
        .map((v) => Number(v))
        .filter((n) => n > 0);
      await setForwardAuthAccess(id, { userIds: faUserIds, groupIds: faGroupIds }, userId);
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
