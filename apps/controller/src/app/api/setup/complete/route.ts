import { sessionCan } from "@/src/lib/users/permissions";
import type { NextRequest } from "next/server";
import { getFormatter, getTranslations } from "next-intl/server";
import { auth, checkSameOrigin } from "@/src/lib/auth";
import { extractErrorMessage } from "@/src/lib/errors/action-error";
import { createOAuthProvider, listOAuthProviders } from "@/src/lib/models/oauth-providers";
import { isAppRole } from "@/src/lib/auth/oidc/groups";
import {
  analyticsEnabled,
  clickhousePassword,
  SETTING_DEFINITIONS,
  SettingValidationError,
} from "@/src/lib/settings/registry";
import { propagateOptionalFeatureSettings } from "@/src/lib/settings/optional-features";
import { resolveAllSettings, saveSettings } from "@/src/lib/settings/resolve";
import {
  type GeneralSettings,
  getDashboardSettings,
  saveDashboardSettings,
  saveGeneralSettings,
} from "@/src/lib/settings";
import { activateDashboardHost, dashboardHostOrigin, isHostname } from "@/src/lib/dashboard-host";
import { dashboardSettingsFromHost } from "@/src/lib/dashboard-host/options";
import { updateProxyHost } from "@/src/lib/models/proxy-hosts";
// Not the registry's SettingValidationError: this is the JSON groups', and the route uses both.
import { SettingsValidationError, validateSettingsGroup } from "@/src/lib/settings/validation";
import { isEmailAddress } from "@/src/lib/email/address";
import { settingValidationMessage } from "@/src/lib/settings/messages";
import {
  getMigrationSource,
  isSetupCompleted,
  issueRestartToken,
  markSetupCompleted,
  promoteFirstSetupAdmin,
} from "@/src/lib/setup";

/**
 * POST /api/setup/complete. A route, not an action: an action re-renders the page, which redirects
 * once setup is complete, before the restart dialog can show (see ../migrate/route.ts).
 * Whoever completes setup is promoted to admin: the OAuth account step creates its user as "user".
 */

export type CompleteSetupResponse =
  | {
      ok: true;
      /** A path on whichever origin answers once the app is back. */
      next: string;
      /** Lets this browser, and only this one, ask /api/setup/restart. */
      restartToken: string;
      /** The dashboard host's origin, to prefer over this one. */
      dashboardOrigin: string | null;
    }
  | { ok: false; error: string };

function json(body: CompleteSetupResponse, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest): Promise<Response> {
  const originCheck = checkSameOrigin(request);
  if (originCheck) return originCheck;

  const t = await getTranslations("setup.errors");
  const tErrors = await getTranslations("errors");
  const session = await auth(request);
  if (!session?.user) {
    return json({ ok: false, error: t("signInToFinish") }, 401);
  }
  if (await isSetupCompleted()) {
    return json({ ok: false, error: tErrors("setupAlreadyCompleted") }, 409);
  }

  const formData = await request.formData();

  // A no-op once an admin exists, so a second ordinary user is still refused below.
  const promoted = await promoteFirstSetupAdmin(Number(session.user.id));
  if (!promoted && !(await sessionCan(session, "settings:write"))) {
    return json({ ok: false, error: t("adminToFinish") }, 403);
  }

  // Booleans compare against "on": FormBooleanControls always submits a hidden input, empty when
  // off, so a presence check would read every toggle as true.
  const resolved = await resolveAllSettings();
  const values: Record<string, unknown> = {};

  for (const definition of SETTING_DEFINITIONS) {
    const raw = formData.get(definition.key);

    // A gate is tri-state; setup writes a definite answer rather than the null that means "infer".
    if (definition.gate) {
      values[definition.key] = raw === "on";
      continue;
    }

    if (typeof definition.default === "boolean") {
      // Not rendered (its gate is off): left alone so turning a feature off keeps its credential.
      if (raw === null) continue;
      values[definition.key] = raw === "on";
      continue;
    }

    if (raw === null) continue;
    const text = String(raw);

    // A blank secret means "keep it". Carry the resolved value into the database so the operator
    // can then delete the variable from .env.
    if (definition.secret && text === "") {
      const current = resolved.get(definition.key)?.value;
      if (typeof current === "string" && current !== "") {
        values[definition.key] = current;
      }
      continue;
    }

    values[definition.key] = text;
  }

  // ClickHouse will not start without a password, so refuse rather than save a dead setting.
  if (values[analyticsEnabled.key] === true) {
    const password = values[clickhousePassword.key] ?? resolved.get(clickhousePassword.key)?.value;
    if (typeof password !== "string" || password.trim() === "") {
      return json({ ok: false, error: t("analyticsPasswordRequired") }, 400);
    }
  }

  // `general` predates the registry. The two refusals an operator can cause are checked first, in
  // their language; the shared validator's REST wording is only the backstop.
  const defaultDomain = String(formData.get("defaultDomain") ?? "").trim();
  const acmeEmail = String(formData.get("acmeEmail") ?? "").trim();
  if (defaultDomain.length === 0 || defaultDomain.length > 253) {
    return json({ ok: false, error: t("defaultDomainInvalid") }, 400);
  }
  if (acmeEmail !== "" && !isEmailAddress(acmeEmail, "public")) {
    return json({ ok: false, error: t("acmeEmailInvalid") }, 400);
  }

  // Checked before any write: the save below is best-effort and would swallow a typo.
  const dashboardEnabled = formData.get("dashboardEnabled") === "on";
  const dashboardDomain = String(formData.get("dashboardDomain") ?? "").trim();
  if (dashboardEnabled && !isHostname(dashboardDomain)) {
    return json({ ok: false, error: t("dashboardDomainInvalid") }, 400);
  }

  let general: GeneralSettings;
  try {
    general = validateSettingsGroup("general", {
      defaultDomain,
      // Omitted when blank: "" would hand the ACME issuer an empty contact.
      ...(acmeEmail === "" ? {} : { acmeEmail }),
    }) as GeneralSettings;
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      // Rendered from its code: the English it carries is the REST API's, not this reader's.
      const message = extractErrorMessage(
        await getTranslations(),
        error,
        error.message,
        await getFormatter(),
      );
      return json({ ok: false, error: message }, 400);
    }
    throw error;
  }

  try {
    await saveSettings(values);
    await saveGeneralSettings(general);
  } catch (error) {
    if (error instanceof SettingValidationError) {
      return json(
        { ok: false, error: settingValidationMessage(await getTranslations(), error) },
        400,
      );
    }
    console.error("Setup: failed to save settings", error);
    return json({ ok: false, error: t("settingsSaveFailed") }, 500);
  }

  // Otherwise ClickHouse stays stopped and the client keeps what it resolved before. Never throws.
  await propagateOptionalFeatureSettings();

  const providerError = await createProviderFromForm(formData);
  if (providerError) return json({ ok: false, error: providerError }, 400);

  // Over HTTP: only the reachability check can say HTTPS works, once the route is live.
  // Best-effort: everything else asked for is already saved.
  try {
    if (dashboardEnabled) {
      const copyFrom = copySourceFromForm(formData);
      const copied = copyFrom ? await dashboardSettingsFromHost(copyFrom, dashboardDomain) : null;
      await saveDashboardSettings(copied?.settings ?? activateDashboardHost(dashboardDomain));
      if (copied) {
        await retireCopiedHost(copied.host, copied.settings.domain, Number(session.user.id));
      }
    }
  } catch (error) {
    console.error("Setup: could not enable the dashboard host", error);
  }

  await markSetupCompleted();

  const migrated = (await getMigrationSource()) !== null;

  // Read back, as the write above is best-effort. Not for a migrated deployment: its summary is
  // behind this origin's session, and the dashboard's domain would show a sign-in page instead.
  const dashboardOrigin = migrated ? null : dashboardHostOrigin(await getDashboardSettings());

  return json(
    {
      ok: true,
      next: migrated ? "/setup/done" : "/",
      restartToken: await issueRestartToken(),
      dashboardOrigin,
    },
    200,
  );
}

