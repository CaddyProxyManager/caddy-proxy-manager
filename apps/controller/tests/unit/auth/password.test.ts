/**
 * User passwords hash with argon2id; access list passwords stay bcrypt because Caddy verifies those
 * itself. Pins that split, the pre-argon2id compatibility, and where Bun.password differs.
 */
import { describe, it, expect } from 'bun:test';
import bcrypt from 'bcryptjs';
import {
  hashPassword,
  hashBcrypt,
  verifyPassword,
  isLegacyPasswordHash,
  DEFAULT_BCRYPT_COST,
} from '@/src/lib/auth/password';

const PASSWORD = 'correct-horse-battery-staple';

describe('hashPassword (user passwords)', () => {
  it('emits argon2id', async () => {
    expect(await hashPassword(PASSWORD)).toMatch(/^\$argon2id\$/);
  });

  it('salts, so the same password never yields the same hash', async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it('round-trips through verifyPassword', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('uses the whole password, with no 72-byte bcrypt truncation', async () => {
    // The main reason to prefer argon2id here: a long passphrase counts in full.
    const hash = await hashPassword(`${'a'.repeat(72)}SUFFIX`);
    expect(await verifyPassword(`${'a'.repeat(72)}SUFFIX`, hash)).toBe(true);
    expect(await verifyPassword('a'.repeat(72), hash)).toBe(false);
  });
});

describe('hashBcrypt (access lists / Caddy)', () => {
  it('emits a bcrypt hash at the requested cost', async () => {
    expect(await hashBcrypt(PASSWORD)).toMatch(
      new RegExp(`^\\$2[aby]\\$${DEFAULT_BCRYPT_COST}\\$`),
    );
    expect(await hashBcrypt(PASSWORD, 10)).toMatch(/^\$2[aby]\$10\$/);
  });

  it('produces hashes a standard bcrypt implementation accepts', async () => {
    // Caddy's http_basic verifies these, so they must be real bcrypt, not bcrypt-shaped.
    const hash = await hashBcrypt(PASSWORD, 10);
    expect(bcrypt.compareSync(PASSWORD, hash)).toBe(true);
    expect(bcrypt.compareSync('wrong', hash)).toBe(false);
  });

  it('matches bcryptjs truncation past the 72-byte limit', async () => {
    // Bun.password does not truncate; unclamped, Caddy would reject the correct password.
    const long = 'a'.repeat(100);
    expect(bcrypt.compareSync(long, await hashBcrypt(long, 10))).toBe(true);
    expect(bcrypt.compareSync('a'.repeat(72), await hashBcrypt(long, 10))).toBe(true);
  });

  it('counts the limit in bytes, so multi-byte passwords still match', async () => {
    const unicode = `pässwörd-🔐-${'x'.repeat(80)}`;
    expect(Buffer.byteLength(unicode)).toBeGreaterThan(72);
    expect(bcrypt.compareSync(unicode, await hashBcrypt(unicode, 10))).toBe(true);
  });
});

describe('verifyPassword', () => {
  it('accepts bcrypt hashes written before the argon2id switch', async () => {
    // The migration guarantee: existing rows keep working with no backfill.
    for (const cost of [10, 12]) {
      const hash = bcrypt.hashSync(PASSWORD, cost);
      expect(await verifyPassword(PASSWORD, hash)).toBe(true);
      expect(await verifyPassword('wrong', hash)).toBe(false);
    }
  });

  it('accepts legacy $2a$ hashes', async () => {
    const legacy = bcrypt.hashSync(PASSWORD, bcrypt.genSaltSync(12).replace('$2b$', '$2a$'));
    expect(legacy.startsWith('$2a$')).toBe(true);
    expect(await verifyPassword(PASSWORD, legacy)).toBe(true);
  });

  it('applies the 72-byte clamp for bcrypt hashes only', async () => {
    // Same password, two algorithms: bcrypt truncates, argon2id does not.
    const long = 'a'.repeat(100);
    expect(await verifyPassword(long, bcrypt.hashSync(long, 10))).toBe(true);
    expect(await verifyPassword(long, await hashPassword(long))).toBe(true);
  });

  it('returns false rather than throwing on an unusable hash', async () => {
    for (const bad of ['', 'not-a-hash', '$2b$12$tooshort', '$argon2id$nonsense']) {
      await expect(verifyPassword(PASSWORD, bad)).resolves.toBe(false);
    }
  });
});

describe('isLegacyPasswordHash', () => {
  it('identifies bcrypt hashes and nothing else', async () => {
    expect(isLegacyPasswordHash(await hashBcrypt(PASSWORD, 10))).toBe(true);
    expect(isLegacyPasswordHash(bcrypt.hashSync(PASSWORD, 12))).toBe(true);
    expect(isLegacyPasswordHash('$2a$12$abc')).toBe(true);
    expect(isLegacyPasswordHash('$2y$12$abc')).toBe(true);

    expect(isLegacyPasswordHash(await hashPassword(PASSWORD))).toBe(false);
  });

  it('treats a missing hash as not legacy, so federated users are never gated', async () => {
    // OAuth accounts have no password to change; flagging them would be an unsatisfiable lockout.
    expect(isLegacyPasswordHash(null)).toBe(false);
    expect(isLegacyPasswordHash(undefined)).toBe(false);
    expect(isLegacyPasswordHash('')).toBe(false);
  });
});
