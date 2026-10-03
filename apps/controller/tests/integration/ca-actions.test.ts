/**
 * The Certificates page's CA actions against a real database and the real models: a generated CA
 * can issue, what it issues chains to it and is stored, a revoke sticks, and each refusal reaches
 * the dialog as the catalog's sentence rather than a raw code.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

// A Bun mock factory must be synchronous; an async one never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));
vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/src/lib/auth', () => ({
  requireAdmin: vi.fn(async () => ({ user: { id: '1', role: 'admin' } })),
}));

import { eq } from 'drizzle-orm';
import {
  createCaCertificateAction,
  deleteCaCertificateAction,
  generateCaCertificateAction,
  issueClientCertificateAction,
  revokeIssuedClientCertificateAction,
  updateCaCertificateAction,
} from '@/src/app/(dashboard)/certificates/ca-actions';
import { logAuditEvent } from '@/src/lib/audit';
import { DomainError, domainErrorMessage } from '@/src/lib/domain-error';
import {
  getIssuedClientCertificate,
  listIssuedClientCertificates,
} from '@/src/lib/models/issued-client-certificates';
import {
  caCertificates,
  issuedClientCertificates,
  proxyHosts,
  users,
} from '../../src/lib/db/schema';

const NOW = '2026-03-01T00:00:00.000Z';
const EXPORT_PASSWORD = 'Correct-Horse-Battery-Staple1!';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

/** setup.bun.ts replaces logAuditEvent with a mock. */
function auditRows() {
  return vi.mocked(logAuditEvent).mock.calls.map(([event]) => event);
}

async function caRow(id: number) {
  const [row] = await ctx.db.select().from(caCertificates).where(eq(caCertificates.id, id));
  return row;
}

/** A 4096-bit keygen per test would dominate the file; the CA is made once and reused. */
let generated: { id: number; certificatePem: string; privateKeyPem: string | null };

beforeAll(async () => {
  await ctx.db.insert(users).values({
    id: 1,
    email: 'admin@example.com',
    role: 'admin',
    createdAt: NOW,
    updatedAt: NOW,
  });
  const { id } = await generateCaCertificateAction(
    form({ name: ' Internal CA ', common_name: 'Internal Root', validity_days: '99999' }),
  );
  const row = await caRow(id);
  generated = { id, certificatePem: row.certificatePem, privateKeyPem: row.privateKeyPem };
});

beforeEach(async () => {
  vi.mocked(logAuditEvent).mockClear();
  await ctx.db.delete(proxyHosts);
  await ctx.db.delete(issuedClientCertificates);
});

