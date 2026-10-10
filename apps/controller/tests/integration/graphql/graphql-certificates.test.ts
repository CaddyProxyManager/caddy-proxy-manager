/**
 * The certificate family's writes over GraphQL: each mutation is read back from the database, so a
 * resolver reporting success without writing fails here; a viewer is refused every one; and no
 * answer carries a private key, the schema having no field for one.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { capabilitiesOf } from '@/tests/helpers/access';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { eq } from 'drizzle-orm';
import { graphql } from 'graphql';
import { schema } from '../../../src/lib/graphql/schema';
import type { GraphQLContext } from '../../../src/lib/graphql/context';
import * as db from '../../../src/lib/db/schema';
import { type FakeCaddy, installFakeCaddy } from '../../helpers/caddy-admin';

const NOW = '2026-03-01T00:00:00.000Z';
const LATER = '2027-03-01T00:00:00.000Z';

function contextFor(role: string | null): GraphQLContext {
  return {
    viewer: async () => {
      if (!role) throw new Error('Unauthorized');
      return { userId: 1, role, authMethod: 'bearer' as const };
    },
    access: async () => ({
      userId: 1,
      role: role ?? '',
      capabilities: capabilitiesOf(role),
      grants: { proxyHosts: new Map(), l4ProxyHosts: new Map(), agents: new Map() },
    }),
    rawBody: async () => '',
    request: {} as never,
  };
}

async function run(
  document: string,
  role: string | null,
  variableValues?: Record<string, unknown>,
) {
  return await graphql({
    schema,
    source: document,
    contextValue: contextFor(role),
    variableValues,
  });
}

/** The data of a call that must succeed; its errors are the failure message otherwise. */
async function ok<T = Record<string, unknown>>(
  document: string,
  variableValues?: Record<string, unknown>,
): Promise<T> {
  const result = await run(document, 'admin', variableValues);
  expect(result.errors).toBeUndefined();
  return result.data as T;
}

async function seedCa(name = 'Root') {
  const [ca] = await ctx.db
    .insert(db.caCertificates)
    .values({ name, certificatePem: 'PEM', createdAt: NOW, updatedAt: NOW })
    .returning();
  return ca.id;
}

