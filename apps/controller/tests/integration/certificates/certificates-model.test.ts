/**
 * Integration: deleting a certificate a host still uses is refused, since the `set null` foreign
 * key would otherwise move that host to ACME without anyone asking.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { createTestDb, type TestDb } from '../../helpers/db';
import { eq } from 'drizzle-orm';
import { certificates, proxyHosts, users } from '../../../src/lib/db/schema';
import { DomainError } from '../../../src/lib/errors/domain-error';

let db: TestDb;
let dashboardCertificateId: number | null = null;

vi.mock('../../../src/lib/db', () => dbModuleMock(() => db));
vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));
const applyCaddyConfig = vi.fn(async () => {});
vi.mock('../../../src/lib/caddy', () => ({ applyCaddyConfig }));
vi.mock('../../../src/lib/settings', () => ({
  getDashboardSettings: async () => ({
    enabled: false,
    domain: '',
    tls: false,
    options: { certificateId: dashboardCertificateId },
  }),
}));

const { createCertificate, deleteCertificate, updateCertificate } = await import(
  '../../../src/lib/models/certificates'
);
const { createSelfSignedServerCertificate } = await import('../../helpers/certs');

let userId: number;

beforeEach(async () => {
  db = await createTestDb();
  vi.clearAllMocks();
  dashboardCertificateId = null;
  const now = new Date().toISOString();
  const [user] = await db
    .insert(users)
    .values({
      email: 'admin@test',
      name: 'Admin',
      role: 'admin',
      provider: 'credentials',
      subject: 'admin@test',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  userId = user.id;
});

async function insertCertificate(name: string) {
  const now = new Date().toISOString();
  const [cert] = await db
    .insert(certificates)
    .values({
      name,
      type: 'imported',
      domainNames: JSON.stringify(['example.com']),
      autoRenew: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return cert;
}

async function insertHost(name: string, certificateId: number | null) {
  const now = new Date().toISOString();
  await db.insert(proxyHosts).values({
    name,
    domains: JSON.stringify([`${name}.example.com`]),
    upstreams: JSON.stringify(['app:80']),
    certificateId,
    createdAt: now,
    updatedAt: now,
  });
}

async function failure(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

describe('deleteCertificate', () => {
  it('refuses while a host uses it, naming the hosts, and changes nothing', async () => {
    const cert = await insertCertificate('Wildcard');
    await insertHost('alpha', cert.id);
    await insertHost('beta', cert.id);

    const error = await failure(deleteCertificate(cert.id, userId));
    expect(error.code).toBe('certificateInUseByHosts');
    expect(error.status).toBe(409);
    expect([...(error.params.hosts as string[])].sort()).toEqual(['alpha', 'beta']);

    expect(await db.select().from(certificates)).toHaveLength(1);
    const hosts = await db.select({ certificateId: proxyHosts.certificateId }).from(proxyHosts);
    expect(hosts.every((h) => h.certificateId === cert.id)).toBe(true);
    expect(applyCaddyConfig).not.toHaveBeenCalled();
  });

  it('refuses while the dashboard host uses it, even when that host is off', async () => {
    const cert = await insertCertificate('Dashboard');
    dashboardCertificateId = cert.id;

    const error = await failure(deleteCertificate(cert.id, userId));
    expect(error.code).toBe('certificateInUseByDashboard');
    expect(await db.select().from(certificates)).toHaveLength(1);
  });

  it('deletes one nothing uses', async () => {
    const used = await insertCertificate('Used');
    const unused = await insertCertificate('Unused');
    await insertHost('alpha', used.id);
    await insertHost('gamma', null);

    await deleteCertificate(unused.id, userId);
    const left = await db.select({ id: certificates.id }).from(certificates);
    expect(left.map((c) => c.id)).toEqual([used.id]);
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);
  });
});

// Caddy refuses a pair it cannot load, and with it every host's config.
describe('importing a certificate', () => {
  const { certificatePem, privateKeyPem } = createSelfSignedServerCertificate('pair.example.com', [
    'pair.example.com',
  ]);
  const other = createSelfSignedServerCertificate('other.example.com', ['other.example.com']);
  const imported = (certificate: string, key: string) => ({
    name: 'Imported',
    type: 'imported' as const,
    domainNames: ['pair.example.com'],
    certificatePem: certificate,
    privateKeyPem: key,
  });
  const garbage = (label: string) => `-----BEGIN ${label}-----\nnot\n-----END ${label}-----`;

  it.each([
    [
      'a key from another certificate',
      certificatePem,
      other.privateKeyPem,
      'importedCertificateKeyMismatch',
    ],
    [
      'a certificate that does not parse',
      garbage('CERTIFICATE'),
      privateKeyPem,
      'importedCertificateInvalid',
    ],
    [
      'a key that does not parse',
      certificatePem,
      garbage('PRIVATE KEY'),
      'importedCertificateKeyInvalid',
    ],
  ])('refuses %s', async (_label, certificate, key, code) => {
    const error = await failure(createCertificate(imported(certificate, key), userId));
    expect(error.code).toBe(code as never);
    expect(error.status).toBe(400);
    expect(await db.select().from(certificates)).toHaveLength(0);
    expect(applyCaddyConfig).not.toHaveBeenCalled();
  });

  it('refuses an update that would break a stored pair, and keeps the pair', async () => {
    const created = await createCertificate(imported(certificatePem, privateKeyPem), userId);
    const error = await failure(
      updateCertificate(created.id, { privateKeyPem: other.privateKeyPem }, userId),
    );
    expect(error.code).toBe('importedCertificateKeyMismatch');
    const [row] = await db.select().from(certificates);
    expect(row.certificatePem).toBe(certificatePem);
  });
});

// The editor sends null to take an override away; a request that leaves the field out keeps it.
describe('the DNS provider override', () => {
  const managed = { name: 'Managed', type: 'managed' as const, domainNames: ['*.example.com'] };

  async function storedOptions(id: number) {
    const [row] = await db.select().from(certificates).where(eq(certificates.id, id));
    return row.providerOptions;
  }

  it('stores only the provider name, and clears on null but not on an omitted field', async () => {
    const created = await createCertificate(
      { ...managed, providerOptions: { provider: ' cloudflare ', api_token: 'secret' } },
      userId,
    );
    expect(await storedOptions(created.id)).toBe('{"provider":"cloudflare"}');
    expect(created.providerOptions).toEqual({ provider: 'cloudflare' });

    const kept = await updateCertificate(created.id, { name: 'Renamed' }, userId);
    expect(kept.providerOptions).toEqual({ provider: 'cloudflare' });

    const cleared = await updateCertificate(created.id, { providerOptions: null }, userId);
    expect(cleared.providerOptions).toBeNull();
    expect(await storedOptions(created.id)).toBeNull();
  });
});