describe('generateCaCertificateAction', () => {
  it('stores a self-signed CA with a sealed key and caps its validity at ten years', async () => {
    const row = await caRow(generated.id);
    expect(row.name).toBe('Internal CA');
    expect(row.createdBy).toBe(1);
    // Sealed at rest: never the PEM itself.
    expect(generated.privateKeyPem).not.toContain('PRIVATE KEY');

    const cert = new X509Certificate(generated.certificatePem);
    expect(cert.ca).toBe(true);
    expect(cert.subject).toContain('CN=Internal Root');
    expect(cert.checkIssued(cert)).toBe(true);
    const days = (Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / 86_400_000;
    expect(Math.round(days)).toBe(3650);
  });

  it('gives the CA a random 16-byte positive serial, not the same one every time', () => {
    const { serialNumber } = new X509Certificate(generated.certificatePem);
    expect(serialNumber).toMatch(/^[0-7][0-9A-F]{31}$/);
    expect(serialNumber).not.toBe('01');
  });

  it('refuses a blank name before generating anything', async () => {
    const before = await ctx.db.select().from(caCertificates);
    await expect(generateCaCertificateAction(form({ name: '  ' }))).rejects.toThrow(
      domainErrorMessage('nameRequired'),
    );
    expect(await ctx.db.select().from(caCertificates)).toHaveLength(before.length);
  });
});

describe('createCaCertificateAction', () => {
  it('stores an uploaded CA without a private key and audits it', async () => {
    await createCaCertificateAction(
      form({ name: 'Uploaded', certificate_pem: `\n${generated.certificatePem}\n` }),
    );

    const [row] = await ctx.db
      .select()
      .from(caCertificates)
      .where(eq(caCertificates.name, 'Uploaded'));
    expect(row.certificatePem).toBe(generated.certificatePem.trim());
    expect(row.privateKeyPem).toBeNull();
    expect(auditRows()).toEqual([
      expect.objectContaining({ action: 'create', entityType: 'ca_certificate', entityId: row.id }),
    ]);
  });

  it.each([
    [{ certificate_pem: 'x' }, 'nameRequired'],
    [{ name: 'CA' }, 'certificatePemRequired'],
    [{ name: 'CA', certificate_pem: 'not a certificate' }, 'certificatePemInvalid'],
  ] as const)('refuses %p with the %s sentence', async (fields, code) => {
    await expect(createCaCertificateAction(form(fields))).rejects.toThrow(domainErrorMessage(code));
    expect(auditRows()).toEqual([]);
  });
});

describe('updateCaCertificateAction', () => {
  it('renames and keeps the certificate when none is sent', async () => {
    await createCaCertificateAction(
      form({ name: 'Before', certificate_pem: generated.certificatePem }),
    );
    const [row] = await ctx.db
      .select()
      .from(caCertificates)
      .where(eq(caCertificates.name, 'Before'));

    await updateCaCertificateAction(row.id, form({ name: ' After ' }));

    const updated = await caRow(row.id);
    expect(updated.name).toBe('After');
    expect(updated.certificatePem).toBe(row.certificatePem);
  });

  it('refuses a PEM that does not parse, leaving the row alone', async () => {
    const before = await caRow(generated.id);
    const error = await updateCaCertificateAction(
      generated.id,
      form({ certificate_pem: 'garbage' }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('certificatePemInvalid');
    expect(await caRow(generated.id)).toEqual(before);
  });
});

describe('issueClientCertificateAction', () => {
  it('issues a client certificate that chains to the CA and records it', async () => {
    const result = await issueClientCertificateAction(
      generated.id,
      form({ common_name: ' alice ', validity_days: '30', export_password: EXPORT_PASSWORD }),
    );
    expect(result.passwordProtected).toBe(true);
    expect(result.pkcs12Base64.length).toBeGreaterThan(0);

    const [issued] = await listIssuedClientCertificates();
    expect(issued).toMatchObject({ caCertificateId: generated.id, commonName: 'alice' });
    expect(issued.revokedAt).toBeNull();

    const cert = new X509Certificate(issued.certificatePem);
    const ca = new X509Certificate(generated.certificatePem);
    expect(cert.checkIssued(ca)).toBe(true);
    expect(cert.verify(ca.publicKey)).toBe(true);
    expect(cert.ca).toBe(false);
    expect(cert.fingerprint256).toBe(issued.fingerprintSha256);
    // As openssl prints it: whole bytes, so a leading zero nibble is kept.
    expect(issued.serialNumber).toBe(cert.serialNumber);
    expect(issued.serialNumber).toMatch(/^(?:[0-9A-F]{2})+$/);
    expect(auditRows()).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ serialNumber: cert.serialNumber }),
      }),
    );
    expect(
      Math.round((Date.parse(issued.validTo) - Date.parse(issued.validFrom)) / 86_400_000),
    ).toBe(30);
    expect(auditRows()).toContainEqual(
      expect.objectContaining({
        action: 'create',
        entityType: 'issued_client_certificate',
        entityId: issued.id,
      }),
    );
  });

  // RFC 5280 wants serials unique per CA; a timestamp repeated within a millisecond.
  it('gives certificates issued together distinct random 16-byte serials', async () => {
    const fields = form({ common_name: 'bob', export_password: EXPORT_PASSWORD });
    await Promise.all([
      issueClientCertificateAction(generated.id, fields),
      issueClientCertificateAction(generated.id, fields),
    ]);
    const serials = (await listIssuedClientCertificates()).map((row) => row.serialNumber);
    expect(serials).toHaveLength(2);
    expect(new Set(serials).size).toBe(2);
    for (const serial of serials) expect(serial).toMatch(/^[0-7][0-9A-F]{31}$/);
  });

  it.each([
    [{ export_password: EXPORT_PASSWORD }, 'commonNameRequired'],
    [{ common_name: 'alice' }, 'exportPasswordRequired'],
  ] as const)('refuses %p with the %s sentence', async (fields, code) => {
    await expect(issueClientCertificateAction(generated.id, form(fields))).rejects.toThrow(
      domainErrorMessage(code),
    );
    expect(await listIssuedClientCertificates()).toEqual([]);
  });

  it('refuses a CA that was uploaded without its private key', async () => {
    await createCaCertificateAction(
      form({ name: 'Keyless', certificate_pem: generated.certificatePem }),
    );
    const [keyless] = await ctx.db
      .select()
      .from(caCertificates)
      .where(eq(caCertificates.name, 'Keyless'));

    await expect(
      issueClientCertificateAction(
        keyless.id,
        form({ common_name: 'alice', export_password: EXPORT_PASSWORD }),
      ),
    ).rejects.toThrow(domainErrorMessage('caCertificatePrivateKeyMissing'));
    expect(await listIssuedClientCertificates()).toEqual([]);
  });
});

