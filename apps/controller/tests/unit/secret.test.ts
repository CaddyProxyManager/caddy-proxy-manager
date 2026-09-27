import { describe, it, expect } from 'bun:test';
import { fresh } from '@/tests/helpers/fresh';
import { encryptSecret, decryptSecret, isEncryptedSecret } from '@/src/lib/secret';

describe('secret', () => {
  it('encrypts a value (output is non-empty string)', () => {
    const encrypted = encryptSecret('my-api-token');
    expect(typeof encrypted).toBe('string');
    expect(encrypted.length).toBeGreaterThan(0);
  });

  it('encrypted value starts with "enc:v1:" prefix', () => {
    const encrypted = encryptSecret('hello-world');
    expect(encrypted.startsWith('enc:v1:')).toBe(true);
  });

  it('same input produces different output each time (random IV)', () => {
    const a = encryptSecret('same-value');
    const b = encryptSecret('same-value');
    // The IV is random.
    expect(a).not.toBe(b);
  });

  it('different inputs produce different outputs', () => {
    const a = encryptSecret('value-one');
    const b = encryptSecret('value-two');
    expect(a).not.toBe(b);
  });

  it('decrypts back to original value', () => {
    const original = 'super-secret-token-12345';
    const encrypted = encryptSecret(original);
    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(original);
  });

  it('decryptSecret with plain text (non-encrypted) returns input unchanged', () => {
    const plain = 'not-encrypted-value';
    expect(decryptSecret(plain)).toBe(plain);
  });

  it('isEncryptedSecret returns true for encrypted values', () => {
    const encrypted = encryptSecret('test');
    expect(isEncryptedSecret(encrypted)).toBe(true);
  });

  it('isEncryptedSecret returns false for plain text', () => {
    expect(isEncryptedSecret('plain-text')).toBe(false);
  });

  it('encrypting empty string returns empty string', () => {
    expect(encryptSecret('')).toBe('');
  });

  it('decrypting empty string returns empty string', () => {
    expect(decryptSecret('')).toBe('');
  });

  it('already-encrypted value is not double-encrypted', () => {
    const encrypted = encryptSecret('value');
    const encrypted2 = encryptSecret(encrypted);
    expect(encrypted2).toBe(encrypted);
  });

  describe('failure diagnostics', () => {
    // Stands in for a changed SESSION_SECRET, which config memoises and Bun cannot evict.
    function undecryptable(): string {
      const [prefix, version, iv, tag, data] = encryptSecret('token-value').split(':');
      const flipped = data[0] === 'A' ? 'B' : 'A';
      return [prefix, version, iv, tag, flipped + data.slice(1)].join(':');
    }

    it('names what failed to decrypt, and how to recover', () => {
      expect(() =>
        decryptSecret(undecryptable(), 'DNS provider "cloudflare" credential "api_token"'),
      ).toThrow(/DNS provider "cloudflare" credential "api_token"/);
      expect(() => decryptSecret(undecryptable())).toThrow(/SESSION_SECRET changed/);
    });

    it('past the grace period, points at LEGACY_KEY_CUTOFF_DATE', () => {
      // The default cutoff (2026-06-01) is behind us, so the legacy key is not tried at all.
      expect(() => decryptSecret(undecryptable())).toThrow(/grace period has expired/);
      expect(() => decryptSecret(undecryptable())).toThrow(/LEGACY_KEY_CUTOFF_DATE=never/);
    });

    it('with legacy support enabled, reports failure with both keys', async () => {
      // The cutoff is read once at module evaluation, so this needs its own copy of the module.
      const previous = process.env.LEGACY_KEY_CUTOFF_DATE;
      process.env.LEGACY_KEY_CUTOFF_DATE = 'never';
      const legacyEnabled = await import(`../../src/lib/secret${fresh()}`);
      if (previous === undefined) delete process.env.LEGACY_KEY_CUTOFF_DATE;
      else process.env.LEGACY_KEY_CUTOFF_DATE = previous;

      const value = undecryptable();
      expect(() => legacyEnabled.decryptSecret(value, 'certificate "my-cert"')).toThrow(
        /certificate "my-cert"/,
      );
      expect(() => legacyEnabled.decryptSecret(value)).toThrow(/HKDF\).*legacy/);
      expect(() => legacyEnabled.decryptSecret(value)).toThrow(/SESSION_SECRET changed/);
    });
  });
});
