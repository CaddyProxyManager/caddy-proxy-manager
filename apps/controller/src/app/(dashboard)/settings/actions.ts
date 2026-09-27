"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/src/lib/auth";
import { extractErrorMessage, storedErrorMessage } from "@/src/lib/actions";
import { getFormatter, getTranslations } from "next-intl/server";
import { domainError } from "@/src/lib/domain-error";
import { isEmailAddress } from "@/src/lib/email-address";
import { dnsProviderFieldText } from "@/src/lib/dns-provider-messages";
import { applyCaddyConfig } from "@/src/lib/caddy";
import { validateSettingsGroup } from "@/src/lib/settings-validation";
import { readDashboardHostOptions } from "@/src/lib/dashboard-host-options";
import {
  type DashboardDnsCheck,
  type DashboardHostSettings,
  checkDashboardDns,
} from "@/src/lib/dashboard-host";
import {
  customDirectivesError,
  normalizeWafPluginIds,
  normalizeWafPresetIds,
  parseBodyLimitMib,
} from "@/src/lib/caddy-waf";
import { parseDefaultResponseHeaders } from "@/src/lib/caddy-default-response";
import {
  getSetting,
  saveCloudflareSettings,
  getDnsProviderSettings,
  saveDnsProviderSettings,
  getDashboardSettings,
  saveDashboardSettings,
  saveGeneralSettings,
  saveAcmeSettings,
  saveAuthentikSettings,
  saveForwardAuthSettings,
  saveMetricsSettings,
  saveLoggingSettings,
  saveDnsSettings,
  saveUpstreamDnsResolutionSettings,
  saveGeoBlockSettings,
  saveWafSettings,
  getWafSettings,
  saveErrorPagesSettings,
  saveTrustedProxiesSettings,
  saveHttpProtocolsSettings,
  saveGlobalCaddyConfigSettings,
  saveHttpCacheSettings,
  saveTwoFactorPolicySettings,
  saveDefaultResponseSettings,
  type DefaultResponseSettings,
  saveAvatarSettings,
  savePasswordPolicySettings,
  saveCaddyBuildSettings,
  getTailscaleSettings,
  saveTailscaleSettings,
  defaultTailscaleSettings,
} from "@/src/lib/settings";
import {
  listProxyHosts,
  updateProxyHost,
  sanitizeErrorPageRules,
} from "@/src/lib/models/proxy-hosts";
import { getWafRuleMessages } from "@/src/lib/models/waf-events";
import { assertWafPresetIdsExist } from "@/src/lib/models/waf-presets";
import { assertCrsPluginIdsExist } from "@/src/lib/models/crs-plugins";
import { CADDY_MODULES, type CaddyCustomModule } from "@/src/lib/caddy-modules";
import {
  applyCaddyBuild,
  getCaddyBuildDiff,
  sanitizeCaddyBuildSettings,
} from "@/src/lib/caddy-build";
import {
  describeCaddyfileSnippetWarning,
  findModuleConflicts,
} from "@/src/lib/caddy-build-conflicts";
import { moduleConflictMessage } from "@/src/lib/caddy-module-messages";
import type {
  CloudflareSettings,
  DnsProviderSettings,
  GeoBlockSettings,
  WafSettings,
} from "@/src/lib/settings";
import { getProviderDefinition, isValidDnsDuration } from "@/src/lib/dns-providers";
import { encryptProviderCredentials } from "@/src/lib/dns-provider-credentials";
import { clearFavicon, FaviconValidationError, saveFavicon } from "@/src/lib/branding";
import { parseCheckbox, parseCsv } from "@/src/lib/form-parse";
import { checkTailscaleAuthKey } from "@/src/lib/tailscale-api";
import { isCaptchaProvider } from "@/src/lib/captcha/providers";
import { getCaptchaSettings, saveCaptchaSettings } from "@/src/lib/captcha/settings";
import { hasForbiddenControlCharacter } from "@/src/lib/settings-validation";
import { decryptSecret } from "@/src/lib/secret";
import { checkForUpdates } from "@/src/lib/updates";
import { config } from "@/src/lib/config";
import { toOAuthProviderView } from "@/src/lib/oauth-provider-view";
import { saveAnalyticsSettings, saveGeoipSettings } from "@/src/lib/settings/optional-features";
import { withSettingsUpdateLock } from "@/src/lib/settings-update-lock";
import {
  discardAllStaged,
  discardStagedKey,
  stageWrites,
  stagedOverlay,
} from "@/src/lib/settings/staging";
import { withCapturedWrites } from "@/src/lib/settings/staging-context";
import { applyStagedSettings } from "@/src/lib/settings/apply";
import { stageRevisionRestore } from "@/src/lib/settings/revisions";
import {
  ensurePairingCode,
  mintRepairCode,
  revokePairingCode,
  revokeRepairCode,
} from "@/src/lib/agent/pairing-codes";
import {
  enableAutoPairing,
  forgetBootstrapAgent,
  isBundledAgent,
  issueBootstrapToken,
} from "@/src/lib/agent/bootstrap";
import { detach } from "@/src/lib/agent/registry";
import { deleteAgent, findAgentById, setAgentBuildSettings } from "@/src/lib/models/agents";
import { pushDesiredState } from "@/src/lib/agent/desired-state";
import type { AppRole } from "@/src/lib/oidc-groups";

type ActionResult = {
  success: boolean;
  message?: string;
  /** Set by staged actions: the edit is in the change set, not applied. */
  staged?: boolean;
};

const VALID_UPSTREAM_DNS_FAMILIES = ["ipv6", "ipv4", "both"] as const;

/** A `DomainError` is translated; any other error keeps its own text (Caddy's, the database's). */
async function errorText(error: unknown, fallback: string): Promise<string> {
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  return extractErrorMessage(t, error, fallback, format);
}

/**
 * Applies at once, under the settings lock. For actions staging cannot represent: side effects
 * beyond a settings write (uploads, other tables, containers), which staging would split in half.
 */
function serializedSettingsAction<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs) => withSettingsUpdateLock(() => action(...args));
}

/**
 * Diverts the action's settings writes into the operator's change set; its `applyCaddyConfig()`
 * is suppressed. Still locked: two staged forms would race on the read-modify-write.
 */
function stagedSettingsAction<TArgs extends unknown[]>(
  action: (...args: TArgs) => Promise<ActionResult>,
): (...args: TArgs) => Promise<ActionResult> {
  return async (...args: TArgs) =>
    withSettingsUpdateLock(async () => {
      const session = await requireAdmin();
      const userId = Number(session.user.id);
      const overlay = await stagedOverlay(userId);

      const { result, writes } = await withCapturedWrites(overlay, () => action(...args));
      // A failed action may have written before it threw; don't stage its half-finished state.
      if (!result.success) {
        return result;
      }

      await stageWrites(userId, writes);
      // "layout" scope: the bare path would leave every /settings/[section] route stale.
      revalidatePath("/settings", "layout");

      if (writes.size === 0) {
        return result;
      }

      // The action bodies say "saved and applied"; nothing is applied yet, so the wrapper corrects
      // the wording in one place rather than in every action's message.
      const t = await getTranslations("settings");
      return { ...result, staged: true, message: t("stagedSaved") };
    });
}

async function updateGeneralSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();
    const acmeEmail = String(formData.get("acmeEmail") ?? "").trim();
    // The CA only refuses a malformed contact at the next issuance, long after this save.
    if (acmeEmail !== "" && !isEmailAddress(acmeEmail, "public")) {
      throw domainError("emailInvalid");
    }
    await saveGeneralSettings({
      defaultDomain: String(formData.get("defaultDomain") ?? ""),
      acmeEmail: acmeEmail || undefined,
    });
    revalidatePath("/settings");
    return { success: true, message: t("results.generalSaved") };
  } catch (error) {
    console.error("Failed to save general settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.generalFailed")),
    };
  }
}

async function updateAcmeSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();

    const caUrl = formData.get("caUrl") ? String(formData.get("caUrl")).trim() : "";
    const caRootPem = formData.get("caRootPem") ? String(formData.get("caRootPem")).trim() : "";

    if (caUrl) {
      let parsed: URL;
      try {
        parsed = new URL(caUrl);
      } catch {
        return { success: false, message: t("results.acmeInvalidUrl") };
      }
      if (parsed.protocol !== "https:") {
        return { success: false, message: t("results.acmeHttpsRequired") };
      }
    }

    await saveAcmeSettings({
      caUrl: caUrl.length > 0 ? caUrl : undefined,
      caRootPem: caRootPem.length > 0 ? caRootPem : undefined,
    });

    try {
      await applyCaddyConfig();
      revalidatePath("/settings");
      return { success: true, message: t("results.acmeSaved") };
    } catch (error) {
      console.error("Failed to apply Caddy config:", error);
      revalidatePath("/settings");
      const errorMsg = await errorText(error, t("results.unknownError"));
      return {
        success: true,
        message: t("results.applyFailed", { error: errorMsg }),
      };
    }
  } catch (error) {
    console.error("Failed to save ACME settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.acmeFailed")),
    };
  }
}