describe('issued certificate serials', () => {
  async function seedLegacy(serialNumber: string) {
    const [row] = await ctx.db
      .insert(issuedClientCertificates)
      .values({
        caCertificateId: generated.id,
        commonName: 'legacy',
        serialNumber,
        fingerprintSha256: 'AA:BB',
        certificatePem: 'PEM',
        validFrom: NOW,
        validTo: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning();
    return row;
  }

  it.each([
    ['1A0F127EB24', '01A0F127EB24'],
    ['1a:0f', '1A0F'],
    ['00FF', 'FF'],
    ['00', '00'],
  ])('reads a row stored as %s as %s, and revokes it by id as before', async (stored, shown) => {
    const row = await seedLegacy(stored);

    expect((await getIssuedClientCertificate(row.id))?.serialNumber).toBe(shown);
    expect((await listIssuedClientCertificates())[0]?.serialNumber).toBe(shown);
    const { revokedAt } = await revokeIssuedClientCertificateAction(row.id);
    expect((await getIssuedClientCertificate(row.id))?.revokedAt).toBe(revokedAt);
  });

  it('leaves a serial that is not hex as it was given', async () => {
    const row = await seedLegacy('-80');
    expect((await getIssuedClientCertificate(row.id))?.serialNumber).toBe('-80');
  });
});

describe('revokeIssuedClientCertificateAction', () => {
  async function issueOne() {
    await issueClientCertificateAction(
      generated.id,
      form({ common_name: 'bob', export_password: EXPORT_PASSWORD }),
    );
    return (await listIssuedClientCertificates())[0];
  }

  it('revokes once, stamps the time and audits it', async () => {
    const issued = await issueOne();
    vi.mocked(logAuditEvent).mockClear();

    const { revokedAt } = await revokeIssuedClientCertificateAction(issued.id);

    expect(Date.parse(revokedAt)).not.toBeNaN();
    expect((await getIssuedClientCertificate(issued.id))?.revokedAt).toBe(revokedAt);
    expect(auditRows()).toEqual([
      expect.objectContaining({
        action: 'revoke',
        entityType: 'issued_client_certificate',
        entityId: issued.id,
      }),
    ]);
  });

  it('refuses a second revoke, keeping the first time', async () => {
    const issued = await issueOne();
    const { revokedAt } = await revokeIssuedClientCertificateAction(issued.id);

    await expect(revokeIssuedClientCertificateAction(issued.id)).rejects.toMatchObject({
      code: 'issuedClientCertificateAlreadyRevoked',
    });
    expect((await getIssuedClientCertificate(issued.id))?.revokedAt).toBe(revokedAt);
  });

  it('refuses a certificate that does not exist', async () => {
    await expect(revokeIssuedClientCertificateAction(9999)).rejects.toMatchObject({
      code: 'issuedClientCertificateNotFound',
    });
    expect(await getIssuedClientCertificate(9999)).toBeNull();
  });
});

describe('deleteCaCertificateAction', () => {
  async function uploadedCa(name: string): Promise<number> {
    await createCaCertificateAction(form({ name, certificate_pem: generated.certificatePem }));
    const [row] = await ctx.db.select().from(caCertificates).where(eq(caCertificates.name, name));
    return row.id;
  }

  it('answers a missing CA with the translated sentence', async () => {
    expect(await deleteCaCertificateAction(9999)).toEqual({
      success: false,
      error: domainErrorMessage('caCertificateNotFound'),
    });
  });

  it('refuses a CA a host still trusts, naming the host', async () => {
    const id = await uploadedCa('Trusted');
    await ctx.db.insert(proxyHosts).values({
      name: 'Payroll',
      domains: JSON.stringify(['payroll.example.com']),
      upstreams: JSON.stringify(['payroll:8080']),
      meta: JSON.stringify({ mtls: { enabled: true, ca_certificate_ids: [id] } }),
      createdAt: NOW,
      updatedAt: NOW,
    });

    const result = await deleteCaCertificateAction(id);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Payroll');
    expect(await caRow(id)).toBeDefined();
  });

  it('deletes an unused CA together with what it issued', async () => {
    const id = await uploadedCa('Disposable');
    await ctx.db.insert(issuedClientCertificates).values({
      caCertificateId: id,
      commonName: 'carol',
      serialNumber: '01',
      fingerprintSha256: 'AA',
      certificatePem: generated.certificatePem,
      validFrom: NOW,
      validTo: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(await deleteCaCertificateAction(id)).toEqual({ success: true });
    expect(await caRow(id)).toBeUndefined();
    expect(await listIssuedClientCertificates()).toEqual([]);
  });
});
