/**
 * `settings.*` lookups keyed at runtime, so tsc cannot check them;
 * tests/unit/settings-messages.test.ts asserts the catalog covers every setting, group and code.
 */

import type { useTranslations } from "next-intl";
import type { SettingGroup, SettingValidationError } from "./registry";

type Translator = ReturnType<typeof useTranslations>;

/** The one place the narrowing is given up, for the reason in the header comment. */
type DynamicTranslate = (key: string, values?: Record<string, string | number>) => string;

function dynamic(t: Translator): DynamicTranslate {
  return t as unknown as DynamicTranslate;
}

/** Without the `config:` prefix: next-intl would read the colon as nesting. */
export function settingMessageName(settingKey: string): string {
  return settingKey.replace(/^config:/, "");
}

export function settingLabel(t: Translator, settingKey: string): string {
  return dynamic(t)(`settings.registry.${settingMessageName(settingKey)}.label`);
}

export function settingDescription(t: Translator, settingKey: string): string {
  return dynamic(t)(`settings.registry.${settingMessageName(settingKey)}.description`);
}

export function settingGroupTitle(t: Translator, group: SettingGroup): string {
  return dynamic(t)(`settings.groups.${group}`);
}

export function settingValidationMessage(t: Translator, error: SettingValidationError): string {
  // An unknown key has no label; the key itself is all there is.
  const label =
    error.code === "unknown" ? String(error.params.label) : settingLabel(t, error.settingKey);

  return dynamic(t)(`settings.validation.${error.code}`, { ...error.params, label });
}
