import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { auth } from "@/src/lib/auth";
import { config } from "@/src/lib/config";
import { listOAuthProviders } from "@/src/lib/models/oauth-providers";
import { isHostname, seedDashboardDomain } from "@/src/lib/dashboard-host";
import { listDomainClaims } from "@/src/lib/dashboard-host/options";
import { getDashboardSettings, getGeneralSettings } from "@/src/lib/settings";
import { baseUrl, SETTING_DEFINITIONS, SETTING_GROUPS } from "@/src/lib/settings/registry";
import { gateDefaults } from "@/src/lib/settings/optional-features";
import { resolveAllSettings } from "@/src/lib/settings/resolve";
import { settingDescription, settingGroupTitle, settingLabel } from "@/src/lib/settings/messages";
import { getSetupState, hasLegacyDatabase, SETUP_PATHS } from "@/src/lib/setup";
import SetupSettingsClient, { type SettingField } from "./SetupSettingsClient";
import { sqliteNoticeApplies } from "@/src/lib/db/sqlite-notice";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("setup.settingsStep");
  return { title: { absolute: t("metaTitle") } };
}

export default async function SetupSettingsPage() {
  const t = await getTranslations();
  const session = await auth();
  const { stage } = await getSetupState(!!session?.user);
  if (stage !== "settings") {
    redirect(SETUP_PATHS[stage]);
  }

  const [resolved, gates, general, dashboard, claims, providers, requestHeaders] =
    await Promise.all([
      resolveAllSettings(),
      gateDefaults(),
      getGeneralSettings(),
      getDashboardSettings(),
      // Only a migrated deployment has hosts yet, possibly one the dashboard host would shadow.
      listDomainClaims(),
      listOAuthProviders(),
      headers(),
    ]);
  const proposedBaseUrl = proposeBaseUrl(resolved.get(baseUrl.key), requestHeaders);

  // Secrets never reach the browser; re-entering one beats shipping it in the HTML.
  const fields: SettingField[] = SETTING_DEFINITIONS.map((definition) => {
    const current = resolved.get(definition.key);
    if (definition.key === baseUrl.key && proposedBaseUrl) {
      return {
        key: definition.key,
        env: definition.env,
        group: definition.group,
        label: settingLabel(t, definition.key),
        description: settingDescription(t, definition.key),
        kind: "string",
        secret: false,
        generatable: false,
        gate: false,
        value: proposedBaseUrl,
        // Not "environment", or the operator is invited to delete a variable never copied.
        source: "default",
      };
    }
    return {
      key: definition.key,
      env: definition.env,
      group: definition.group,
      label: settingLabel(t, definition.key),
      description: settingDescription(t, definition.key),
      kind:
        typeof definition.default === "boolean"
          ? "boolean"
          : typeof definition.default === "number"
            ? "number"
            : definition.default === null
              ? "tristate"
              : "string",
      secret: definition.secret === true,
      generatable: definition.generatable === true,
      gate: definition.gate === true,
      // Stored tri-state but shown as a switch, so unset arrives as the effective answer - `null`
      // would show off for something already running.
      value: definition.gate
        ? (gates[definition.key] ?? false)
        : definition.secret
          ? ""
          : (current?.value ?? definition.default),
      source: current?.source ?? "default",
    };
  });

  return (
    <SetupSettingsClient
      fields={fields}
      groups={SETTING_GROUPS.map((group) => ({ id: group, title: settingGroupTitle(t, group) }))}
      general={{
        defaultDomain:
          general?.defaultDomain ?? domainFromBaseUrl(resolved.get(baseUrl.key)?.value),
        acmeEmail: general?.acmeEmail ?? "",
      }}
      dashboard={dashboardCard(dashboard, proposedBaseUrl)}
      domainClaims={claims}
      oauth={oauthCard(providers.map((provider) => provider.name))}
      hasMigrateStep={hasLegacyDatabase()}
      sqliteWarning={sqliteNoticeApplies()}
    />
  );
}

