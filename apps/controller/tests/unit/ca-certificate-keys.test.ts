/**
 * Older releases stored CA private keys in plain text, so reads accept that until the startup
 * pass has sealed the row.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => ({
  default: ctx.db,
  sqlite: undefined,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null =>
    !value ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
}));
vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));
vi.mock('../../src/lib/caddy', () => ({ applyCaddyConfig: vi.fn() }));

const {
  createCaCertificate,
  getCaCertificate,
  getCaCertificatePrivateKey,
  migrateLegacyCaCertificateStorage,
  updateCaCertificate,
} = await import('../../src/lib/models/ca-certificates');
const { isEncryptedSecret, sealSecretColumn } = await import('../../src/lib/secret');
const { caCertificates } = schemaModule;

const KEY = '-----BEGIN PRIVATE KEY-----\nMIIsecret\n-----END PRIVATE KEY-----';
const CERT = '-----BEGIN CERTIFICATE-----\nMIIcert\n-----END CERTIFICATE-----';
const NOW = new Date().toISOString();

async function stored(id: number) {
  const [row] = await ctx.db
    .select({ privateKeyPem: caCertificates.privateKeyPem })
    .from(caCertificates)
    .where(eq(caCertificates.id, id));
  return row?.privateKeyPem ?? null;
}

async function insertPlain(name: string, privateKeyPem: string | null) {
  const [row] = await ctx.db
    .insert(caCertificates)
    .values({ name, certificatePem: CERT, privateKeyPem, createdAt: NOW, updatedAt: NOW })
    .returning({ id: caCertificates.id });
  return row.id;
}

beforeEach(async () => {
  await ctx.db.delete(caCertificates);
  await ctx.db.delete(schemaModule.users).catch(() => {});
  await ctx.db.insert(schemaModule.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    provider: 'credentials',
    subject: 'admin',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
});

describe('CA private keys at rest', () => {
  it('encrypts on create and decrypts for the one caller that needs the key', async () => {
    const ca = await createCaCertificate(
      { name: 'root', certificatePem: CERT, privateKeyPem: KEY },
      1,
    );
    const raw = await stored(ca.id);
    expect(raw && isEncryptedSecret(raw)).toBe(true);
    expect(raw).not.toContain('MIIsecret');
    expect(await getCaCertificatePrivateKey(ca.id)).toBe(KEY);
    expect((await getCaCertificate(ca.id))?.hasPrivateKey).toBe(true);
  });

  it('encrypts a key set on update, and leaves it alone when the update omits it', async () => {
    const ca = await createCaCertificate({ name: 'root', certificatePem: CERT }, 1);
    expect(await stored(ca.id)).toBeNull();
    await updateCaCertificate(ca.id, { privateKeyPem: KEY }, 1);
    const sealed = await stored(ca.id);
    expect(sealed && isEncryptedSecret(sealed)).toBe(true);
    await updateCaCertificate(ca.id, { name: 'renamed' }, 1);
    expect(await stored(ca.id)).toBe(sealed);
  });

  it('still reads a key an older release stored in plain text', async () => {
    const id = await insertPlain('legacy', KEY);
    expect(await getCaCertificatePrivateKey(id)).toBe(KEY);
  });

  it('seals plain-text keys at startup, once', async () => {
    const plain = await insertPlain('legacy', KEY);
    const none = await insertPlain('no key', null);
    const already = (
      await createCaCertificate({ name: 'new', certificatePem: CERT, privateKeyPem: KEY }, 1)
    ).id;
    const before = await stored(already);

    expect(await migrateLegacyCaCertificateStorage()).toBe(1);
    const sealed = await stored(plain);
    expect(sealed && isEncryptedSecret(sealed)).toBe(true);
    expect(await getCaCertificatePrivateKey(plain)).toBe(KEY);
    expect(await stored(none)).toBeNull();
    expect(await stored(already)).toBe(before);

    expect(await migrateLegacyCaCertificateStorage()).toBe(0);
  });
});

describe('sealSecretColumn', () => {
  it('encrypts the named key columns and nothing else', () => {
    expect(isEncryptedSecret(sealSecretColumn('ca_certificates', 'privateKeyPem', KEY))).toBe(true);
    expect(isEncryptedSecret(sealSecretColumn('certificates', 'privateKeyPem', KEY))).toBe(true);
    expect(sealSecretColumn('ca_certificates', 'certificatePem', CERT)).toBe(CERT);
    expect(sealSecretColumn('proxy_hosts', 'privateKeyPem', KEY)).toBe(KEY);
  });

  it('leaves an encrypted value as it is', () => {
    const once = sealSecretColumn('ca_certificates', 'privateKeyPem', KEY);
    expect(sealSecretColumn('ca_certificates', 'privateKeyPem', once)).toBe(once);
  });
});

describe('backups', () => {
  it('carry the key as a marker and seal it again on restore', async () => {
    const { exportRow, importRow } = await import('../../src/lib/backup/secrets');
    const ca = await createCaCertificate(
      { name: 'root', certificatePem: CERT, privateKeyPem: KEY },
      1,
    );
    const [row] = await ctx.db.select().from(caCertificates).where(eq(caCertificates.id, ca.id));
    const exported = await exportRow('ca_certificates', row);
    expect(exported.privateKeyPem).not.toContain('enc:v1:');
    const restored = await importRow('ca_certificates', exported);
    expect(isEncryptedSecret(restored.privateKeyPem as string)).toBe(true);
  });

  it('seal a key that a backup from an older release carries in plain text', async () => {
    const { importRow } = await import('../../src/lib/backup/secrets');
    const restored = await importRow('ca_certificates', { name: 'old', privateKeyPem: KEY });
    expect(isEncryptedSecret(restored.privateKeyPem as string)).toBe(true);
    expect(restored.name).toBe('old');
  });
});
