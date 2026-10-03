import { afterEach, describe, it, expect, setSystemTime } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import {
  encryptUnderOtherSecret,
  OTHER_SESSION_SECRET,
} from '@/tests/helpers/encrypt-under-other-secret';
import {
  encryptSecret,
  decryptSecret,
  decryptSecretWith,
  isEncryptedSecret,
  reencryptSecret,
} from '@/src/lib/secret';

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

    it('within the grace period, reports failure with both keys', () => {
      // The cutoff is read once at import, so the clock moves instead of LEGACY_KEY_CUTOFF_DATE.
      setSystemTime(new Date('2026-05-31T00:00:00Z'));
      try {
        const value = undecryptable();
        expect(() => decryptSecret(value, 'certificate "my-cert"')).toThrow(
          /certificate "my-cert"/,
        );
        expect(() => decryptSecret(value)).toThrow(/HKDF\).*legacy/);
        expect(() => decryptSecret(value)).toThrow(/SESSION_SECRET changed/);
        expect(() => decryptSecret(value)).toThrow(/set SESSION_SECRET_PREVIOUS/);
      } finally {
        setSystemTime();
      }
    });
  });

  describe('previous secrets (SESSION_SECRET rotation)', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    it('decrypts with any SESSION_SECRET_PREVIOUS entry but encrypts only with the current key', () => {
      const stored = encryptUnderOtherSecret('dns-api-token');
      vi.stubEnv(
        'SESSION_SECRET_PREVIOUS',
        `unrelated-secret-abcdefghijklmnopqrstuvwxyz,${OTHER_SESSION_SECRET}`,
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(decryptSecret(stored)).toBe('dns-api-token');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Keep SESSION_SECRET_PREVIOUS set/));

      const fresh = encryptSecret('new-token');
      expect(decryptSecretWith(fresh, OTHER_SESSION_SECRET)).toBeNull();
    });

    it('decrypts values stored under a refused placeholder secret without configuration', () => {
      const stored = encryptUnderOtherSecret(
        'client-secret',
        'your-secure-session-secret-here-min-32-chars',
      );
      vi.stubEnv('SESSION_SECRET_PREVIOUS', undefined);
      expect(decryptSecret(stored)).toBe('client-secret');
    });

    it('still fails for a key that is neither current nor previous', () => {
      const stored = encryptUnderOtherSecret('token');
      vi.stubEnv('SESSION_SECRET_PREVIOUS', 'some-other-secret-abcdefghijklmnopqrstuvwxyz');
      expect(() => decryptSecret(stored)).toThrow(/SESSION_SECRET_PREVIOUS/);
    });

    it('reencryptSecret re-encrypts only values that need a previous key', () => {
      const stored = encryptUnderOtherSecret('private-key');
      vi.stubEnv('SESSION_SECRET_PREVIOUS', OTHER_SESSION_SECRET);
      const current = encryptSecret('already-current');

      expect(reencryptSecret('')).toBeNull();
      expect(reencryptSecret('plaintext-value')).toBeNull();
      expect(reencryptSecret(current)).toBeNull();

      const rotated = reencryptSecret(stored);
      expect(rotated).not.toBeNull();
      expect(rotated).not.toBe(stored);
      expect(reencryptSecret(rotated as string)).toBeNull();

      // The re-encrypted value no longer needs the previous secret.
      vi.stubEnv('SESSION_SECRET_PREVIOUS', undefined);
      expect(decryptSecret(rotated as string)).toBe('private-key');
      expect(() => decryptSecret(stored)).toThrow(/Failed to decrypt/);
    });

    it('reencryptSecret throws, naming the value, when no key decrypts it', () => {
      const stored = encryptUnderOtherSecret('token');
      vi.stubEnv('SESSION_SECRET_PREVIOUS', undefined);
      expect(() => reencryptSecret(stored, 'agent "edge" secret')).toThrow(/agent "edge" secret/);
    });
  });
});