async function updateCloudflareSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();
    const rawToken = formData.get("apiToken") ? String(formData.get("apiToken")).trim() : "";
    const clearToken = formData.get("clearToken") === "on";
    const current = await getSetting<CloudflareSettings>("cloudflare");

    const apiToken = clearToken ? "" : rawToken || current?.apiToken || "";
    const zoneId = formData.get("zoneId") ? String(formData.get("zoneId")) : undefined;
    const accountId = formData.get("accountId") ? String(formData.get("accountId")) : undefined;

    await saveCloudflareSettings({
      apiToken,
      zoneId: zoneId && zoneId.length > 0 ? zoneId : undefined,
      accountId: accountId && accountId.length > 0 ? accountId : undefined,
    });

    // Don't fail the save if Caddy is unreachable.
    try {
      await applyCaddyConfig();
      revalidatePath("/settings");
      return {
        success: true,
        message: t("results.cloudflareSaved"),
      };
    } catch (error) {
      console.error("Failed to apply Caddy config:", error);
      revalidatePath("/settings");
      const errorMsg = await errorText(error, t("results.unknownError"));
      return {
        success: true,
        message: t("results.cloudflareApplyFailed", { error: errorMsg }),
      };
    }
  } catch (error) {
    console.error("Failed to save Cloudflare settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.cloudflareFailed")),
    };
  }
}

async function updateDnsProviderSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();

    const action = String(formData.get("action") ?? "save").trim();
    const providerName = String(formData.get("provider") ?? "").trim();
    const current = await getDnsProviderSettings();
    const settings: DnsProviderSettings = current ?? { providers: {}, default: null };

    if (action === "remove") {
      if (!providerName || !settings.providers[providerName]) {
        return { success: false, message: t("results.dnsProviderNothingToRemove") };
      }
      const def = getProviderDefinition(providerName);
      delete settings.providers[providerName];
      if (settings.default === providerName) {
        const remaining = Object.keys(settings.providers);
        settings.default = remaining.length > 0 ? remaining[0] : null;
      }
      await saveDnsProviderSettings(settings);
      try {
        await applyCaddyConfig();
      } catch {
        /* non-fatal */
      }
      revalidatePath("/settings");
      const name = def?.displayName ?? providerName;
      return {
        success: true,
        message: settings.default
          ? t("results.dnsProviderRemovedNewDefault", { name, default: settings.default })
          : t("results.dnsProviderRemoved", { name }),
      };
    }

    if (action === "set-default") {
      const newDefault = providerName === "none" ? null : providerName;
      if (newDefault && !settings.providers[newDefault]) {
        return {
          success: false,
          message: t("results.dnsProviderNotConfigured", { name: providerName }),
        };
      }
      settings.default = newDefault;
      await saveDnsProviderSettings(settings);
      try {
        await applyCaddyConfig();
      } catch {
        /* non-fatal */
      }
      revalidatePath("/settings");
      return {
        success: true,
        message: newDefault
          ? t("results.dnsProviderDefaultSet", {
              name: getProviderDefinition(newDefault)?.displayName ?? newDefault,
            })
          : t("results.dnsProviderDefaultCleared"),
      };
    }

    if (!providerName || providerName === "none") {
      return { success: false, message: t("results.dnsProviderSelect") };
    }

    const def = getProviderDefinition(providerName);
    if (!def) {
      return { success: false, message: t("results.dnsProviderUnknown", { name: providerName }) };
    }

    const existingCreds = settings.providers[providerName];

    const credentials: Record<string, string> = {};
    for (const field of def.fields) {
      const rawValue = formData.get(`credential_${field.key}`);
      const value = rawValue ? String(rawValue).trim() : "";
      if (value) {
        credentials[field.key] = value;
      } else if (existingCreds?.[field.key]) {
        credentials[field.key] = existingCreds[field.key];
      }
    }

    for (const field of def.fields) {
      if (field.required && !credentials[field.key]) {
        return {
          success: false,
          message: t("results.dnsProviderFieldRequired", {
            field: dnsProviderFieldText(t, def, field).label,
            provider: def.displayName,
          }),
        };
      }
    }

    for (const field of def.fields) {
      if (
        field.type === "duration" &&
        credentials[field.key] &&
        !isValidDnsDuration(credentials[field.key])
      ) {
        return {
          success: false,
          message: t("results.dnsProviderFieldDuration", {
            field: dnsProviderFieldText(t, def, field).label,
          }),
        };
      }
    }

    settings.providers[providerName] = encryptProviderCredentials(providerName, credentials);

    if (!settings.default) {
      settings.default = providerName;
    }

    await saveDnsProviderSettings(settings);

    try {
      await applyCaddyConfig();
      revalidatePath("/settings");
      const isDefault = settings.default === providerName;
      return {
        success: true,
        message: isDefault
          ? t("results.dnsProviderSavedDefault", { name: def.displayName })
          : t("results.dnsProviderSaved", { name: def.displayName }),
      };
    } catch (error) {
      console.error("Failed to apply Caddy config:", error);
      revalidatePath("/settings");
      const errorMsg = await errorText(error, t("results.unknownError"));
      return {
        success: true,
        message: t("results.applyFailed", { error: errorMsg }),
      };
    }
  } catch (error) {
    console.error("Failed to save DNS provider settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.dnsProviderFailed")),
    };
  }
}

async function updateAuthentikSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();
    const outpostDomain = String(formData.get("outpostDomain") ?? "").trim();
    const outpostUpstream = String(formData.get("outpostUpstream") ?? "").trim();
    const authEndpoint = formData.get("authEndpoint")
      ? String(formData.get("authEndpoint")).trim()
      : undefined;

    if (!outpostDomain || !outpostUpstream) {
      return { success: false, message: t("results.authentikRequired") };
    }

    await saveAuthentikSettings({
      outpostDomain,
      outpostUpstream,
      authEndpoint: authEndpoint && authEndpoint.length > 0 ? authEndpoint : undefined,
    });

    revalidatePath("/settings");
    return { success: true, message: t("results.authentikSaved") };
  } catch (error) {
    console.error("Failed to save Authentik settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.authentikFailed")),
    };
  }
}

/** Prefill for a new host's forward-auth block; nothing is applied, each host carries its own. */
async function updateForwardAuthSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();
    const providerRaw = String(formData.get("forwardAuthProvider") ?? "").trim();
    const provider = providerRaw === "custom" ? "custom" : "authelia";
    const authUpstream = String(formData.get("forwardAuthUpstream") ?? "").trim();
    const authEndpoint = String(formData.get("forwardAuthEndpoint") ?? "").trim();

    if (!authUpstream) {
      return { success: false, message: t("results.forwardAuthRequired") };
    }

    await saveForwardAuthSettings({
      provider,
      authUpstream,
      authEndpoint: authEndpoint.length > 0 ? authEndpoint : undefined,
    });

    revalidatePath("/settings");
    return { success: true, message: t("results.forwardAuthSaved") };
  } catch (error) {
    console.error("Failed to save forward auth settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.forwardAuthFailed")),
    };
  }
}

/**
 * An empty secret field keeps the stored one: the form never receives it, so otherwise any
 * unrelated edit would wipe the credential and nodes would fail to re-register.
 */
async function updateTailscaleSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();

    const existing = (await getTailscaleSettings()) ?? defaultTailscaleSettings();
    const submittedAuthKey = String(formData.get("tailscaleAuthKey") ?? "").trim();
    const submittedToken = String(formData.get("tailscaleApiAccessToken") ?? "").trim();

    // Already encrypted when it comes from `existing`; encryptSecret leaves such a value alone.
    const authKey = submittedAuthKey.length > 0 ? submittedAuthKey : existing.authKey;
    const apiAccessToken = submittedToken.length > 0 ? submittedToken : existing.apiAccessToken;
    const validateAuthKey = parseCheckbox(formData.get("tailscaleValidateAuthKey"));
    const apiTailnet = String(formData.get("tailscaleApiTailnet") ?? "").trim() || "-";

    // Before the save, to keep a key Caddy will choke on out of the database.
    if (validateAuthKey && authKey) {
      const check = await checkTailscaleAuthKey({
        authKey: decryptSecret(authKey, "Tailscale auth key"),
        apiAccessToken: apiAccessToken
          ? decryptSecret(apiAccessToken, "Tailscale API access token")
          : "",
        tailnet: apiTailnet,
      });
      if (check.status === "rejected") {
        return {
          success: false,
          message: t("results.tailscaleKeyRejected", { reason: check.reason }),
        };
      }
      if (check.status === "unknown") {
        console.warn(`Tailscale auth key was not checked: ${check.reason}`);
      }
    }

    await saveTailscaleSettings({
      enabled: parseCheckbox(formData.get("tailscaleEnabled")),
      authKey,
      controlUrl: String(formData.get("tailscaleControlUrl") ?? "").trim(),
      ephemeral: parseCheckbox(formData.get("tailscaleEphemeral")),
      stateDir: String(formData.get("tailscaleStateDir") ?? "").trim(),
      tags: parseCsv(formData.get("tailscaleTags")),
      defaultNode: String(formData.get("tailscaleDefaultNode") ?? "").trim(),
      validateAuthKey,
      apiAccessToken,
      apiTailnet,
    });

    revalidatePath("/settings");
    // Nodes are registered by the Caddy config, so nothing happens until it is pushed.
    await applyCaddyConfig();
    return { success: true, message: t("results.tailscaleSaved") };
  } catch (error) {
    console.error("Failed to save Tailscale settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.tailscaleFailed")),
    };
  }
}

