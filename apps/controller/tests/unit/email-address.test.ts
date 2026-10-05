/**
 * The email syntax check the forms and the server share. Loose by design - it catches typos, not
 * undeliverable mailboxes - so the cases worth pinning are the typos, and the odd addresses this
 * app itself creates.
 */
import { describe, expect, it } from 'bun:test';
import { isEmailAddress } from '@/src/lib/email/address';

describe('email address syntax', () => {
  it('accepts ordinary addresses', () => {
    for (const address of ['name@example.com', 'first.last+tag@mail.example.co.uk', 'a@b.io']) {
      expect(isEmailAddress(address), address).toBe(true);
    }
  });

  it('accepts a dotless domain, which setup gives the first administrator', () => {
    expect(isEmailAddress('admin@localhost')).toBe(true);
  });

  it('refuses the typos it exists to catch', () => {
    for (const address of [
      'name',
      'name@',
      '@example.com',
      'name@@example.com',
      'na me@example.com',
      'name@example..com',
      'name@.example.com',
      'name@example.com.',
      'name@exam ple.com',
    ]) {
      expect(isEmailAddress(address), address).toBe(false);
    }
  });

  it('refuses anything longer than an address can be', () => {
    expect(isEmailAddress(`${'a'.repeat(310)}@example.com`)).toBe(false);
  });

  it('requires a dotted domain where a public one is needed', () => {
    expect(isEmailAddress('admin@localhost', 'public')).toBe(false);
    expect(isEmailAddress('admin@example.com', 'public')).toBe(true);
  });
});
