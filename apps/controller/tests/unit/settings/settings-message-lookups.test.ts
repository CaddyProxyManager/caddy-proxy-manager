/** The runtime-keyed `settings.*` lookups resolve against the real catalog. */
import { describe, expect, it } from 'bun:test';
import { createTranslator } from 'next-intl';
import messages from '../../../messages/en.json';
import {
  settingDescription,
  settingFieldLabel,
  settingGroupTitle,
  settingLabel,
  settingUnit,
  settingValidationMessage,
} from '@/src/lib/settings/messages';
import {
  SETTING_DEFINITIONS,
  SETTING_GROUPS,
  SettingValidationError,
} from '@/src/lib/settings/registry';

type Translator = Parameters<typeof settingLabel>[0];
const t = createTranslator({ locale: 'en', messages }) as unknown as Translator;
const registry = messages.settings.registry as Record<
  string,
  { label?: string; fieldLabel?: string; description?: string }
>;

describe('setting message lookups', () => {
  const withUnit = SETTING_DEFINITIONS.find(
    (definition) => 'unit' in definition && definition.unit,
  )!;
  const name = withUnit.key.replace(/^config:/, '');

  it('reads a setting label, description and group title', () => {
    expect(settingLabel(t, withUnit.key)).toBe(registry[name].label!);
    expect(settingDescription(t, withUnit.key)).toBe(registry[name].description!);
    expect(settingGroupTitle(t, SETTING_GROUPS[0])).toBe(
      (messages.settings.groups as Record<string, string>)[SETTING_GROUPS[0]],
    );
  });

  it('labels a field with a unit by its field label, and one without by its label', () => {
    const unit = (withUnit as { unit: Parameters<typeof settingUnit>[1] }).unit;
    expect(settingFieldLabel(t, withUnit.key, unit)).toBe(registry[name].fieldLabel!);
    expect(settingFieldLabel(t, withUnit.key)).toBe(registry[name].label!);
    expect(settingUnit(t, unit)).toBe((messages.settings.units as Record<string, string>)[unit]);
  });

  it('names the setting in a validation message, or the raw key when it is unknown', () => {
    const known = settingValidationMessage(
      t,
      new SettingValidationError(withUnit.key, 'boolean', { label: 'English' }, ''),
    );
    expect(known).toContain(registry[name].label!);

    const unknown = settingValidationMessage(
      t,
      new SettingValidationError('nope', 'unknown', { label: 'mystery_key' }, ''),
    );
    expect(unknown).toContain('mystery_key');
  });
});