/**
 * Opens with DASHBOARD_DOMAIN, else the BASE_URL hostname, else this page's address when BASE_URL
 * is the loopback default. No usable name opens the switch off rather than claim a domain.
 */
function dashboardCard(
  stored: { enabled: boolean; domain: string } | null,
  proposedBaseUrl: string | null,
) {
  if (stored?.domain) {
    return { enabled: stored.enabled, domain: stored.domain, fromEnvironment: false };
  }
  const seeded = seedDashboardDomain();
  if (seeded) {
    return { enabled: true, domain: seeded, fromEnvironment: !!config.dashboardDomain };
  }
  const reached = proposedBaseUrl ? new URL(proposedBaseUrl).hostname : "";
  const domain = isHostname(reached) ? reached : "";
  return { enabled: domain !== "", domain, fromEnvironment: false };
}

/**
 * Not from the registry: a provider is an `oauth_providers` row. The client secret alone is
 * prefilled, since a provider cannot be created without one and saving lets the operator drop it
 * from the environment.
 */
function oauthCard(existing: string[]) {
  const { oauth } = config;

  // Not the provider name: config.ts defaults it to "OAuth2", which made an untouched card look
  // half filled and the save refuse it.
  const fromEnvironment = oauth.enabled || !!oauth.clientId;

  // The three defaults below do not count as "filled in".
  const blank = {
    providerName: "",
    issuer: "",
    clientId: "",
    clientSecret: "",
    authorizationUrl: "",
    tokenUrl: "",
    userinfoUrl: "",
    scopes: "openid email profile",
    autoLink: false,
    roleMappingEnabled: false,
    groupsClaim: "groups",
    groupPrefix: "",
    adminGroup: "",
    operatorGroup: "",
    userGroup: "",
    viewerGroup: "",
    defaultRole: "user",
    syncGroups: false,
  };

  if (!fromEnvironment) return { existing, fromEnvironment, prefill: blank };

  return {
    existing,
    fromEnvironment,
    prefill: {
      providerName: oauth.providerName ?? "",
      issuer: oauth.issuer ?? "",
      clientId: oauth.clientId ?? "",
      clientSecret: oauth.clientSecret ?? "",
      authorizationUrl: oauth.authorizationUrl ?? "",
      tokenUrl: oauth.tokenUrl ?? "",
      userinfoUrl: oauth.userinfoUrl ?? "",
      scopes: oauth.scopes ?? blank.scopes,
      autoLink: oauth.allowAutoLinking,
      roleMappingEnabled: oauth.roleMappingEnabled,
      groupsClaim: oauth.groupsClaim ?? blank.groupsClaim,
      groupPrefix: oauth.groupPrefix ?? "",
      adminGroup: oauth.adminGroup ?? "",
      operatorGroup: oauth.operatorGroup ?? "",
      userGroup: oauth.userGroup ?? "",
      viewerGroup: oauth.viewerGroup ?? "",
      defaultRole: oauth.defaultRole ?? blank.defaultRole,
      syncGroups: oauth.syncGroups,
    },
  };
}

// Both IPv6 spellings, in case a runtime strips the brackets the URL standard keeps.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * This page's address, when BASE_URL is Compose's loopback default nobody else can reach. The
 * client-settable X-Forwarded-Proto only prefills a field the operator reviews.
 */
function proposeBaseUrl(
  current: { value: unknown; source: string } | undefined,
  requestHeaders: Headers,
): string | null {
  if (current?.source === "stored") return null;
  const host = requestHeaders.get("host");
  if (!host) return null;
  try {
    if (!LOOPBACK_HOSTNAMES.has(new URL(String(current?.value ?? baseUrl.default)).hostname)) {
      return null;
    }
    const scheme = requestHeaders.get("x-forwarded-proto") === "https" ? "https" : "http";
    const reached = new URL(`${scheme}://${host}`);
    return LOOPBACK_HOSTNAMES.has(reached.hostname) ? null : reached.origin;
  } catch {
    return null;
  }
}

/** `localhost` is kept: it is the real name on a trial deployment, and the field is required. */
function domainFromBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "";
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}
