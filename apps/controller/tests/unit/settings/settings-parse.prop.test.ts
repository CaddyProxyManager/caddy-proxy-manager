/**
 * Property-based: every setting's `parse` refuses with SettingValidationError or returns a value
 * it accepts again unchanged, and one its own environment reader reads back the same.
 */
import { describe, expect, it } from 'bun:test';
import * as fc from 'fast-check';
import {
  SETTING_DEFINITIONS,
  type SettingDefinition,
  SettingValidationError,
} from '@/src/lib/settings/registry';
import { FUZZ_TIMEOUT_MS, fuzz } from '../../helpers/fuzz';

/** As `.env` would spell it: the empty string is how an unset tri-state arrives. */
function asEnv(value: string | number | boolean | null): string {
  return value === null ? '' : String(value);
}

/** -0 passes a `min: 0` and is stored, spelled and read back as 0, so it compares as 0. */
function stored<T>(value: T): T {
  return Object.is(value, -0) ? (0 as T) : value;
}

describe('setting parsers', () => {
  it.each(SETTING_DEFINITIONS.map((d): [string, SettingDefinition] => [d.env, d]))(
    '%s refuses cleanly, and what it accepts is a fixed point',
    (_env, definition) => {
      fc.assert(
        fc.property(
          fc.oneof(fc.anything(), fc.string({ unit: 'grapheme', maxLength: 64 })),
          (value) => {
            let parsed: ReturnType<typeof definition.parse>;
            try {
              parsed = definition.parse(value);
            } catch (error) {
              expect(error).toBeInstanceOf(SettingValidationError);
              return;
            }
            expect(stored(definition.parse(parsed))).toEqual(stored(parsed));
            expect(stored(definition.fromEnv(asEnv(parsed)))).toEqual(stored(parsed));
          },
        ),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});