/**
 * An empty secret keeps the stored one, but only for the same provider: a key carried across a
 * switch could never verify, and that gate would refuse every local sign-in.
 */
async function updateCaptchaSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();

    const existing = await getCaptchaSettings();
    const rawProvider = String(formData.get("captchaProvider") ?? "none");
    const provider = isCaptchaProvider(rawProvider) ? rawProvider : "none";
    const siteKey = String(formData.get("captchaSiteKey") ?? "").trim();
    const submittedSecret = String(formData.get("captchaSecretKey") ?? "").trim();
    const capInstanceUrl = String(formData.get("captchaCapInstanceUrl") ?? "")
      .trim()
      .replace(/\/+$/, "");

    if (provider === "none") {
      // Kept rather than cleared, so switching it back on is one click.
      await saveCaptchaSettings({ ...existing, provider });
      revalidatePath("/settings");
      return { success: true, message: t("results.captchaDisabled") };
    }

    const secretKey = submittedSecret || (existing.provider === provider ? existing.secretKey : "");
    const fields = [siteKey, submittedSecret, capInstanceUrl];
    if (fields.some((field) => field.length > 2048 || hasForbiddenControlCharacter(field))) {
      return { success: false, message: t("results.captchaInvalid") };
    }
    if (!siteKey) return { success: false, message: t("results.captchaSiteKeyRequired") };
    if (!secretKey) return { success: false, message: t("results.captchaSecretKeyRequired") };
    if (provider === "cap" && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(capInstanceUrl)) {
      return { success: false, message: t("results.captchaCapUrlRequired") };
    }

    await saveCaptchaSettings({
      provider,
      siteKey,
      secretKey,
      capInstanceUrl: provider === "cap" ? capInstanceUrl : existing.capInstanceUrl,
    });
    revalidatePath("/settings");
    return { success: true, message: t("results.captchaSaved") };
  } catch (error) {
    console.error("Failed to save CAPTCHA settings:", error);
    return { success: false, message: await errorText(error, t("results.captchaFailed")) };
  }
}

async function updatePasswordPolicySettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();

    // The env var pins the behaviour; refuse rather than silently storing an overridden preference.
    if (config.auth.requirePasswordChangeOnLegacyHashFromEnv !== null) {
      return {
        success: false,
        message: t("results.passwordPolicyFromEnv"),
      };
    }

    const requireChangeOnLegacyHash = formData.get("requireChangeOnLegacyHash") === "on";
    await savePasswordPolicySettings({ requireChangeOnLegacyHash });

    revalidatePath("/settings");
    return {
      success: true,
      message: requireChangeOnLegacyHash
        ? t("results.passwordPolicyRequireChange")
        : t("results.passwordPolicyPromptDisabled"),
    };
  } catch (error) {
    console.error("Failed to save password policy settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.passwordPolicyFailed")),
    };
  }
}

async function updateAvatarSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();

    // AVATAR_GRAVATAR pins the behaviour; refuse rather than store an overridden preference.
    if (config.avatars.gravatarFromEnv !== null) {
      return {
        success: false,
        message: t("results.avatarsFromEnv"),
      };
    }

    const gravatarEnabled = formData.get("gravatarEnabled") === "on";
    await saveAvatarSettings({ gravatarEnabled });

    revalidatePath("/settings");
    revalidatePath("/users");
    revalidatePath("/profile");
    return {
      success: true,
      message: gravatarEnabled ? t("results.gravatarEnabled") : t("results.gravatarDisabled"),
    };
  } catch (error) {
    console.error("Failed to save avatar settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.avatarsFailed")),
    };
  }
}

async function updateAnalyticsSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();

    const enabled = formData.get("analyticsEnabled") === "on";
    const password = String(formData.get("clickhousePassword") ?? "");

    // ClickHouse will not start without a password, so "on with no password" can never work.
    if (enabled && password.trim().length === 0 && formData.get("hasPassword") !== "yes") {
      return {
        success: false,
        message: t("results.analyticsPasswordRequired"),
      };
    }

    await saveAnalyticsSettings({
      enabled,
      url: String(formData.get("clickhouseUrl") ?? ""),
      user: String(formData.get("clickhouseUser") ?? ""),
      password,
      database: String(formData.get("clickhouseDb") ?? ""),
      retentionDays: Number(formData.get("clickhouseRetentionDays") ?? 30),
    });

    revalidatePath("/settings");
    revalidatePath("/analytics");
    return {
      success: true,
      message: enabled ? t("results.analyticsEnabled") : t("results.analyticsDisabled"),
    };
  } catch (error) {
    console.error("Failed to save analytics settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.analyticsFailed")),
    };
  }
}

async function updateGeoipSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();

    const enabled = formData.get("geoipEnabled") === "on";
    const accountId = String(formData.get("geoipAccountId") ?? "");
    const licenseKey = String(formData.get("geoipLicenseKey") ?? "");
    const hasKey = formData.get("hasLicenseKey") === "yes" || licenseKey.trim().length > 0;

    await saveGeoipSettings({
      enabled,
      accountId,
      licenseKey,
      updateIntervalHours: Number(formData.get("geoipUpdateIntervalHours") ?? 24),
    });

    revalidatePath("/settings");
    revalidatePath("/proxy-hosts");
    if (!enabled) {
      return { success: true, message: t("geoipSavedDisabled") };
    }
    return {
      success: true,
      message:
        accountId.trim().length > 0 && hasKey
          ? t("geoipSavedEnabled")
          : t("geoipSavedNeedsCredentials"),
    };
  } catch (error) {
    console.error("Failed to save GeoIP settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.geoipFailed")),
    };
  }
}

/** Upload or remove in one action, so `remove` can be a submit button instead of a nested form. */
async function updateFaviconActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();

    if (formData.get("intent") === "remove") {
      await clearFavicon();
      revalidatePath("/", "layout");
      return { success: true, message: t("results.faviconRemoved") };
    }

    const file = formData.get("favicon");
    if (!(file instanceof File) || file.size === 0) {
      return { success: false, message: t("results.faviconChooseFile") };
    }

    await saveFavicon(file);
    // The icon is declared in the root layout, so every route's metadata is stale.
    revalidatePath("/", "layout");
    return { success: true, message: t("results.faviconUpdated") };
  } catch (error) {
    if (error instanceof FaviconValidationError) {
      return { success: false, message: await errorText(error, error.message) };
    }
    console.error("Failed to save the favicon:", error);
    return {
      success: false,
      message: await errorText(error, t("results.faviconFailed")),
    };
  }
}

/**
 * Keys outside the block are ignored rather than refused: React posts its own bookkeeping fields.
 * `saveSettings` validates the whole batch before writing, so one bad field changes nothing.
 */
async function updateRegistrySettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();

    const block = String(formData.get("registryBlock") ?? "");
    const [
      { REGISTRY_BLOCK_KEYS },
      { SETTINGS_BY_KEY, SettingValidationError },
      { isEnvOverridden, saveSettings },
    ] = await Promise.all([
      import("./registry-fields"),
      import("@/src/lib/settings/registry"),
      import("@/src/lib/settings/resolve"),
    ]);

    const keys = REGISTRY_BLOCK_KEYS[block];
    if (!keys) {
      return { success: false, message: t("results.registryUnknownBlock") };
    }

    const values: Record<string, unknown> = {};
    for (const key of keys) {
      const definition = SETTINGS_BY_KEY.get(key);
      if (!definition) continue;
      // Env-overridden fields are disabled and post nothing, which a checkbox would store as
      // false - to take effect the moment the variable is removed.
      if (isEnvOverridden(definition)) continue;

      const posted = formData.get(key);
      // A clear checkbox posts nothing; any other absent kind was not on this form.
      if (typeof definition.default === "boolean") {
        values[key] = posted === "on" || posted === "true";
      } else if (typeof posted === "string") {
        values[key] = posted;
      }
    }

    try {
      await saveSettings(values);
    } catch (error) {
      if (error instanceof SettingValidationError) {
        const [tRoot, { settingValidationMessage }] = await Promise.all([
          getTranslations(),
          import("@/src/lib/settings/messages"),
        ]);
        return { success: false, message: settingValidationMessage(tRoot, error) };
      }
      throw error;
    }

    // The auth instance caches these; drop it or the old policy stays live.
    const { invalidateProviderCache } = await import("@/src/lib/auth-server");
    invalidateProviderCache();

    // "layout" scope: the root layout and dashboard shell read the app name and sign-in policy.
    revalidatePath("/", "layout");
    return { success: true, message: t("results.registrySaved") };
  } catch (error) {
    console.error("Failed to save registry settings:", error);
    return { success: false, message: await errorText(error, t("results.registryFailed")) };
  }
}

