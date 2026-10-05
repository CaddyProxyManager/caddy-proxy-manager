/**
 * Fixtures write the on-disk format by hand: `encryptSecret` only uses this deployment's key, and
 * the importer reads another's. It also pins the envelope format.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createCipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRekeyer,
  LegacySecretError,
  probeLegacySecrets,
  verifyLegacyKey,
} from '@/src/lib/migration/legacy-secrets';
import { decryptSecret, encryptSecret } from '@/src/lib/secrets';

/** From tests/helpers/env.ts: the key the importer re-encrypts under. */
const CURRENT = 'test-session-secret-for-unit-tests-12345';
const OLD = 'the-previous-deployments-session-secret-9876';

function encryptWith(value: string, sessionSecret: string, legacy = false): string {
  const key = legacy
    ? createHash('sha256').update(sessionSecret).digest()
    : Buffer.from(
        hkdfSync('sha256', sessionSecret, Buffer.alloc(0), 'caddy-proxy-manager:secret:v1', 32),
      );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

describe('createRekeyer', () => {
  it('re-encrypts an old value under the current key', () => {
    const rekeyed = createRekeyer(OLD)(encryptWith('cloudflare-api-token', OLD));

    // Re-encrypted, not passed through, so the old secret is useless after the import.
    expect(decryptSecret(rekeyed)).toBe('cloudflare-api-token');
  });

  it('leaves a value the current key already reads byte-for-byte alone', () => {
    const original = encryptSecret('already-ours');

    // No churn on the ordinary upgrade, where the secret did not change.
    expect(createRekeyer(null)(original)).toBe(original);
    expect(createRekeyer(OLD)(original)).toBe(original);
  });

  it('reads a value encrypted with the pre-HKDF SHA-256 key', () => {
    // A database old enough to predate the HKDF change, migrated with the secret it used.
    const rekeyed = createRekeyer(OLD)(encryptWith('legacy-key-value', OLD, true));
    expect(decryptSecret(rekeyed)).toBe('legacy-key-value');
  });

  it('rewrites secrets inside a JSON column without disturbing the rest', () => {
    const blob = JSON.stringify({
      authKey: encryptWith('tskey-abc', OLD),
      hostname: 'edge-1',
      enabled: true,
      tags: ['tag:proxy'],
    });

    const parsed = JSON.parse(createRekeyer(OLD)(blob)) as Record<string, unknown>;

    expect(decryptSecret(parsed.authKey as string)).toBe('tskey-abc');
    expect(parsed.hostname).toBe('edge-1');
    expect(parsed.enabled).toBe(true);
    expect(parsed.tags).toEqual(['tag:proxy']);
  });

  it('rewrites a settings row, which is a JSON-encoded string', () => {
    const stored = JSON.stringify(encryptWith('clickhouse-password', OLD));
    const rekeyed = createRekeyer(OLD)(stored);

    expect(decryptSecret(JSON.parse(rekeyed) as string)).toBe('clickhouse-password');
  });

  it('passes ordinary text straight through', () => {
    for (const value of ['', 'admin@localhost', '{"enabled":true}', '$argon2id$hash']) {
      expect(createRekeyer(OLD)(value)).toBe(value);
    }
  });

  it('refuses a value it cannot read, rather than copying it across unreadable', () => {
    const rekey = createRekeyer('not-the-right-secret');
    // Copying it would "succeed" and leave a certificate key nothing can ever decrypt.
    expect(() => rekey(encryptWith('unreachable', OLD))).toThrow(LegacySecretError);
  });

  it('asks for a key when none was given and the current one does not fit', () => {
    expect(() => createRekeyer(null)(encryptWith('unreachable', OLD))).toThrow(
      /different SESSION_SECRET/,
    );
  });
});

describe('probeLegacySecrets', () => {
  // Torn down in afterAll, not a final test: the order is randomised.
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'cpm-legacy-secrets-'));
  });
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function database(values: string[]): string {
    const path = join(directory, `${randomBytes(6).toString('hex')}.db`);
    const raw = new Database(path);
    raw.run('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    values.forEach((value, index) => {
      raw.run('INSERT INTO settings (key, value) VALUES (?, ?)', [`k${index}`, value]);
    });
    raw.close(true);
    return path;
  }

  it('reports a database with no secrets as needing nothing', () => {
    const probe = probeLegacySecrets(database(['plain', '{"enabled":true}']));

    expect(probe.hasEncryptedValues).toBe(false);
    // Vacuously readable: a file with nothing to decrypt never prompts for a key.
    expect(probe.readableWithCurrentKey).toBe(true);
  });

  it('recognises secrets this deployment can already read', () => {
    const probe = probeLegacySecrets(database([encryptSecret('ours')]));

    expect(probe.hasEncryptedValues).toBe(true);
    expect(probe.readableWithCurrentKey).toBe(true);
  });

  it('recognises secrets encrypted under another key', () => {
    const probe = probeLegacySecrets(database([encryptWith('theirs', OLD)]));

    expect(probe.hasEncryptedValues).toBe(true);
    expect(probe.readableWithCurrentKey).toBe(false);
    expect(verifyLegacyKey(probe, OLD)).toBe(true);
    expect(verifyLegacyKey(probe, CURRENT)).toBe(false);
  });

  it('finds a secret nested inside a JSON column', () => {
    const blob = JSON.stringify({ authKey: encryptWith('tskey-abc', OLD) });
    const probe = probeLegacySecrets(database([blob]));

    expect(probe.hasEncryptedValues).toBe(true);
    expect(probe.readableWithCurrentKey).toBe(false);
  });

  it('is not fooled by a file it cannot open', () => {
    const probe = probeLegacySecrets(join(directory, 'no-such-file.db'));

    expect(probe.hasEncryptedValues).toBe(false);
    expect(probe.samples).toEqual([]);
  });

  it('has no key to verify when the database holds no secrets', () => {
    // Guards against "every sample decrypts" being vacuously true and waving a wrong key through.
    const probe = probeLegacySecrets(database(['plain']));
    expect(verifyLegacyKey(probe, 'anything-at-all')).toBe(false);
  });
});