function copySourceFromForm(formData: FormData): number | null {
  if (formData.get("dashboardCopySettings") !== "on") return null;
  const id = Number(formData.get("dashboardCopyFromHostId"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * The dashboard host wins the domain, so the source would list a name it never answers. Disabled,
 * not deleted, when it has no other domain. Best-effort: a shadowed host is harmless.
 */
async function retireCopiedHost(
  host: { id: number; domains: string[] },
  domain: string,
  actorUserId: number,
): Promise<void> {
  const remaining = host.domains.filter((claimed) => claimed.toLowerCase() !== domain);
  try {
    await updateProxyHost(
      host.id,
      remaining.length === 0 ? { enabled: false } : { domains: remaining },
      actorUserId,
    );
  } catch (error) {
    console.error("Setup: could not retire the host copied into the dashboard host", error);
  }
}

/**
 * Returns a message rather than throwing, so a typo keeps the operator on the form. Blank is fine;
 * partly filled is refused, since skipping it would leave them believing SSO was configured.
 */
async function createProviderFromForm(formData: FormData): Promise<string | null> {
  const read = (key: string) => String(formData.get(key) ?? "").trim();
  const flag = (key: string) => formData.get(key) === "on";

  const name = read("idpName");
  const clientId = read("idpClientId");
  const clientSecret = read("idpClientSecret");
  const issuer = read("idpIssuer");

  const filled = [name, clientId, clientSecret, issuer].filter((value) => value !== "");
  if (filled.length === 0) return null;
  const t = await getTranslations("setup.errors");
  if (filled.length < 4) {
    return t("identityProviderIncomplete");
  }
  if (!/^https?:\/\/\S+$/.test(issuer)) {
    return t("issuerMustBeUrl");
  }

  // Not trusted from the render: the account step can have created one since.
  if ((await listOAuthProviders()).length > 0) {
    return null;
  }

  // Narrowed, not cast: an unrecognised posted role falls back instead of being stored.
  const posted = read("idpDefaultRole");
  const defaultRole = isAppRole(posted) ? posted : "user";

  try {
    await createOAuthProvider({
      name,
      type: "oidc",
      clientId,
      clientSecret,
      issuer,
      authorizationUrl: read("idpAuthorizationUrl") || null,
      tokenUrl: read("idpTokenUrl") || null,
      userinfoUrl: read("idpUserinfoUrl") || null,
      scopes: read("idpScopes") || "openid email profile",
      autoLink: flag("idpAutoLink"),
      enabled: true,
      source: "ui",
      roleMappingEnabled: flag("idpRoleMapping"),
      groupsClaim: read("idpGroupsClaim") || "groups",
      groupPrefix: read("idpGroupPrefix"),
      adminGroup: read("idpAdminGroup"),
      operatorGroup: read("idpOperatorGroup"),
      userGroup: read("idpUserGroup"),
      viewerGroup: read("idpViewerGroup"),
      defaultRole,
      syncGroups: flag("idpSyncGroups"),
    });
  } catch (error) {
    console.error("Setup: failed to create the OAuth provider", error);
    return t("identityProviderCreateFailed");
  }

  return null;
}
