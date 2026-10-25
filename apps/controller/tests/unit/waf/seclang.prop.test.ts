/**
 * Property-based: the SecLang reader accounts for every line of any text, never throws, and reads
 * a clean action list back to what was written. Coraza itself is the oracle for what a rule means;
 * these hold the parts that mimic Go to what Go does.
 */
import { describe, expect, it } from 'bun:test';
import * as fc from 'fast-check';
import {
  findUnsupportedRegex,
  goTrimSpace,
  lintSeclang,
  parseActions,
  seclangDirectives,
  splitRuleDirective,
} from '../../../src/lib/waf/seclang';
import { FUZZ_TIMEOUT_MS, fuzz } from '../../helpers/fuzz';

const anyText = fc.string({ unit: 'grapheme', maxLength: 400 });
/** Lines only, so the `\r` normalization under test is the one adding them. */
const lfText = anyText.map((s) => s.replace(/\r/g, ''));

describe('goTrimSpace', () => {
  it(
    'agrees with String.prototype.trim wherever Go and JavaScript agree on whitespace',
    () => {
      fc.assert(
        fc.property(
          // U+FEFF is whitespace to JavaScript only, U+0085 to Go only.
          anyText.filter((s) => !s.includes('﻿') && !s.includes('\u0085')),
          (s) => {
            expect(goTrimSpace(s)).toBe(s.trim());
          },
        ),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it(
    'is idempotent and keeps the middle',
    () => {
      fc.assert(
        fc.property(anyText, (s) => {
          const once = goTrimSpace(s);
          expect(goTrimSpace(once)).toBe(once);
          expect(s.includes(once)).toBe(true);
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe('seclangDirectives', () => {
  it(
    'accounts for every line once, in order, with the start it came from',
    () => {
      fc.assert(
        fc.property(anyText, (raw) => {
          const directives = seclangDirectives(raw);
          const lines = raw.split('\n');
          expect(directives.flatMap((d) => d.lines)).toEqual(lines);
          let next = 0;
          for (const directive of directives) {
            expect(directive.lines.length).toBeGreaterThan(0);
            expect(directive.start).toBe(next);
            next += directive.lines.length;
          }
          // Only an unfinished continuation or block reads as null, and it can only be the last.
          const nulls = directives.filter((d) => d.text === null);
          expect(nulls.length).toBeLessThanOrEqual(1);
          if (nulls.length === 1) expect(directives.at(-1)?.text).toBeNull();
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe('parseActions', () => {
  const key = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,15}$/);
  // No comma, quote or backslash, nothing a Go trim strips at either end, and no surrounding
  // quotes to strip: the characters that make the reader's job trivial.
  const value = fc.stringMatching(/^[A-Za-z0-9_.=+%{}:/-]{1,30}$/);
  const pairs = fc.array(fc.tuple(key, fc.option(value, { nil: undefined })), {
    minLength: 1,
    maxLength: 8,
  });

  it(
    'reads a clean list back, keys lower-cased',
    () => {
      fc.assert(
        fc.property(pairs, (list) => {
          const text = list.map(([k, v]) => (v === undefined ? k : `${k}:${v}`)).join(',');
          expect(parseActions(text)).toEqual({
            actions: list.map(([k, v]) => ({ key: k.toLowerCase(), value: v ?? '' })),
            unclosedQuote: false,
          });
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it(
    'never throws on any text',
    () => {
      fc.assert(
        fc.property(anyText, (text) => {
          const { actions, unclosedQuote } = parseActions(text);
          expect(typeof unclosedQuote).toBe('boolean');
          for (const action of actions) expect(action.key).toBe(action.key.toLowerCase());
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe('lintSeclang', () => {
  it(
    'never throws, reports lines that exist, sorted, and reads CRLF as LF',
    () => {
      fc.assert(
        fc.property(lfText, fc.boolean(), (raw, crsLoaded) => {
          const issues = lintSeclang(raw, { crsLoaded });
          const lineCount = raw.split('\n').length;
          let last = 0;
          for (const issue of issues) {
            expect(issue.line).toBeGreaterThanOrEqual(Math.max(1, last));
            expect(issue.line).toBeLessThanOrEqual(lineCount);
            expect(['error', 'warning']).toContain(issue.severity);
            last = issue.line;
          }
          expect(lintSeclang(raw.replace(/\n/g, '\r\n'), { crsLoaded })).toEqual(issues);
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe('splitRuleDirective and findUnsupportedRegex', () => {
  it(
    'never throw on any text',
    () => {
      fc.assert(
        fc.property(anyText, (text) => {
          const split = splitRuleDirective(text);
          if (split !== null) expect(typeof split.actions).toBe('string');
          const unsupported = findUnsupportedRegex(text);
          if (unsupported !== null) expect(unsupported.length).toBeGreaterThan(0);
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});
