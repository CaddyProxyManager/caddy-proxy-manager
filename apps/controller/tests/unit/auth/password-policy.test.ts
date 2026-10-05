/** One rule, four enforcement points; pinned along with its English wording from the catalog. */
import { describe, it, expect } from 'bun:test';
import messages from '../../../messages/en.json';
import {
  MIN_PASSWORD_LENGTH,
  isPasswordAcceptable,
  type PasswordPolicyViolation,
  passwordPolicyViolations,
} from '@/src/lib/auth/password/policy';
import { passwordPolicyHint, passwordPolicyMessage } from '@/src/lib/auth/password/policy-message';

const VALID = 'CorrectHorse1!';

/** Resolves like next-intl, so a renamed key fails here rather than rendering raw. */
function t(key: string, values: Record<string, string | number> = {}): string {
  const template = key.split('.').reduce<unknown>((node, part) => {
    if (node === undefined || node === null || typeof node !== 'object') return undefined;
    return (node as Record<string, unknown>)[part];
  }, messages);
  if (typeof template !== 'string') throw new Error(`missing message: ${key}`);
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    name in values ? String(values[name]) : whole,
  );
}

describe('passwordPolicyViolations', () => {
  it('accepts a password meeting every requirement', () => {
    expect(passwordPolicyViolations(VALID)).toEqual([]);
    expect(isPasswordAcceptable(VALID)).toBe(true);
  });

  it.each<[string, PasswordPolicyViolation]>([
    ['Sh0rt!', 'length'],
    ['alllowercase1!', 'case'],
    ['ALLUPPERCASE1!', 'case'],
    ['NoDigitsHere!!', 'number'],
    ['NoSpecialChar1', 'special'],
  ])('rejects %j', (password, expected) => {
    expect(passwordPolicyViolations(password)).toContain(expected);
  });

  it('reports every failure at once rather than one per attempt', () => {
    // A user retyping a password should learn all of what is wrong in one go.
    expect(passwordPolicyViolations('short')).toHaveLength(4);
  });

  it('counts the boundary correctly', () => {
    const atLimit = `Aa1!${'x'.repeat(MIN_PASSWORD_LENGTH - 4)}`;
    expect(atLimit).toHaveLength(MIN_PASSWORD_LENGTH);
    expect(passwordPolicyViolations(atLimit)).toEqual([]);
    expect(passwordPolicyViolations(atLimit.slice(0, -1))).toContain('length');
  });

  it('treats any non-alphanumeric as special, including a space', () => {
    expect(passwordPolicyViolations('Correct Horse1')).toEqual([]);
  });

  it('accepts long passphrases without an upper bound', () => {
    expect(passwordPolicyViolations(`Aa1!${'x'.repeat(500)}`)).toEqual([]);
  });
});

describe('passwordPolicyMessage', () => {
  it('returns null for an acceptable password', () => {
    expect(passwordPolicyMessage(t, VALID, 'Password')).toBeNull();
  });

  it('prefixes the subject so each caller can name its own field', () => {
    expect(passwordPolicyMessage(t, 'short', 'Export password')).toMatch(
      /^Export password must be/,
    );
    expect(passwordPolicyMessage(t, 'short', 'ADMIN_PASSWORD')).toMatch(/^ADMIN_PASSWORD must be/);
    expect(passwordPolicyMessage(t, 'short', 'Password')).toMatch(/^Password must be/);
  });

  it('joins multiple failures into one sentence', () => {
    const message = passwordPolicyMessage(t, 'short', 'Password');
    expect(message).toContain('at least');
    expect(message).toContain('number');
    expect(message).toContain('special character');
  });

  it('names the enforced length rather than hardcoding one', () => {
    expect(passwordPolicyMessage(t, 'short', 'Password')).toContain(String(MIN_PASSWORD_LENGTH));
  });

  it('rejects an empty password', () => {
    expect(passwordPolicyMessage(t, '', 'Password')).not.toBeNull();
  });
});

describe('passwordPolicy.rule messages', () => {
  // `passwordPolicy.rule.${violation}` is composed at runtime, so tsc cannot check it.
  it('has a checklist line for every violation', () => {
    const everyViolation = passwordPolicyViolations('');
    expect(everyViolation).toHaveLength(4);
    for (const violation of everyViolation) {
      expect(t(`passwordPolicy.rule.${violation}`, { min: MIN_PASSWORD_LENGTH })).not.toContain(
        '{',
      );
    }
  });
});

describe('passwordPolicyHint', () => {
  it('describes the rule it is shown next to', () => {
    // The hint must not drift from the length actually enforced.
    expect(passwordPolicyHint(t)).toContain(String(MIN_PASSWORD_LENGTH));
  });
});
