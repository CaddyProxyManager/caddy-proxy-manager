/**
 * Two hosts pinning different client certificates from the same CA must each get a policy trusting
 * only their own leaves. Grouping by CA set alone unioned the pinned leaves of both into one.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

// Hoisted: a Bun mock factory must be synchronous, and an async one hangs the file.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { createProxyHost } from '../../../src/lib/models/proxy-hosts';
import { buildCaddyDocument } from '../../../src/lib/caddy';
import { groupMtlsDomainsByCaSet } from '../../../src/lib/caddy/mtls';
import * as schema from '../../../src/lib/db/schema';

const pem = (b64: string) => `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----`;
const CA_B64 = 'Q0FDRVJU';
const ALICE_B64 = 'QUxJQ0U=';
const BOB_B64 = 'Qk9C';

function policyForDomain(doc: unknown, domain: string): Record<string, unknown> | undefined {
  const servers =
    (
      doc as {
        apps?: {
          http?: {
            servers?: Record<string, { tls_connection_policies?: Record<string, unknown>[] }>;
          };
        };
      }
    )?.apps?.http?.servers ?? {};
  for (const server of Object.values(servers)) {
    for (const policy of server.tls_connection_policies ?? []) {
      const sni = (policy.match as { sni?: string[] } | undefined)?.sni;
      if (Array.isArray(sni) && sni.includes(domain)) return policy;
    }
  }
  return undefined;
}

beforeEach(async () => {
  const now = new Date().toISOString();
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.issuedClientCertificates);
  await ctx.db.delete(schema.caCertificates);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    provider: 'credentials',
    subject: 'admin',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert(schema.caCertificates).values({
    id: 1,
    name: 'CA',
    certificatePem: pem(CA_B64),
    createdAt: now,
    updatedAt: now,
  });
  for (const [id, cn, b64] of [
    [1, 'alice', ALICE_B64],
    [2, 'bob', BOB_B64],
  ] as const) {
    await ctx.db.insert(schema.issuedClientCertificates).values({
      id,
      caCertificateId: 1,
      commonName: cn,
      serialNumber: String(id),
      fingerprintSha256: `fp${id}`,
      certificatePem: pem(b64),
      validFrom: now,
      validTo: '2099-01-01T00:00:00.000Z',
      createdAt: now,
      updatedAt: now,
    });
  }
});

describe('mTLS leaf pinning isolation between hosts sharing a CA', () => {
  it('gives each host a policy that trusts only its own pinned leaf', async () => {
    await createProxyHost(
      {
        name: 'admin',
        domains: ['admin.example.com'],
        upstreams: ['10.0.0.5:8080'],
        mtls: { enabled: true, trusted_client_cert_ids: [1] },
      },
      1,
    );
    await createProxyHost(
      {
        name: 'public',
        domains: ['public.example.com'],
        upstreams: ['10.0.0.6:8080'],
        mtls: { enabled: true, trusted_client_cert_ids: [2] },
      },
      1,
    );

    const doc = await buildCaddyDocument();
    const adminPolicy = policyForDomain(doc, 'admin.example.com');
    const publicPolicy = policyForDomain(doc, 'public.example.com');

    expect(adminPolicy).toBeDefined();
    expect(publicPolicy).toBeDefined();
    expect(adminPolicy).not.toBe(publicPolicy);

    const adminAuth = adminPolicy!.client_authentication as { trusted_leaf_certs?: string[] };
    const publicAuth = publicPolicy!.client_authentication as { trusted_leaf_certs?: string[] };
    expect(adminAuth.trusted_leaf_certs).toEqual([ALICE_B64]);
    expect(publicAuth.trusted_leaf_certs).toEqual([BOB_B64]);
  });

  it('still shares one policy between hosts pinning the same leaves', () => {
    const caMap = new Map([
      ['a.example.com', [1]],
      ['b.example.com', [1]],
      ['c.example.com', [1]],
    ]);
    const leaves = new Map([
      ['a.example.com', [pem(ALICE_B64), pem(BOB_B64)]],
      ['b.example.com', [` ${pem(BOB_B64)}`, pem(ALICE_B64)]],
      ['c.example.com', [pem(BOB_B64)]],
    ]);
    const groups = [
      ...groupMtlsDomainsByCaSet(
        ['a.example.com', 'b.example.com', 'c.example.com'],
        caMap,
        leaves,
      ).values(),
    ];
    expect(groups).toEqual([['a.example.com', 'b.example.com'], ['c.example.com']]);
  });
});