async function seedClientCertificate(caId: number, commonName = 'alice') {
  const [cert] = await ctx.db
    .insert(db.issuedClientCertificates)
    .values({
      caCertificateId: caId,
      commonName,
      serialNumber: '01',
      fingerprintSha256: 'AA',
      certificatePem: 'PEM',
      validFrom: NOW,
      validTo: LATER,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning();
  return cert.id;
}

async function seedRole(name = 'finance') {
  const [role] = await ctx.db
    .insert(db.mtlsRoles)
    .values({ name, createdAt: NOW, updatedAt: NOW })
    .returning();
  return role.id;
}

async function createHost(name: string) {
  const data = await ok<{ createProxyHost: { id: number } }>(
    'mutation ($input: JSON!) { createProxyHost(input: $input) { id } }',
    { input: { name, domains: [`${name}.example.com`], upstreams: ['backend:8080'] } },
  );
  return data.createProxyHost.id;
}

let caddy: FakeCaddy;

beforeEach(async () => {
  caddy = installFakeCaddy();
  for (const table of [
    db.mtlsAccessRules,
    db.mtlsCertificateRoles,
    db.issuedClientCertificates,
    db.caCertificates,
    db.proxyHosts,
    db.certificates,
    db.mtlsRoles,
    db.users,
  ]) {
    await ctx.db.delete(table);
  }
  await ctx.db.insert(db.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    passwordHash: 'hash-that-must-not-leak',
    createdAt: NOW,
    updatedAt: NOW,
  });
});

describe('the role gate', () => {
  const documents = [
    '{ clientCertificateRoles(id: 1) { id } }',
    '{ mtlsAccessRules(proxyHostId: 1) { id } }',
    'mutation { createCertificate(input: {}) { id } }',
    'mutation { updateCertificate(id: 1, input: {}) { id } }',
    'mutation { deleteCertificate(id: 1) }',
    'mutation { rereadCertificate(id: 1) { id } }',
    'mutation { createCaCertificate(input: {}) { id } }',
    'mutation { deleteCaCertificate(id: 1) }',
    'mutation { issueClientCertificate(input: {}) { id } }',
    'mutation { revokeClientCertificate(id: 1) { id } }',
    'mutation { createMtlsRole(input: {}) { id } }',
    'mutation { updateMtlsRole(id: 1, input: {}) { id } }',
    'mutation { deleteMtlsRole(id: 1) }',
    'mutation { addMtlsRoleCertificate(roleId: 1, certificateId: 1) { id } }',
    'mutation { removeMtlsRoleCertificate(roleId: 1, certificateId: 1) }',
    'mutation { createMtlsAccessRule(proxyHostId: 1, input: {}) { id } }',
    'mutation { updateMtlsAccessRule(id: 1, input: {}) { id } }',
    'mutation { deleteMtlsAccessRule(id: 1) }',
  ];

  it('refuses every field to a viewer, and writes nothing', async () => {
    const caId = await seedCa();
    await seedClientCertificate(caId);
    await seedRole();
    for (const document of documents) {
      const result = await run(document, 'viewer');
      expect(result.errors?.[0]?.message, document).toContain(
        "This account's role does not allow this request",
      );
    }
    expect(await ctx.db.select().from(db.caCertificates)).toHaveLength(1);
    expect(await ctx.db.select().from(db.issuedClientCertificates)).toHaveLength(1);
    expect(await ctx.db.select().from(db.mtlsRoles)).toHaveLength(1);
    expect(await ctx.db.select().from(db.certificates)).toEqual([]);
    expect(caddy.loads).toEqual([]);
  });
});

describe('certificates', () => {
  it('creates, updates, reads back and deletes a managed certificate', async () => {
    const created = await ok<{ createCertificate: { id: number; type: string; source: string } }>(
      'mutation ($input: JSON!) { createCertificate(input: $input) { id type source } }',
      { input: { name: 'wildcard', type: 'managed', domainNames: ['*.Example.com'] } },
    );
    const id = created.createCertificate.id;
    expect(created.createCertificate).toMatchObject({ type: 'managed', source: 'upload' });

    const updated = await ok<{ updateCertificate: { name: string; autoRenew: boolean } }>(
      'mutation ($id: Int!, $input: JSON!) { updateCertificate(id: $id, input: $input) { name autoRenew } }',
      { id, input: { name: 'renamed', autoRenew: false } },
    );
    expect(updated.updateCertificate).toEqual({ name: 'renamed', autoRenew: false });

    const [row] = await ctx.db.select().from(db.certificates).where(eq(db.certificates.id, id));
    expect(row).toMatchObject({ name: 'renamed', autoRenew: false });
    expect(JSON.parse(row.domainNames)).toEqual(['*.example.com']);

    await ok('mutation ($id: Int!) { deleteCertificate(id: $id) }', { id });
    expect(await ctx.db.select().from(db.certificates)).toEqual([]);
  });

  it('has no field through which a mutation could answer the key or the PEM', async () => {
    for (const field of ['privateKeyPem', 'certificatePem']) {
      const document = `mutation { createCertificate(input: {}) { ${field} } }`;
      const result = await run(document, 'admin');
      expect(result.errors?.[0]?.message, document).toContain(field);
    }
    expect(await ctx.db.select().from(db.certificates)).toEqual([]);
  });

  it("surfaces the model's refusal: an imported certificate needs its PEM pair", async () => {
    const result = await run(
      'mutation ($input: JSON!) { createCertificate(input: $input) { id } }',
      'admin',
      { input: { name: 'bare', type: 'imported', domainNames: ['a.example.com'] } },
    );
    expect(result.errors).toBeDefined();
    expect(await ctx.db.select().from(db.certificates)).toEqual([]);
  });

  it('refuses to re-read a certificate that was not read from an agent', async () => {
    const [cert] = await ctx.db
      .insert(db.certificates)
      .values({
        name: 'uploaded',
        type: 'imported',
        domainNames: JSON.stringify(['a.example.com']),
        certificatePem: 'CERT',
        privateKeyPem: 'KEY',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning();
    const result = await run(
      'mutation ($id: Int!) { rereadCertificate(id: $id) { id } }',
      'admin',
      { id: cert.id },
    );
    expect(result.errors).toBeDefined();
    const missing = await run('mutation { deleteCertificate(id: 99999) }', 'admin');
    expect(missing.errors).toBeDefined();
    expect(await ctx.db.select().from(db.certificates)).toHaveLength(1);
  });
});

describe('CA certificates', () => {
  it('creates one, sealing its key, and deletes it with what it issued', async () => {
    const created = await ok<{ createCaCertificate: { id: number; hasPrivateKey: boolean } }>(
      'mutation ($input: JSON!) { createCaCertificate(input: $input) { id name hasPrivateKey } }',
      { input: { name: ' Root ', certificatePem: 'PEM', privateKeyPem: 'KEY' } },
    );
    const id = created.createCaCertificate.id;
    expect(created.createCaCertificate).toMatchObject({ name: 'Root', hasPrivateKey: true });

    const [row] = await ctx.db.select().from(db.caCertificates);
    // Encrypted at rest, never the bytes that came in.
    expect(row.privateKeyPem).not.toBeNull();
    expect(row.privateKeyPem).not.toBe('KEY');
    const field = await run('{ caCertificates { privateKeyPem } }', 'admin');
    expect(field.errors?.[0]?.message).toContain('privateKeyPem');

    await seedClientCertificate(id);
    await ok('mutation ($id: Int!) { deleteCaCertificate(id: $id) }', { id });
    expect(await ctx.db.select().from(db.caCertificates)).toEqual([]);
    expect(await ctx.db.select().from(db.issuedClientCertificates)).toEqual([]);
  });

  it('refuses to delete a CA that does not exist', async () => {
    const result = await run('mutation { deleteCaCertificate(id: 99999) }', 'admin');
    expect(result.errors).toBeDefined();
  });
});

describe('client certificates', () => {
  it('records an issued certificate and revokes it once', async () => {
    const caId = await seedCa();
    const issued = await ok<{ issueClientCertificate: { id: number; serialNumber: string } }>(
      'mutation ($input: JSON!) { issueClientCertificate(input: $input) { id commonName serialNumber validTo revokedAt } }',
      {
        input: {
          caCertificateId: caId,
          commonName: 'alice',
          serialNumber: '0A:0B',
          fingerprintSha256: 'AA',
          certificatePem: 'PEM',
          validFrom: NOW,
          validTo: LATER,
        },
      },
    );
    const id = issued.issueClientCertificate.id;
    expect(issued.issueClientCertificate).toMatchObject({
      commonName: 'alice',
      serialNumber: '0A0B',
      validTo: LATER,
      revokedAt: null,
    });

    const revoked = await ok<{ revokeClientCertificate: { revokedAt: string | null } }>(
      'mutation ($id: Int!) { revokeClientCertificate(id: $id) { revokedAt } }',
      { id },
    );
    expect(revoked.revokeClientCertificate.revokedAt).not.toBeNull();
    const [row] = await ctx.db
      .select()
      .from(db.issuedClientCertificates)
      .where(eq(db.issuedClientCertificates.id, id));
    expect(row.revokedAt).toBe(revoked.revokeClientCertificate.revokedAt);

    const again = await run(
      'mutation ($id: Int!) { revokeClientCertificate(id: $id) { id } }',
      'admin',
      { id },
    );
    expect(again.errors).toBeDefined();
    const field = await run('{ clientCertificates { certificatePem } }', 'admin');
    expect(field.errors?.[0]?.message).toContain('certificatePem');
  });
});

describe('mTLS roles', () => {
  it('creates, updates, assigns a certificate, lists both ways, unassigns and deletes', async () => {
    const caId = await seedCa();
    const certId = await seedClientCertificate(caId);

    const created = await ok<{ createMtlsRole: { id: number; certificateIds: number[] } }>(
      'mutation ($input: JSON!) { createMtlsRole(input: $input) { id name description certificateCount certificateIds } }',
      { input: { name: ' finance ', description: 'Payroll' } },
    );
    const roleId = created.createMtlsRole.id;
    expect(created.createMtlsRole).toMatchObject({
      name: 'finance',
      description: 'Payroll',
      certificateCount: 0,
      certificateIds: [],
    });

    const updated = await ok<{ updateMtlsRole: { name: string; description: string | null } }>(
      'mutation ($id: Int!, $input: JSON!) { updateMtlsRole(id: $id, input: $input) { name description } }',
      { id: roleId, input: { description: null } },
    );
    expect(updated.updateMtlsRole).toEqual({ name: 'finance', description: null });

    const assigned = await ok<{ addMtlsRoleCertificate: Record<string, unknown> }>(
      'mutation ($r: Int!, $c: Int!) { addMtlsRoleCertificate(roleId: $r, certificateId: $c) { certificateCount certificateIds } }',
      { r: roleId, c: certId },
    );
    expect(assigned.addMtlsRoleCertificate).toEqual({
      certificateCount: 1,
      certificateIds: [certId],
    });

    const listed = await ok<{ mtlsRoles: unknown[]; clientCertificateRoles: unknown[] }>(
      'query ($c: Int!) { mtlsRoles { name certificateIds } clientCertificateRoles(id: $c) { name } }',
      { c: certId },
    );
    expect(listed).toEqual({
      mtlsRoles: [{ name: 'finance', certificateIds: [certId] }],
      clientCertificateRoles: [{ name: 'finance' }],
    });

    await ok(
      'mutation ($r: Int!, $c: Int!) { removeMtlsRoleCertificate(roleId: $r, certificateId: $c) }',
      { r: roleId, c: certId },
    );
    expect(await ctx.db.select().from(db.mtlsCertificateRoles)).toEqual([]);

    await ok('mutation ($id: Int!) { deleteMtlsRole(id: $id) }', { id: roleId });
    expect(await ctx.db.select().from(db.mtlsRoles)).toEqual([]);
  });

  it('answers the 400 REST gives a role without a name, and the not-found of the model', async () => {
    const unnamed = await run(
      'mutation { createMtlsRole(input: { description: "x" }) { id } }',
      'admin',
    );
    expect(unnamed.errors?.[0]?.message).toBe('name is required');
    expect(await ctx.db.select().from(db.mtlsRoles)).toEqual([]);

    const missing = await run(
      'mutation { addMtlsRoleCertificate(roleId: 99999, certificateId: 1) { id } }',
      'admin',
    );
    expect(missing.errors).toBeDefined();
  });
});

describe('mTLS access rules', () => {
  it('creates, lists, updates and deletes rules on a host', async () => {
    const hostId = await createHost('app');
    const roleId = await seedRole();

    const created = await ok<{ createMtlsAccessRule: { id: number } }>(
      'mutation ($h: Int!, $input: JSON!) { createMtlsAccessRule(proxyHostId: $h, input: $input) { id proxyHostId pathPattern allowedRoleIds allowedCertIds denyAll priority } }',
      { h: hostId, input: { pathPattern: ' /admin/* ', allowedRoleIds: [roleId], priority: 5 } },
    );
    const id = created.createMtlsAccessRule.id;
    expect(created.createMtlsAccessRule).toMatchObject({
      proxyHostId: hostId,
      pathPattern: '/admin/*',
      allowedRoleIds: [roleId],
      allowedCertIds: [],
      denyAll: false,
      priority: 5,
    });

    const updated = await ok<{ updateMtlsAccessRule: { denyAll: boolean; description: string } }>(
      'mutation ($id: Int!, $input: JSON!) { updateMtlsAccessRule(id: $id, input: $input) { denyAll description } }',
      { id, input: { denyAll: true, description: 'Nobody' } },
    );
    expect(updated.updateMtlsAccessRule).toEqual({ denyAll: true, description: 'Nobody' });

    const listed = await ok<{ mtlsAccessRules: unknown[] }>(
      'query ($h: Int!) { mtlsAccessRules(proxyHostId: $h) { id denyAll } }',
      { h: hostId },
    );
    expect(listed.mtlsAccessRules).toEqual([{ id, denyAll: true }]);
    const [row] = await ctx.db.select().from(db.mtlsAccessRules);
    expect(row).toMatchObject({ proxyHostId: hostId, denyAll: true, description: 'Nobody' });

    await ok('mutation ($id: Int!) { deleteMtlsAccessRule(id: $id) }', { id });
    expect(await ctx.db.select().from(db.mtlsAccessRules)).toEqual([]);
  });

  it('answers not found for a host that does not exist, and the 400 for a rule without a path', async () => {
    const hostId = await createHost('app');
    const missing = await run('{ mtlsAccessRules(proxyHostId: 99999) { id } }', 'admin');
    expect(missing.errors?.[0]?.message).toBe('Proxy host not found');

    const unpathed = await run(
      'mutation ($h: Int!) { createMtlsAccessRule(proxyHostId: $h, input: { priority: 1 }) { id } }',
      'admin',
      { h: hostId },
    );
    expect(unpathed.errors?.[0]?.message).toBe('pathPattern is required');
    expect(await ctx.db.select().from(db.mtlsAccessRules)).toEqual([]);
  });
});
