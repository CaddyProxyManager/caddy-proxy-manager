/** Property-based: the duration pattern accepts what Go's and Caddy's parsers accept, and no more. */
import { describe, expect, it } from 'bun:test';
import * as fc from 'fast-check';
import { isCaddyDuration } from '../../../src/lib/caddy/duration';
import { FUZZ_TIMEOUT_MS, fuzz } from '../../helpers/fuzz';

const UNITS = ['ns', 'us', 'µs', 'μs', 'ms', 's', 'm', 'h', 'd'] as const;
const ALPHABET = /^[0-9.nusmhdµμ]*$/;

const digits = fc.stringMatching(/^[0-9]{1,6}$/);
const number = fc.oneof(
  digits,
  fc.tuple(digits, digits).map(([a, b]) => `${a}.${b}`),
  digits.map((d) => `.${d}`),
);
const segment = fc.tuple(number, fc.constantFrom(...UNITS)).map(([n, u]) => `${n}${u}`);
const duration = fc.array(segment, { minLength: 1, maxLength: 5 }).map((s) => s.join(''));

describe('isCaddyDuration', () => {
  it(
    'accepts any run of unit-suffixed numbers that fits, and refuses one that does not',
    () => {
      fc.assert(
        fc.property(duration, (value) => {
          expect(isCaddyDuration(value)).toBe(value.length <= 32);
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it(
    'accepts two accepted durations joined',
    () => {
      fc.assert(
        fc.property(duration, duration, (a, b) => {
          fc.pre(a.length + b.length <= 32);
          expect(isCaddyDuration(a + b)).toBe(true);
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it(
    'refuses a bare number, a sign, and any character outside the alphabet',
    () => {
      fc.assert(
        fc.property(
          fc.oneof(
            digits,
            fc.tuple(fc.constantFrom('-', '+', ' '), duration).map(([s, d]) => s + d),
            fc.string({ unit: 'grapheme', maxLength: 32 }).filter((s) => !ALPHABET.test(s)),
          ),
          (value) => {
            expect(isCaddyDuration(value)).toBe(false);
          },
        ),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it(
    'never throws on any text',
    () => {
      fc.assert(
        fc.property(fc.string({ unit: 'grapheme', maxLength: 100 }), (value) => {
          expect(typeof isCaddyDuration(value)).toBe('boolean');
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});
