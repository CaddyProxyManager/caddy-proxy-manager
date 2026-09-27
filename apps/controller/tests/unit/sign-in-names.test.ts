/**
 * The page-safe username rules and lowercasesIntoAscii. The rules that read the database are in
 * tests/integration/user-sign-in-names.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import { isUsableSignInUsername, isValidLoginUsername } from '@/src/lib/login-username';
import { lowercasesIntoAscii } from '@/src/lib/sign-in-names';

const KELVIN = String.fromCodePoint(0x212a);
const CAPITAL_I_WITH_DOT = String.fromCodePoint(0x130);

describe('lowercasesIntoAscii', () => {
  it.each([
    [`${KELVIN}ate@example.com`],
    [`${CAPITAL_I_WITH_DOT}van@example.com`],
    [`kate@exampl${KELVIN}.com`],
  ])('flags %s', (value) => {
    expect(lowercasesIntoAscii(value)).toBe(true);
  });

  it.each([
    ['Kate@Example.com'],
    ['alice+cpm@example.com'],
    // Lowercased to another non-ASCII letter.
    [`J${String.fromCodePoint(0xd6)}HN@example.com`],
    [`${String.fromCodePoint(0x1d400)}@example.com`],
    [''],
  ])('leaves %s alone', (value) => {
    expect(lowercasesIntoAscii(value)).toBe(false);
  });
});

describe('sign-in username rules', () => {
  it('accepts 3-255 characters of letters, digits and _ . @ -', () => {
    expect(isValidLoginUsername('ab')).toBe(false);
    expect(isValidLoginUsername('a'.repeat(256))).toBe(false);
    expect(isValidLoginUsername('Alice.B_c-d@example.com')).toBe(true);
    expect(isValidLoginUsername('alice+cpm@example.com')).toBe(false);
    expect(isValidLoginUsername('bad name')).toBe(false);
  });

  it('only counts a lowercase one as usable, since the login page lowercases what is typed', () => {
    expect(isUsableSignInUsername('alice')).toBe(true);
    expect(isUsableSignInUsername('Alice')).toBe(false);
    expect(isUsableSignInUsername(null)).toBe(false);
    expect(isUsableSignInUsername('')).toBe(false);
  });
});