/** Checks inline after saving: "never checked" straight after a save reads as a failed save. */
async function updateUpdateSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();

    const [registry, { saveSettings }] = await Promise.all([
      import("@/src/lib/settings/registry"),
      import("@/src/lib/settings/resolve"),
    ]);

    const enabled = formData.get("updateCheckEnabled") === "on";
    const values: Record<string, unknown> = { [registry.updateCheckEnabled.key]: enabled };

    // A disabled Astryx input submits nothing (see components/ui/FormBooleanControls), so absent
    // means "leave it alone" - not an empty string that wipes the repository.
    const repository = formData.get("updateImageRepository");
    if (typeof repository === "string" && repository.trim() !== "") {
      values[registry.updateImageRepository.key] = repository;
    }

    await saveSettings(values);

    revalidatePath("/", "layout");
    if (!enabled) {
      return { success: true, message: t("results.updatesDisabled") };
    }

    const result = await checkForUpdates();
    return result.error
      ? {
          success: false,
          message: t("results.updatesSavedCheckFailed", {
            error: storedErrorMessage(await getTranslations(), result.error, result.errorCode),
          }),
        }
      : {
          success: true,
          message: t("results.updatesSavedLatest", { latest: String(result.latest) }),
        };
  } catch (error) {
    console.error("Failed to save update settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.updatesFailed")),
    };
  }
}

/** Check now, ignoring how recently the last one ran. */
async function checkForUpdatesActionUnlocked(): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();
    const result = await checkForUpdates();
    revalidatePath("/", "layout");
    return result.error
      ? {
          success: false,
          message: storedErrorMessage(await getTranslations(), result.error, result.errorCode),
        }
      : { success: true, message: t("results.updatesLatest", { latest: String(result.latest) }) };
  } catch (error) {
    console.error("Update check failed:", error);
    return {
      success: false,
      message: await errorText(error, t("results.updatesCheckFailed")),
    };
  }
}

async function updateMetricsSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();
    const enabled = formData.get("enabled") === "on";
    const portStr = formData.get("port") ? String(formData.get("port")).trim() : "";
    const port = portStr && !Number.isNaN(Number(portStr)) ? Number(portStr) : 9090;

    await saveMetricsSettings({
      enabled,
      port,
    });

    try {
      await applyCaddyConfig();
      revalidatePath("/settings");
      return { success: true, message: t("results.metricsSaved") };
    } catch (error) {
      console.error("Failed to apply Caddy config:", error);
      revalidatePath("/settings");
      const errorMsg = await errorText(error, t("results.unknownError"));
      return {
        success: true,
        message: t("results.applyFailed", { error: errorMsg }),
      };
    }
  } catch (error) {
    console.error("Failed to save metrics settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.metricsFailed")),
    };
  }
}

async function updateLoggingSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();
    const enabled = formData.get("enabled") === "on";
    const format = formData.get("format") ? String(formData.get("format")).trim() : "json";

    if (format !== "json" && format !== "console") {
      return { success: false, message: t("results.loggingInvalidFormat") };
    }

    await saveLoggingSettings({
      enabled,
      format: format as "json" | "console",
    });

    try {
      await applyCaddyConfig();
      revalidatePath("/settings");
      return { success: true, message: t("results.loggingSaved") };
    } catch (error) {
      console.error("Failed to apply Caddy config:", error);
      revalidatePath("/settings");
      const errorMsg = await errorText(error, t("results.unknownError"));
      return {
        success: true,
        message: t("results.applyFailed", { error: errorMsg }),
      };
    }
  } catch (error) {
    console.error("Failed to save logging settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.loggingFailed")),
    };
  }
}

function parseResolverList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Switching this off can remove the reader's own route here - deliberately, since
 * `http://<host>:3000` still works; the form warns first when the request came that way.
 */
async function updateDashboardSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();

    const domain = String(formData.get("domain") ?? "").trim();
    const current = await getDashboardSettings();
    const settings = validateSettingsGroup("dashboard", {
      enabled: formData.get("enabled") === "on",
      domain,
      tls: formData.get("tls") === "on",
      // Through the proxy host model, so the options meet the checks a stored host's would.
      options: await readDashboardHostOptions(formData, current?.options, domain),
    }) as DashboardHostSettings;

    await saveDashboardSettings(settings);

    try {
      await applyCaddyConfig();
      revalidatePath("/settings");
      return { success: true, message: t("results.dashboardSaved") };
    } catch (error) {
      console.error("Failed to apply Caddy config:", error);
      revalidatePath("/settings");
      const errorMsg = await errorText(error, t("results.unknownError"));
      return { success: true, message: t("results.dashboardApplyFailed", { error: errorMsg }) };
    }
  } catch (error) {
    console.error("Failed to save dashboard settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.dashboardFailed")),
    };
  }
}

/**
 * No argument on purpose: it checks the *saved*, validated domain, since taking the typed one
 * would make form input the host of a server-side request (SSRF).
 */
export async function checkDashboardDnsAction(): Promise<DashboardDnsCheck> {
  await requireAdmin();
  const saved = await getDashboardSettings();
  return await checkDashboardDns(saved?.domain ?? "");
}

async function updateTrustedProxiesSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();

    const ranges = parseResolverList(
      formData.get("ranges") ? String(formData.get("ranges")) : null,
    );
    const clientIpHeaders = parseResolverList(
      formData.get("clientIpHeaders") ? String(formData.get("clientIpHeaders")) : null,
    );
    const strict = formData.get("strict") === "on";
    const defaultGeoblock = formData.get("defaultGeoblock") === "on";

    await saveTrustedProxiesSettings({
      ranges,
      client_ip_headers: clientIpHeaders.length > 0 ? clientIpHeaders : undefined,
      strict: strict || undefined,
      default_geoblock: defaultGeoblock || undefined,
    });

    try {
      await applyCaddyConfig();
      revalidatePath("/settings");
      return { success: true, message: t("results.trustedProxiesSaved") };
    } catch (error) {
      console.error("Failed to apply Caddy config:", error);
      revalidatePath("/settings");
      const errorMsg = await errorText(error, t("results.unknownError"));
      return {
        success: true,
        message: t("results.applyFailed", { error: errorMsg }),
      };
    }
  } catch (error) {
    console.error("Failed to save trusted proxies settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.trustedProxiesFailed")),
    };
  }
}

async function updateHttpProtocolsSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();
    await saveHttpProtocolsSettings({
      http2: formData.get("http2") === "on",
      http3: formData.get("http3") === "on",
    });
    try {
      await applyCaddyConfig();
      revalidatePath("/settings");
      return { success: true, message: t("results.httpProtocolsSaved") };
    } catch (error) {
      console.error("Failed to apply Caddy config:", error);
      revalidatePath("/settings");
      return {
        success: true,
        message: t("results.applyFailed", {
          error: await errorText(error, t("results.unknownError")),
        }),
      };
    }
  } catch (error) {
    console.error("Failed to save HTTP protocol settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.httpProtocolsFailed")),
    };
  }
}

async function updateHttpCacheSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  const field = (name: string) => String(formData.get(name) ?? "");
  try {
    await requireAdmin();
    // A blank secret keeps the stored one; saveHttpCacheSettings fills it in.
    await saveHttpCacheSettings({
      storage: field("storage"),
      otterSize: field("otterSize"),
      redis: {
        addresses: field("redisAddresses"),
        username: field("redisUsername"),
        password: field("redisPassword"),
        db: field("redisDb"),
      },
      etcd: { endpoints: field("etcdEndpoints") },
      cdn: {
        provider: field("cdnProvider"),
        apiKey: field("cdnApiKey"),
        email: field("cdnEmail"),
        zoneId: field("cdnZoneId"),
        serviceId: field("cdnServiceId"),
        strategy: field("cdnStrategy"),
      },
    });
    try {
      await applyCaddyConfig();
      revalidatePath("/settings");
      return { success: true, message: t("results.httpCacheSaved") };
    } catch (error) {
      console.error("Failed to apply Caddy config:", error);
      revalidatePath("/settings");
      return {
        success: true,
        message: t("results.applyFailed", {
          error: await errorText(error, t("results.unknownError")),
        }),
      };
    }
  } catch (error) {
    console.error("Failed to save the HTTP cache settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.httpCacheFailed")),
    };
  }
}

async function updateGlobalCaddyConfigActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();
    await saveGlobalCaddyConfigSettings({ caddyfile: String(formData.get("caddyfile") ?? "") });
    try {
      await applyCaddyConfig();
      revalidatePath("/settings");
      return { success: true, message: t("results.globalCaddyConfigSaved") };
    } catch (error) {
      console.error("Failed to apply Caddy config:", error);
      revalidatePath("/settings");
      return {
        success: true,
        message: t("results.applyFailed", {
          error: await errorText(error, t("results.unknownError")),
        }),
      };
    }
  } catch (error) {
    console.error("Failed to save the global Caddyfile:", error);
    return {
      success: false,
      message: await errorText(error, t("results.globalCaddyConfigFailed")),
    };
  }
}

async function updateTwoFactorPolicySettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();
    await saveTwoFactorPolicySettings({
      requireForAdmins: formData.get("requireForAdmins") === "on",
    });
    revalidatePath("/settings");
    return { success: true, message: t("results.twoFactorPolicySaved") };
  } catch (error) {
    console.error("Failed to save two-factor policy:", error);
    return {
      success: false,
      message: await errorText(error, t("results.twoFactorPolicyFailed")),
    };
  }
}

async function updateDnsSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();
    const enabled = formData.get("enabled") === "on";
    const resolversRaw = formData.get("resolvers") ? String(formData.get("resolvers")) : "";
    const fallbacksRaw = formData.get("fallbacks") ? String(formData.get("fallbacks")) : "";
    const timeout = formData.get("timeout") ? String(formData.get("timeout")).trim() : undefined;

    const resolvers = parseResolverList(resolversRaw);
    const fallbacks = parseResolverList(fallbacksRaw);

    if (enabled && resolvers.length === 0) {
      return { success: false, message: t("results.dnsResolverRequired") };
    }

    await saveDnsSettings({
      enabled,
      resolvers,
      fallbacks: fallbacks.length > 0 ? fallbacks : undefined,
      timeout: timeout && timeout.length > 0 ? timeout : undefined,
    });

    try {
      await applyCaddyConfig();
      revalidatePath("/settings");
      return { success: true, message: t("results.dnsSaved") };
    } catch (error) {
      console.error("Failed to apply Caddy config:", error);
      revalidatePath("/settings");
      const errorMsg = await errorText(error, t("results.unknownError"));
      return {
        success: true,
        message: t("results.applyFailed", { error: errorMsg }),
      };
    }
  } catch (error) {
    console.error("Failed to save DNS settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.dnsFailed")),
    };
  }
}

async function updateUpstreamDnsResolutionSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();

    const enabled = formData.get("enabled") === "on";
    const familyRaw = formData.get("family") ? String(formData.get("family")).trim() : "both";
    if (
      !VALID_UPSTREAM_DNS_FAMILIES.includes(
        familyRaw as (typeof VALID_UPSTREAM_DNS_FAMILIES)[number],
      )
    ) {
      return { success: false, message: t("results.upstreamDnsInvalidFamily") };
    }

    await saveUpstreamDnsResolutionSettings({
      enabled,
      family: familyRaw as "ipv6" | "ipv4" | "both",
    });

    try {
      await applyCaddyConfig();
      revalidatePath("/settings");
      return {
        success: true,
        message: t("results.upstreamDnsSaved"),
      };
    } catch (error) {
      console.error("Failed to apply Caddy config:", error);
      revalidatePath("/settings");
      const errorMsg = await errorText(error, t("results.unknownError"));
      return {
        success: true,
        message: t("results.applyFailed", { error: errorMsg }),
      };
    }
  } catch (error) {
    console.error("Failed to save upstream DNS resolution settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.upstreamDnsFailed")),
    };
  }
}

function parseRedirectUrl(raw: FormDataEntryValue | null): string {
  if (!raw || typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return trimmed;
  } catch {
    return "";
  }
}

function parseGeoBlockStringList(key: string, formData: FormData): string[] {
  const val = formData.get(key);
  if (!val || typeof val !== "string") return [];
  return val
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseGeoBlockNumberList(key: string, formData: FormData): number[] {
  return parseGeoBlockStringList(key, formData)
    .map((s) => parseInt(s, 10))
    .filter((n) => !Number.isNaN(n));
}

function parseGeoBlockResponseHeaders(formData: FormData): Record<string, string> {
  const keys = formData.getAll("geoblockResponseHeadersKeys[]") as string[];
  const values = formData.getAll("geoblockResponseHeadersValues[]") as string[];
  const headers: Record<string, string> = {};
  keys.forEach((key, i) => {
    const trimmed = key.trim();
    if (trimmed && /^[a-zA-Z0-9\-_]+$/.test(trimmed)) {
      headers[trimmed] = (values[i] ?? "").trim();
    }
  });
  return headers;
}

async function updateGeoBlockSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();

    const enabled = parseCheckbox(formData.get("geoblockEnabled"));

    const statusRaw = formData.get("geoblockResponseStatus");
    const statusNum =
      statusRaw && typeof statusRaw === "string" && statusRaw.trim() !== ""
        ? Number(statusRaw.trim())
        : NaN;
    const responseStatus =
      Number.isFinite(statusNum) && statusNum >= 100 && statusNum <= 599 ? statusNum : 403;

    const responseBodyRaw = formData.get("geoblockResponseBody");
    const responseBody =
      responseBodyRaw && typeof responseBodyRaw === "string" && responseBodyRaw.trim().length > 0
        ? responseBodyRaw.trim()
        : "Forbidden";

    const redirectUrlRaw = formData.get("geoblockRedirectUrl");
    const redirectUrl = parseRedirectUrl(redirectUrlRaw);

    const config: GeoBlockSettings = {
      enabled,
      block_countries: parseGeoBlockStringList("geoblockBlockCountries", formData),
      block_continents: parseGeoBlockStringList("geoblockBlockContinents", formData),
      block_asns: parseGeoBlockNumberList("geoblockBlockAsns", formData),
      block_cidrs: parseGeoBlockStringList("geoblockBlockCidrs", formData),
      block_ips: parseGeoBlockStringList("geoblockBlockIps", formData),
      allow_countries: parseGeoBlockStringList("geoblockAllowCountries", formData),
      allow_continents: parseGeoBlockStringList("geoblockAllowContinents", formData),
      allow_asns: parseGeoBlockNumberList("geoblockAllowAsns", formData),
      allow_cidrs: parseGeoBlockStringList("geoblockAllowCidrs", formData),
      allow_ips: parseGeoBlockStringList("geoblockAllowIps", formData),
      trusted_proxies: parseGeoBlockStringList("geoblockTrustedProxies", formData),
      fail_closed: parseCheckbox(formData.get("geoblockFailClosed")),
      response_status: responseStatus,
      response_body: responseBody,
      response_headers: parseGeoBlockResponseHeaders(formData),
      redirect_url: redirectUrl,
    };

    await saveGeoBlockSettings(config);

    try {
      await applyCaddyConfig();
      revalidatePath("/settings");
      return { success: true, message: t("results.geoblockSaved") };
    } catch (error) {
      console.error("Failed to apply Caddy config:", error);
      revalidatePath("/settings");
      const errorMsg = await errorText(error, t("results.unknownError"));
      return {
        success: true,
        message: t("results.applyFailed", { error: errorMsg }),
      };
    }
  } catch (error) {
    console.error("Failed to save geoblocking settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.geoblockFailed")),
    };
  }
}

async function updateErrorPagesSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();

    const raw = formData.get("errorPagesJson");
    let rules: ReturnType<typeof sanitizeErrorPageRules> = [];
    if (raw && typeof raw === "string") {
      try {
        rules = sanitizeErrorPageRules(JSON.parse(raw));
      } catch {
        return { success: false, message: t("results.errorPagesInvalid") };
      }
    }

    await saveErrorPagesSettings({ rules });

    try {
      await applyCaddyConfig();
      revalidatePath("/settings");
      return { success: true, message: t("results.errorPagesSaved") };
    } catch (error) {
      console.error("Failed to apply Caddy config:", error);
      revalidatePath("/settings");
      const errorMsg = await errorText(error, t("results.unknownError"));
      return {
        success: true,
        message: t("results.applyFailed", { error: errorMsg }),
      };
    }
  } catch (error) {
    console.error("Failed to save error pages settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.errorPagesFailed")),
    };
  }
}

