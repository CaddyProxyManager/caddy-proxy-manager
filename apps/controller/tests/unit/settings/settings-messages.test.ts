/**
 * Setting labels and validation codes are looked up at runtime, beyond TypeScript's key checking,
 * so these fail a setting without a message rather than render its raw key.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import messages from '../../../messages/en.json';
import { SETTING_DEFINITIONS, SETTING_GROUPS } from '@/src/lib/settings/registry';
import { settingMessageName } from '@/src/lib/settings/messages';

const registry = messages.settings.registry as Record<
  string,
  { label?: string; description?: string } | undefined
>;

describe('settings.registry messages', () => {
  it('covers every setting in the registry', () => {
    const missing = SETTING_DEFINITIONS.map((definition) =>
      settingMessageName(definition.key),
    ).filter((name) => !registry[name]?.label || !registry[name]?.description);
    expect(missing).toEqual([]);
  });

  it('gives every number with a unit a field label and a word for the unit', () => {
    const units = (messages.settings as { units: Record<string, string> }).units;
    const missing = SETTING_DEFINITIONS.filter((definition) => definition.unit).flatMap(
      (definition) => {
        const name = settingMessageName(definition.key);
        const entry = registry[name] as { fieldLabel?: string } | undefined;
        return [
          ...(entry?.fieldLabel ? [] : [`${name}.fieldLabel`]),
          ...(units[definition.unit as string] ? [] : [`units.${definition.unit}`]),
        ];
      },
    );
    expect(missing).toEqual([]);
  });

  it('has no entry for a setting that no longer exists', () => {
    const known = new Set(
      SETTING_DEFINITIONS.map((definition) => settingMessageName(definition.key)),
    );
    expect(Object.keys(registry).filter((name) => !known.has(name))).toEqual([]);
  });

  it('strips the config: prefix the registry stores keys under', () => {
    // next-intl reads a dot as nesting; a colon would sit inside a key name and never resolve.
    for (const definition of SETTING_DEFINITIONS) {
      expect(settingMessageName(definition.key)).not.toContain(':');
    }
  });
});

describe('settings.groups messages', () => {
  it('names every group the pages render', () => {
    const groups = messages.settings.groups as Record<string, string | undefined>;
    expect(SETTING_GROUPS.filter((group) => !groups[group])).toEqual([]);
  });
});

describe('errors messages for the settings-group validator', () => {
  it('covers every code validation.ts and api.ts refuse with', () => {
    // Read off the source like domain-error.test.ts does: the codes go through `invalid()` and
    // `new SettingsValidationError()`, which that test's `domainError("` pattern does not see.
    const codes = new Set<string>();
    for (const file of ['validation.ts', 'api.ts']) {
      const source = readFileSync(join(import.meta.dir, '../../../src/lib/settings', file), 'utf8');
      for (const match of source.matchAll(/(?:invalid|SettingsValidationError)\(\s*"(\w+)"/g)) {
        codes.add(match[1]);
      }
    }
    expect(codes.size).toBeGreaterThan(30);
    const errors = messages.errors as Record<string, string | undefined>;
    expect([...codes].filter((code) => !errors[code])).toEqual([]);
  });
});

describe('settings.validation messages', () => {
  it('covers every code the registry can reject with', () => {
    // A literal copy of SettingValidationCode, so a new code without a message fails.
    const codes = [
      'boolean',
      'tristate',
      'text',
      'tooLong',
      'controlCharacter',
      'pattern',
      'wholeNumber',
      'range',
      'unknown',
    ];
    const validation = messages.settings.validation as Record<string, string | undefined>;
    expect(codes.filter((code) => !validation[code])).toEqual([]);
  });
});
