/**
 * Registry settings with no form of their own, as Settings fields. Built from the definitions, so
 * control, bounds and wording come from one place and a setting added to a block gets a field.
 */

import type { getTranslations } from "next-intl/server";
import {
  accentColor,
  accountLockBaseDelayMs,
  accountLockDisableAfter,
  accountLockDisableEnabled,
  accountLockEnabled,
  accountLockFreeFailures,
  accountLockMaxDelayMs,
  allowOauthRegistration,
  allowOauthRoleFromClaims,
  allowSelfRegistration,
  appName,
  authRateLimitEnabled,
  authRateLimitMax,
  authRateLimitWindow,
  baseUrl,
  caddyMonitorEnabled,
  disableLocalUsers,
  forwardAuthAllowedPorts,
  forwardAuthSequentialUserIds,
  loginBlockMs,
  loginMaxAttempts,
  loginWindowMs,
  notifyAccountDisabled,
  notifyAdminAdded,
  notifyAdminLocked,
  notifyAgentOffline,
  notifyAgentOfflineMinutes,
  notifyAgentProblems,
  notifyCaddyApply,
  notifyCrsPluginDisabled,
  notifyDisabledAccountOwner,
  notifyGeoipFailed,
  notifyUpdateAvailable,
  notifyUpstreamErrorCount,
  notifyUpstreamErrorMinutes,
  notifyUpstreamErrors,
  trustHost,
  type SettingDefinition,
  type SettingValue,
} from "@/src/lib/settings/registry";
import {
  settingDescription,
  settingFieldLabel,
  settingLabel,
  settingUnit,
} from "@/src/lib/settings/messages";
import { isEnvOverridden, resolveSetting } from "@/src/lib/settings/resolve";
import type { RegistryField } from "./RegistrySettingsBlock";

/** Widened once: each definition has its own value type, and the union of those is not one. */
type AnySetting = SettingDefinition<SettingValue>;

/** The blocks that render them, in the order each block lists its settings. */
const BLOCKS: Record<string, readonly AnySetting[]> = {
  instance: [appName, baseUrl] as AnySetting[],
  branding: [accentColor] as AnySetting[],
  agent: [caddyMonitorEnabled] as AnySetting[],
  "forward-auth": [forwardAuthAllowedPorts, forwardAuthSequentialUserIds] as AnySetting[],
  "sign-in": [
    allowSelfRegistration,
    allowOauthRegistration,
    allowOauthRoleFromClaims,
    disableLocalUsers,
    trustHost,
    authRateLimitEnabled,
    authRateLimitWindow,
    authRateLimitMax,
    loginMaxAttempts,
    loginWindowMs,
    loginBlockMs,
    accountLockEnabled,
    accountLockFreeFailures,
    accountLockBaseDelayMs,
    accountLockMaxDelayMs,
    accountLockDisableEnabled,
    accountLockDisableAfter,
  ] as AnySetting[],
  // Rendered inside the Notifications block, below the recipients and certificate alerts.
  notifications: [
    notifyAccountDisabled,
    notifyAdminLocked,
    notifyAdminAdded,
    notifyAgentOffline,
    notifyAgentOfflineMinutes,
    notifyUpstreamErrors,
    notifyUpstreamErrorCount,
    notifyUpstreamErrorMinutes,
    notifyCaddyApply,
    notifyAgentProblems,
    notifyGeoipFailed,
    notifyCrsPluginDisabled,
    notifyUpdateAvailable,
    notifyDisabledAccountOwner,
  ] as AnySetting[],
};

/** Which settings a block owns, for the action that saves one. Keys, since that is what it posts. */
export const REGISTRY_BLOCK_KEYS: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(BLOCKS).map(([block, definitions]) => [
    block,
    definitions.map((definition) => definition.key),
  ]),
);

type Translator = Awaited<ReturnType<typeof getTranslations>>;

function field(t: Translator, definition: AnySetting, value: SettingValue): RegistryField {
  const common = {
    key: definition.key,
    env: definition.env,
    label: settingLabel(t, definition.key),
    description: settingDescription(t, definition.key),
  };

  if (typeof definition.default === "boolean") {
    return { ...common, kind: "boolean", value: value === true };
  }
  if (typeof definition.default === "number") {
    return {
      ...common,
      label: settingFieldLabel(t, definition.key, definition.unit),
      units: definition.unit ? settingUnit(t, definition.unit) : undefined,
      unit: definition.unit,
      kind: "number",
      value: typeof value === "number" ? value : definition.default,
      // The registry's own range. A number setting always has one.
      min: definition.min ?? 0,
      max: definition.max ?? Number.MAX_SAFE_INTEGER,
    };
  }
  return {
    ...common,
    kind: "text",
    value: typeof value === "string" ? value : "",
    maxLength: definition.maxLength,
    // What it falls back to with nothing stored and no variable set, so an empty field still says
    // what the instance will do.
    placeholder: String(definition.default ?? ""),
  };
}

export async function registryFields(
  t: Translator,
): Promise<Record<string, readonly RegistryField[]>> {
  const blocks: Record<string, RegistryField[]> = {};
  for (const [block, definitions] of Object.entries(BLOCKS)) {
    blocks[block] = await Promise.all(
      definitions.map(async (definition) => {
        const resolved = await resolveSetting(definition);
        return {
          ...field(t, definition, resolved.value),
          source: resolved.source,
          // Not just "from the environment": SETTINGS_ENV_OVERRIDE makes this variable win over
          // what is stored, so it cannot be changed here at all.
          pinned: isEnvOverridden(definition),
        };
      }),
    );
  }
  return blocks;
}