async function updateDefaultResponseSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();

    const responseMode = String(formData.get("mode") ?? "caddy");
    let next: DefaultResponseSettings;
    if (responseMode === "caddy" || responseMode === "abort") {
      next = { mode: responseMode };
    } else if (responseMode === "respond") {
      next = {
        mode: "respond",
        status: Number(formData.get("status") ?? 404),
        body: String(formData.get("body") ?? ""),
        headers: parseDefaultResponseHeaders(formData.get("headers")),
      };
    } else if (responseMode === "redirect") {
      next = {
        mode: "redirect",
        status: Number(formData.get("status") ?? 302),
        redirectUrl: String(formData.get("redirectUrl") ?? ""),
        headers: parseDefaultResponseHeaders(formData.get("headers")),
      };
    } else {
      return { success: false, message: t("results.defaultResponseInvalidMode") };
    }

    await saveDefaultResponseSettings(next);

    try {
      await applyCaddyConfig();
      revalidatePath("/settings");
      return { success: true, message: t("results.defaultResponseSaved") };
    } catch (error) {
      console.error("Failed to apply Caddy config:", error);
      revalidatePath("/settings");
      const errorMsg = await errorText(error, t("results.unknownError"));
      return {
        success: true,
        message: t("results.applyFailed", { error: errorMsg }),
      };
    }
  } catch (error) {
    console.error("Failed to save default response settings:", error);
    return {
      success: false,
      message: extractErrorMessage(
        await getTranslations(),
        error,
        t("results.defaultResponseFailed"),
      ),
    };
  }
}

export async function lookupWafRuleMessageAction(
  ruleId: number,
): Promise<{ message: string | null }> {
  await requireAdmin();
  const map = await getWafRuleMessages([ruleId]);
  return { message: map[ruleId] ?? null };
}

async function removeWafRuleGloballyActionUnlocked(ruleId: number): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();
    const current = await getWafSettings();
    if (!current) return { success: false, message: t("results.wafSettingsNotFound") };
    const ids = (current.excluded_rule_ids ?? []).filter((id) => id !== ruleId);
    await saveWafSettings({ ...current, excluded_rule_ids: ids });
    try {
      await applyCaddyConfig();
    } catch {
      /* non-fatal */
    }
    revalidatePath("/settings");
    revalidatePath("/waf");
    // Rule ids are strings here: ICU would group 942100 as "942,100".
    return { success: true, message: t("results.wafRuleUnexcluded", { ruleId: String(ruleId) }) };
  } catch (error) {
    return {
      success: false,
      message: await errorText(error, t("results.wafRemoveFailed")),
    };
  }
}

async function suppressWafRuleGloballyActionUnlocked(ruleId: number): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();
    const current = await getWafSettings();
    const base = current ?? {
      enabled: false,
      mode: "Off" as const,
      load_owasp_crs: true,
      custom_directives: "",
      excluded_rule_ids: [],
    };
    const ids = [...new Set([...(base.excluded_rule_ids ?? []), ruleId])];
    await saveWafSettings({ ...base, excluded_rule_ids: ids });
    try {
      await applyCaddyConfig();
    } catch {
      revalidatePath("/settings");
      return {
        success: true,
        message: t("results.wafRuleExcludedReloadFailed", { ruleId: String(ruleId) }),
      };
    }
    revalidatePath("/settings");
    revalidatePath("/waf");
    return { success: true, message: t("results.wafRuleSuppressed", { ruleId: String(ruleId) }) };
  } catch (error) {
    console.error("Failed to suppress WAF rule:", error);
    return {
      success: false,
      message: await errorText(error, t("results.wafSuppressFailed")),
    };
  }
}

export async function getOAuthProvidersAction() {
  await requireAdmin();
  const { listOAuthProviders } = await import("@/src/lib/models/oauth-providers");
  return listOAuthProviders();
}

export async function createOAuthProviderAction(data: {
  name: string;
  type: string;
  clientId: string;
  clientSecret: string;
  issuer?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  scopes?: string;
  autoLink?: boolean;
  groupsClaim?: string;
  groupPrefix?: string | null;
  roleMappingEnabled?: boolean;
  adminGroup?: string | null;
  operatorGroup?: string | null;
  userGroup?: string | null;
  viewerGroup?: string | null;
  defaultRole?: AppRole;
  syncGroups?: boolean;
}) {
  const session = await requireAdmin();
  const { createOAuthProvider } = await import("@/src/lib/models/oauth-providers");
  const { invalidateProviderCache } = await import("@/src/lib/auth-server");
  const provider = await createOAuthProvider({ ...data, source: "ui" });
  invalidateProviderCache();
  const { createAuditEvent } = await import("@/src/lib/models/audit");
  await createAuditEvent({
    userId: Number(session.user.id),
    action: "oauth_provider_created",
    entityType: "oauth_provider",
    entityId: null,
    summary: `OAuth provider "${data.name}" created`,
    data: JSON.stringify({ providerId: provider.id }),
  });
  revalidatePath("/settings");
  return toOAuthProviderView(provider);
}

/**
 * Null means alphabetical. Not on the provider row, which would make every write police
 * "exactly one primary".
 */
export async function setPrimaryOAuthProviderAction(id: string | null): Promise<void> {
  const session = await requireAdmin();
  const { setPrimaryProviderId } = await import("@/src/lib/models/oauth-providers");
  await setPrimaryProviderId(id);
  const { createAuditEvent } = await import("@/src/lib/models/audit");
  await createAuditEvent({
    userId: Number(session.user.id),
    action: "oauth_provider_updated",
    entityType: "oauth_provider",
    entityId: null,
    summary: id ? `Made OAuth provider "${id}" primary` : "Cleared the primary OAuth provider",
    data: JSON.stringify({ primaryProviderId: id }),
  });
}

export async function updateOAuthProviderAction(
  id: string,
  data: Partial<{
    name: string;
    type: string;
    clientId: string;
    clientSecret: string;
    issuer: string | null;
    authorizationUrl: string | null;
    tokenUrl: string | null;
    userinfoUrl: string | null;
    scopes: string;
    autoLink: boolean;
    enabled: boolean;
    groupsClaim: string;
    groupPrefix: string | null;
    roleMappingEnabled: boolean;
    adminGroup: string | null;
    operatorGroup: string | null;
    userGroup: string | null;
    viewerGroup: string | null;
    defaultRole: AppRole;
    syncGroups: boolean;
  }>,
) {
  const session = await requireAdmin();
  const { updateOAuthProvider } = await import("@/src/lib/models/oauth-providers");
  const { invalidateProviderCache } = await import("@/src/lib/auth-server");
  const updated = await updateOAuthProvider(id, data);
  invalidateProviderCache();
  const { createAuditEvent } = await import("@/src/lib/models/audit");
  await createAuditEvent({
    userId: Number(session.user.id),
    action: "oauth_provider_updated",
    entityType: "oauth_provider",
    entityId: null,
    summary: `Updated OAuth provider "${id}"`,
    data: JSON.stringify({ providerId: id, fields: Object.keys(data) }),
  });
  revalidatePath("/settings");
  return updated ? toOAuthProviderView(updated) : null;
}

export async function deleteOAuthProviderAction(id: string) {
  const session = await requireAdmin();
  const { getOAuthProvider, deleteOAuthProvider } = await import(
    "@/src/lib/models/oauth-providers"
  );
  const { invalidateProviderCache } = await import("@/src/lib/auth-server");
  const existing = await getOAuthProvider(id);
  await deleteOAuthProvider(id);
  invalidateProviderCache();
  const { createAuditEvent } = await import("@/src/lib/models/audit");
  await createAuditEvent({
    userId: Number(session.user.id),
    action: "oauth_provider_deleted",
    entityType: "oauth_provider",
    entityId: null,
    summary: `Deleted OAuth provider "${existing?.name ?? id}"`,
    data: JSON.stringify({ providerId: id }),
  });
  revalidatePath("/settings");
}

export async function suppressWafRuleForHostAction(
  ruleId: number,
  hostname: string,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    const session = await requireAdmin();
    const userId = Number(session.user.id);
    const hosts = await listProxyHosts();
    const bareHostname = hostname.replace(/:\d+$/, "");
    const host = hosts.find((h) => h.domains.includes(bareHostname));
    if (!host) {
      return { success: false, message: t("results.wafNoHost", { hostname }) };
    }
    const existingWaf = host.waf ?? { enabled: true, waf_mode: "merge" as const };
    const ids = [...new Set([...(existingWaf.excluded_rule_ids ?? []), ruleId])];
    await updateProxyHost(
      host.id,
      {
        waf: {
          ...existingWaf,
          enabled: true,
          waf_mode: existingWaf.waf_mode ?? "merge",
          excluded_rule_ids: ids,
        },
      },
      userId,
    );
    revalidatePath("/proxy-hosts");
    revalidatePath("/waf");
    return {
      success: true,
      message: t("results.wafRuleSuppressedForHost", { ruleId: String(ruleId), hostname }),
    };
  } catch (error) {
    console.error("Failed to suppress WAF rule for host:", error);
    return {
      success: false,
      message: await errorText(error, t("results.wafSuppressFailed")),
    };
  }
}

async function updateWafSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();

    const enabled = formData.get("wafEnabled") === "on";
    const mode: WafSettings["mode"] = enabled ? "On" : "Off";
    const loadOwasp = formData.get("wafLoadOwaspCrs") === "on";
    const customDirectives =
      typeof formData.get("wafCustomDirectives") === "string"
        ? (formData.get("wafCustomDirectives") as string).trim()
        : "";
    const existing = await getWafSettings();
    // Only what this save newly drops: a stored rule a later release started dropping must not
    // block unrelated fields, and buildWafHandler still leaves it out and says so.
    const directiveError = customDirectivesError(
      customDirectives,
      { crsLoaded: loadOwasp },
      {
        directives: existing?.custom_directives,
        options: { crsLoaded: Boolean(existing?.load_owasp_crs) },
      },
    );
    if (directiveError) throw directiveError;
    const rawExcl = formData.get("wafExcludedRuleIds");
    let excluded_rule_ids: number[];
    if (rawExcl !== null) {
      excluded_rule_ids = (JSON.parse(rawExcl as string) as unknown[]).filter(
        (x): x is number => Number.isInteger(x) && (x as number) > 0,
      );
    } else {
      excluded_rule_ids = existing?.excluded_rule_ids ?? [];
    }
    const rawPresets = formData.get("wafPresetIds");
    const preset_ids =
      typeof rawPresets === "string"
        ? normalizeWafPresetIds(JSON.parse(rawPresets))
        : (existing?.preset_ids ?? []);
    await assertWafPresetIdsExist(preset_ids);
    const rawPlugins = formData.get("wafPluginIds");
    const plugin_ids =
      typeof rawPlugins === "string"
        ? normalizeWafPluginIds(JSON.parse(rawPlugins))
        : (existing?.plugin_ids ?? []);
    await assertCrsPluginIdsExist(plugin_ids);

    const requestBodyLimit = parseBodyLimitMib(
      formData.get("wafRequestBodyLimitMb"),
      "wafRequestBodyLimitInvalid",
    );
    const requestBodyInMemoryLimit = parseBodyLimitMib(
      formData.get("wafRequestBodyInMemoryLimitMb"),
      "wafInMemoryBodyLimitInvalid",
    );
    const rawAction = formData.get("wafRequestBodyLimitAction");
    const requestBodyLimitAction =
      rawAction === "Reject" || rawAction === "ProcessPartial" ? rawAction : undefined;
    if (
      requestBodyLimit !== undefined &&
      requestBodyInMemoryLimit !== undefined &&
      requestBodyInMemoryLimit > requestBodyLimit
    ) {
      return {
        success: false,
        message: t("results.wafBodyLimitExceeded"),
      };
    }

    const config: WafSettings = {
      enabled,
      mode,
      load_owasp_crs: loadOwasp,
      custom_directives: customDirectives,
      excluded_rule_ids,
      ...(preset_ids.length > 0 ? { preset_ids } : {}),
      ...(plugin_ids.length > 0 ? { plugin_ids } : {}),
      ...(requestBodyLimit !== undefined ? { request_body_limit: requestBodyLimit } : {}),
      ...(requestBodyInMemoryLimit !== undefined
        ? { request_body_in_memory_limit: requestBodyInMemoryLimit }
        : {}),
      ...(requestBodyLimitAction ? { request_body_limit_action: requestBodyLimitAction } : {}),
    };
    await saveWafSettings(config);

    try {
      await applyCaddyConfig();
    } catch (err) {
      const errorMsg = await errorText(err, String(err));
      return {
        success: true,
        message: t("results.applyFailed", { error: errorMsg }),
      };
    }

    revalidatePath("/settings");
    revalidatePath("/waf");
    return { success: true, message: t("results.wafSaved") };
  } catch (error) {
    console.error("Failed to save WAF settings:", error);
    return {
      success: false,
      message: extractErrorMessage(await getTranslations(), error, t("results.wafFailed")),
    };
  }
}

// ─── Caddy Build ─────────────────────────────────────────────────────────────

/**
 * Applies config so a disabled module stops emitting handlers before its plugin vanishes.
 * `agentRowId` 0 is the fleet default; `followFleetDefault` clears rather than copies it, or the
 * agent would stay frozen at today's default.
 */
async function updateCaddyBuildSettingsActionUnlocked(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const t = await getTranslations("settings");
  try {
    await requireAdmin();

    const agentRowIdRaw = Number.parseInt(String(formData.get("agentRowId") ?? "0"), 10);
    const agentRowId =
      Number.isInteger(agentRowIdRaw) && agentRowIdRaw > 0 ? agentRowIdRaw : undefined;

    if (agentRowId !== undefined && formData.get("followFleetDefault") === "1") {
      await setAgentBuildSettings(agentRowId, null);
      await pushDesiredState();
      revalidatePath("/settings");
      return { success: true, message: t("results.caddyBuildFollowsFleet") };
    }

    const modules: Record<string, boolean> = {};
    for (const module of CADDY_MODULES) {
      // An unchecked box submits nothing, so read every known module explicitly.
      modules[module.id] = formData.get(`module:${module.id}`) === "on";
    }

    const customModules = parseCustomModules(formData.get("customModulesJson"));
    const settings = sanitizeCaddyBuildSettings({ modules, customModules });

    // Otherwise the rebuild succeeds and an in-use feature silently stops.
    const conflicts = await findModuleConflicts(settings, agentRowId);
    if (conflicts.length > 0) {
      return {
        success: false,
        message: moduleConflictMessage(await getTranslations(), conflicts) ?? "",
      };
    }

    if (agentRowId === undefined) {
      await saveCaddyBuildSettings(settings);
    } else {
      await setAgentBuildSettings(agentRowId, settings);
    }
    // The module set is part of desired state, so the agent learns what to build from this.
    await pushDesiredState();

    const diff = await getCaddyBuildDiff(agentRowId);
    // Advisory, not a refusal. One message, so a translator decides how it follows the saved one.
    const snippetWarning = await describeCaddyfileSnippetWarning(settings);
    const saved = snippetWarning
      ? t("results.caddyBuildSavedSnippetWarning", {
          rebuild: diff.needsRebuild ? "yes" : "no",
          count: snippetWarning.count,
          names: (await getFormatter()).list(snippetWarning.names, { type: "unit" }),
          more: snippetWarning.more,
        })
      : diff.needsRebuild
        ? t("results.caddyBuildSavedRebuild")
        : t("results.caddyBuildSaved");

    try {
      await applyCaddyConfig();
      revalidatePath("/settings");
      return { success: true, message: saved };
    } catch (error) {
      console.error("Failed to apply Caddy config:", error);
      revalidatePath("/settings");
      const errorMsg = await errorText(error, t("results.unknownError"));
      return {
        success: true,
        message: t("results.caddyBuildApplyFailed", { error: errorMsg }),
      };
    }
  } catch (error) {
    console.error("Failed to save Caddy build settings:", error);
    return {
      success: false,
      message: await errorText(error, t("results.caddyBuildFailed")),
    };
  }
}

/** Write the compose override and signal the agent to rebuild. */
export async function rebuildCaddyAction(
  _prevState: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  void _formData;
  const t = await getTranslations();
  try {
    await requireAdmin();
    const status = await applyCaddyBuild();
    revalidatePath("/settings");
    return { success: true, message: status.message ?? t("settings.results.rebuildTriggered") };
  } catch (error) {
    console.error("Failed to trigger a Caddy rebuild:", error);
    return {
      success: false,
      message: extractErrorMessage(t, error, t("errors.rebuildCaddyFailed")),
    };
  }
}

function parseCustomModules(raw: FormDataEntryValue | null): CaddyCustomModule[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw domainError("customModulesUnreadable");
  }
  if (!Array.isArray(parsed)) return [];
  return parsed as CaddyCustomModule[];
}

export const updateGeneralSettingsAction = stagedSettingsAction(
  updateGeneralSettingsActionUnlocked,
);
export const updateAcmeSettingsAction = stagedSettingsAction(updateAcmeSettingsActionUnlocked);
export const updateCloudflareSettingsAction = stagedSettingsAction(
  updateCloudflareSettingsActionUnlocked,
);
export const updateDnsProviderSettingsAction = stagedSettingsAction(
  updateDnsProviderSettingsActionUnlocked,
);
export const updateAuthentikSettingsAction = stagedSettingsAction(
  updateAuthentikSettingsActionUnlocked,
);
export const updateForwardAuthSettingsAction = stagedSettingsAction(
  updateForwardAuthSettingsActionUnlocked,
);
export const updateMetricsSettingsAction = stagedSettingsAction(
  updateMetricsSettingsActionUnlocked,
);
export const updateLoggingSettingsAction = stagedSettingsAction(
  updateLoggingSettingsActionUnlocked,
);
export const updateTrustedProxiesSettingsAction = stagedSettingsAction(
  updateTrustedProxiesSettingsActionUnlocked,
);
export const updateHttpProtocolsSettingsAction = stagedSettingsAction(
  updateHttpProtocolsSettingsActionUnlocked,
);
export const updateGlobalCaddyConfigAction = stagedSettingsAction(
  updateGlobalCaddyConfigActionUnlocked,
);
export const updateHttpCacheSettingsAction = stagedSettingsAction(
  updateHttpCacheSettingsActionUnlocked,
);
export const updateTwoFactorPolicySettingsAction = stagedSettingsAction(
  updateTwoFactorPolicySettingsActionUnlocked,
);
export const updateDashboardSettingsAction = stagedSettingsAction(
  updateDashboardSettingsActionUnlocked,
);
export const updateDnsSettingsAction = stagedSettingsAction(updateDnsSettingsActionUnlocked);
export const updateUpstreamDnsResolutionSettingsAction = stagedSettingsAction(
  updateUpstreamDnsResolutionSettingsActionUnlocked,
);
export const updateGeoBlockSettingsAction = stagedSettingsAction(
  updateGeoBlockSettingsActionUnlocked,
);
export const updateErrorPagesSettingsAction = stagedSettingsAction(
  updateErrorPagesSettingsActionUnlocked,
);
export const updateDefaultResponseSettingsAction = stagedSettingsAction(
  updateDefaultResponseSettingsActionUnlocked,
);
export const updateTailscaleSettingsAction = stagedSettingsAction(
  updateTailscaleSettingsActionUnlocked,
);
export const removeWafRuleGloballyAction = serializedSettingsAction(
  removeWafRuleGloballyActionUnlocked,
);
export const suppressWafRuleGloballyAction = serializedSettingsAction(
  suppressWafRuleGloballyActionUnlocked,
);
export const updateWafSettingsAction = stagedSettingsAction(updateWafSettingsActionUnlocked);
export const updatePasswordPolicySettingsAction = stagedSettingsAction(
  updatePasswordPolicySettingsActionUnlocked,
);
export const updateAvatarSettingsAction = stagedSettingsAction(updateAvatarSettingsActionUnlocked);
export const updateCaddyBuildSettingsAction = serializedSettingsAction(
  updateCaddyBuildSettingsActionUnlocked,
);
export const updateFaviconAction = serializedSettingsAction(updateFaviconActionUnlocked);
export const updateUpdateSettingsAction = stagedSettingsAction(updateUpdateSettingsActionUnlocked);
// Not staged: none of these reach a Caddy config, so "Review & apply" has nothing to apply.
export const updateRegistrySettingsAction = serializedSettingsAction(
  updateRegistrySettingsActionUnlocked,
);
// Not staged, for the same reason: it guards this app's sign-in, not anything Caddy serves.
export const updateCaptchaSettingsAction = serializedSettingsAction(
  updateCaptchaSettingsActionUnlocked,
);
export const checkForUpdatesAction = serializedSettingsAction(checkForUpdatesActionUnlocked);
export const updateAnalyticsSettingsAction = serializedSettingsAction(
  updateAnalyticsSettingsActionUnlocked,
);
export const updateGeoipSettingsAction = serializedSettingsAction(
  updateGeoipSettingsActionUnlocked,
);

/** Not staged: it writes only the databases, and there is nothing for an operator to review. */
export async function updateGeoipDatabasesAction(): Promise<ActionResult> {
  try {
    await requireAdmin();
    const { updateGeoipDatabases } = await import("@/src/lib/geoip/updater");

    const result = await updateGeoipDatabases();
    revalidatePath("/settings", "layout");

    const t = await getTranslations("settings");
    if (result.skipped === "disabled") return { success: false, message: t("geoipUpdateDisabled") };
    if (result.skipped === "unconfigured") {
      return { success: false, message: t("geoipUpdateUnconfigured") };
    }
    if (result.error) {
      const { geoipUpdateErrorMessage } = await import("@/src/lib/geoip/messages");
      return {
        success: false,
        message: geoipUpdateErrorMessage(await getTranslations(), result) ?? result.error,
      };
    }
    return {
      success: true,
      message:
        result.downloaded.length > 0
          ? t("geoipDownloadedNow", { editions: result.downloaded.join(", ") })
          : t("geoipCheckedNow"),
    };
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to check MaxMind for updates:", error);
    return {
      success: false,
      message: extractErrorMessage(t, error, t("errors.geoipCheckFailed")),
    };
  }
}

// ─── Staged changes ──────────────────────────────────────────────────────────

/**
 * Not wrapped in `serializedSettingsAction`: `applyStagedSettings` locks around both the commit
 * and the push, so no staged write lands between them.
 */
export async function applyStagedSettingsAction(): Promise<ActionResult> {
  const t = await getTranslations();
  try {
    const session = await requireAdmin();
    const outcome = await applyStagedSettings(Number(session.user.id), session.user.name);
    revalidatePath("/settings", "layout");

    if (!outcome.ok) {
      // Only the push failed; "failed" would invite re-entering changes already committed.
      return {
        success: true,
        message: t("settings.results.stagedAppliedReloadFailed", {
          error: extractErrorMessage(t, outcome.cause, outcome.error),
        }),
      };
    }
    return {
      success: true,
      message: t("settings.results.stagedApplied", { revision: String(outcome.revision) }),
    };
  } catch (error) {
    console.error("Failed to apply staged settings:", error);
    return {
      success: false,
      message: extractErrorMessage(t, error, t("errors.applyStagedFailed")),
    };
  }
}

export async function discardStagedSettingsAction(key?: string): Promise<ActionResult> {
  try {
    const session = await requireAdmin();
    const userId = Number(session.user.id);
    if (key) {
      await discardStagedKey(userId, key);
    } else {
      await discardAllStaged(userId);
    }
    revalidatePath("/settings", "layout");
    return { success: true };
  } catch (error) {
    const t = await getTranslations();
    console.error("Failed to discard staged settings:", error);
    return {
      success: false,
      message: extractErrorMessage(t, error, t("errors.discardStagedFailed")),
    };
  }
}

/** Stage the values an earlier revision had. The operator applies it through the review sheet. */
export async function restoreRevisionAction(revision: number): Promise<ActionResult> {
  const t = await getTranslations();
  try {
    const session = await requireAdmin();
    const { staged } = await stageRevisionRestore(Number(session.user.id), revision);
    revalidatePath("/settings", "layout");
    return {
      success: true,
      staged: staged > 0,
      message: t("settings.history.restoreStaged", { count: staged, id: revision }),
    };
  } catch (error) {
    console.error("Failed to stage a revision restore:", error);
    return {
      success: false,
      message: extractErrorMessage(t, error, t("errors.restoreRevisionFailed")),
    };
  }
}

// ─── Agents ──────────────────────────────────────────────────────────────────

/**
 * Only the code comes back: the secret is minted at `/api/agent/v1/pair`, since an action's
 * return value is serialized to the browser.
 */
export async function pairingCodeAction(): Promise<{ code: string; expiresAt: number }> {
  await requireAdmin();
  const { code, expiresAt } = ensurePairingCode();
  return { code, expiresAt };
}

/** Throw the live code away, so the next read mints a fresh one. */
export async function revokePairingCodeAction(): Promise<void> {
  await requireAdmin();
  revokePairingCode();
  revalidatePath("/settings");
}

/**
 * The agent goes idle, which stops its Caddy. For the bundled agent this also turns auto-pairing
 * off, or it would find a fresh bootstrap token and pair straight back.
 */
export async function unpairAgentAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = Number(formData.get("agentId"));
  if (Number.isNaN(id)) return;
  const agentId = await deleteAgent(id);
  if (agentId) {
    revokeRepairCode(agentId);
    await forgetBootstrapAgent(agentId);
    detach(agentId);
  }
  revalidatePath("/settings");
}

export type RepairAgentResult =
  | { kind: "code"; code: string; expiresAt: number }
  | { kind: "bootstrap" }
  | { kind: "failed" };

/**
 * Recovery for a lost or undecryptable secret. The bundled agent gets a bootstrap token bound to
 * its id; any other gets a code that re-pairs it and nothing else.
 */
export async function repairAgentAction(agentRowId: number): Promise<RepairAgentResult> {
  await requireAdmin();
  const agent = await findAgentById(agentRowId);
  if (!agent) return { kind: "failed" };
  if (await isBundledAgent(agent.agentId)) {
    return issueBootstrapToken(agent.agentId) ? { kind: "bootstrap" } : { kind: "failed" };
  }
  const { code, expiresAt } = mintRepairCode(agent.agentId);
  return { kind: "code", code, expiresAt };
}

/** Let the bundled agent pair itself again, after unpairing it turned that off. */
export async function enableAutoPairingAction(): Promise<void> {
  await requireAdmin();
  await enableAutoPairing();
  revalidatePath("/settings");
}
