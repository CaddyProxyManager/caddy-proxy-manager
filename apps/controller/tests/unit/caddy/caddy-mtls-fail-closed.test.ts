/**
 * SECURITY-AUDIT H2: mTLS must FAIL CLOSED when a host has it enabled but nothing resolves to an
 * active certificate. The bug dropped such a host from mTlsDomainMap, so Caddy emitted a plain TLS
 * policy and served the backend to anyone. The fix keeps an empty CA set and require_and_verify.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

// Hoisted out of the factory below: createTestDb is async, and a Bun mock factory must be
// synchronous - an async one never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { createProxyHost } from '../../../src/lib/models/proxy-hosts';
import { buildCaddyDocument } from '../../../src/lib/caddy';
import * as schema from '../../../src/lib/db/schema';
import { DomainError } from '../../../src/lib/errors/domain-error';

const EMPTY_ROLE_ID = 999; // a role with no active certs (simulates all-revoked / empty role)

/** Collect every TLS connection policy from the document. */
function collectConnectionPolicies(doc: unknown): Record<string, unknown>[] {
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
  const out: Record<string, unknown>[] = [];
  for (const server of Object.values(servers)) {
    for (const p of server.tls_connection_policies ?? []) out.push(p);
  }
  return out;
}

function policyForDomain(doc: unknown, domain: string): Record<string, unknown> | undefined {
  return collectConnectionPolicies(doc).find((p) => {
    const sni = (p.match as { sni?: string[] } | undefined)?.sni;
    return Array.isArray(sni) && sni.includes(domain);
  });
}

/** A fail-closed policy either drops the connection or requires (and verifies) a client cert. */
function isFailClosed(policy: Record<string, unknown> | undefined): boolean {
  if (!policy) return false;
  if (policy.drop === true) return true;
  const ca = policy.client_authentication as { mode?: string } | undefined;
  return Boolean(ca) && ca!.mode !== 'request';
}

beforeEach(async () => {
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    provider: 'credentials',
    subject: 'admin',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

describe('mTLS fail-closed when trust resolves to zero active certs', () => {
  it('emits a deny-all/drop policy (not a plain no-auth policy) for a role with no active certs', async () => {
    const domain = 'role-empty.example.com';
    await createProxyHost(
      {
        name: 'role-empty',
        domains: [domain],
        upstreams: ['10.0.0.5:8080'],
        mtls: { enabled: true, trusted_role_ids: [EMPTY_ROLE_ID] },
      },
      1,
    );

    const doc = await buildCaddyDocument();
    const policy = policyForDomain(doc, domain);

    // The domain MUST have a connection policy and it MUST be fail-closed.
    expect(policy, 'domain should still have a TLS connection policy').toBeDefined();
    expect(isFailClosed(policy)).toBe(true);
    // Explicitly: it must not be a bare policy that lets every client through.
    expect(policy!.drop === true || policy!.client_authentication !== undefined).toBe(true);
  });

  it('fails closed even with protected_paths (does not fall back to optional "request" mode)', async () => {
    const domain = 'role-empty-protected.example.com';
    await createProxyHost(
      {
        name: 'role-empty-protected',
        domains: [domain],
        upstreams: ['10.0.0.5:8080'],
        mtls: { enabled: true, trusted_role_ids: [EMPTY_ROLE_ID], protected_paths: ['/admin/*'] },
      },
      1,
    );

    const doc = await buildCaddyDocument();
    const policy = policyForDomain(doc, domain);

    expect(policy).toBeDefined();
    // Must NOT be "request" (optional) mode, which would accept any presented cert.
    const ca = policy!.client_authentication as { mode?: string } | undefined;
    expect(ca?.mode).not.toBe('request');
    expect(isFailClosed(policy)).toBe(true);
  });

  it('rejects enabling mTLS with no trusted certs, roles, or CAs (model guard)', async () => {
    const failure = createProxyHost(
      {
        name: 'mtls-no-trust',
        domains: ['no-trust.example.com'],
        upstreams: ['10.0.0.5:8080'],
        mtls: { enabled: true },
      },
      1,
    );
    await expect(failure).rejects.toBeInstanceOf(DomainError);
    await expect(failure).rejects.toMatchObject({
      code: 'mtlsNoTrustMaterial',
      status: 400,
      message: expect.stringMatching(/no trusted client certificates, roles, or CA/i),
    });
  });

  it('does not emit a drop policy for a plain (non-mTLS) host', async () => {
    const domain = 'plain.example.com';
    await createProxyHost({ name: 'plain', domains: [domain], upstreams: ['10.0.0.5:8080'] }, 1);

    const doc = await buildCaddyDocument();
    const policy = policyForDomain(doc, domain);
    // A plain host may or may not have an explicit policy, but it must never be
    // dropped or carry a client_authentication requirement.
    if (policy) {
      expect(policy.drop).not.toBe(true);
      expect(policy.client_authentication).toBeUndefined();
    }
  });

  // M4: revoking the host's only directly-trusted cert must NOT broaden trust to
  // other active certs of the same CA that were never assigned to the host.
  it('does not fall back to whole-CA trust when the directly-trusted cert is revoked', async () => {
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 86_400_000).toISOString();
    await ctx.db.delete(schema.issuedClientCertificates).catch(() => {});
    await ctx.db.delete(schema.caCertificates).catch(() => {});
    await ctx.db.insert(schema.caCertificates).values({
      id: 1,
      name: 'CA X',
      certificatePem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
      privateKeyPem: null,
      createdAt: now,
      updatedAt: now,
    });
    // Cert A: assigned to the host, then REVOKED.
    await ctx.db.insert(schema.issuedClientCertificates).values({
      id: 1,
      caCertificateId: 1,
      commonName: 'alice',
      serialNumber: '01',
      fingerprintSha256: 'aa',
      certificatePem: '-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----',
      validFrom: now,
      validTo: later,
      revokedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    // Cert B: a sibling cert of the SAME CA, still active, never assigned here.
    await ctx.db.insert(schema.issuedClientCertificates).values({
      id: 2,
      caCertificateId: 1,
      commonName: 'bob',
      serialNumber: '02',
      fingerprintSha256: 'bb',
      certificatePem: '-----BEGIN CERTIFICATE-----\nB\n-----END CERTIFICATE-----',
      validFrom: now,
      validTo: later,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const domain = 'm4.example.com';
    await createProxyHost(
      {
        name: 'm4-host',
        domains: [domain],
        upstreams: ['10.0.0.5:8080'],
        mtls: { enabled: true, trusted_client_cert_ids: [1] },
      },
      1,
    );

    const doc = await buildCaddyDocument();
    const policy = policyForDomain(doc, domain);

    expect(policy, 'domain must still have a policy').toBeDefined();
    // Must fail closed (drop) - NOT trust sibling cert B via a whole-CA fallback.
    expect(policy!.drop).toBe(true);
    expect(JSON.stringify(policy)).not.toContain('CERTIFICATE'); // no trusted leaf/CA certs leaked in
  });
});

// SECURITY-AUDIT H6: a legacy whole-CA host with protected/excluded paths got "request" mode with no
// trusted CAs, and its HTTP gate was `fingerprint != ''` - so any self-signed cert got in. Expired
// certs were never rejected on any path-scoped host either.
describe('mTLS on path-scoped legacy CA hosts', () => {
  const DAY = 86_400_000;

  async function seedCa(
    caId: number,
    certs: { id: number; fp: string; pem: string; expired?: boolean; revoked?: boolean }[],
  ) {
    const now = new Date().toISOString();
    await ctx.db.insert(schema.caCertificates).values({
      id: caId,
      name: `CA ${caId}`,
      certificatePem: `-----BEGIN CERTIFICATE-----\nCA${caId}\n-----END CERTIFICATE-----`,
      privateKeyPem: null,
      createdAt: now,
      updatedAt: now,
    });
    for (const cert of certs) {
      await ctx.db.insert(schema.issuedClientCertificates).values({
        id: cert.id,
        caCertificateId: caId,
        commonName: cert.fp,
        serialNumber: String(cert.id),
        fingerprintSha256: cert.fp,
        certificatePem: `-----BEGIN CERTIFICATE-----\n${cert.pem}\n-----END CERTIFICATE-----`,
        validFrom: new Date(Date.now() - 10 * DAY).toISOString(),
        validTo: new Date(Date.now() + (cert.expired ? -DAY : DAY)).toISOString(),
        revokedAt: cert.revoked ? now : null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  /** Every client-certificate CEL expression on a route matching this host. */
  function expressionsForHost(doc: unknown, domain: string): string[] {
    const out: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!node || typeof node !== 'object') return;
      const match = (node as { match?: unknown }).match;
      if (Array.isArray(match)) {
        const matchers = match as { host?: string[]; expression?: unknown }[];
        if (matchers.some((m) => m.host?.includes(domain))) {
          for (const m of matchers) {
            if (typeof m.expression === 'string' && m.expression.includes('tls.client')) {
              out.push(m.expression);
            }
          }
        }
      }
      Object.values(node).forEach(walk);
    };
    walk(doc);
    return out;
  }

  beforeEach(async () => {
    await ctx.db.delete(schema.issuedClientCertificates).catch(() => {});
    await ctx.db.delete(schema.caCertificates).catch(() => {});
  });

  it('verifies presented certs against the CA and pins the gate to active, unexpired certs', async () => {
    await seedCa(1, [
      { id: 11, fp: 'aa', pem: 'ACTIVE' },
      { id: 12, fp: 'bb', pem: 'REVOKED', revoked: true },
      { id: 13, fp: 'cc', pem: 'EXPIRED', expired: true },
    ]);
    const domain = 'legacy-protected.example.com';
    await createProxyHost(
      {
        name: 'legacy-protected',
        domains: [domain],
        upstreams: ['10.0.0.5:8080'],
        mtls: { enabled: true, ca_certificate_ids: [1], protected_paths: ['/admin/*'] },
      },
      1,
    );

    const doc = await buildCaddyDocument();
    const auth = policyForDomain(doc, domain)?.client_authentication as Record<string, unknown>;
    expect(auth).toEqual({ mode: 'verify_if_given', trusted_ca_certs: ['CA1'] });

    const expressions = expressionsForHost(doc, domain);
    expect(expressions).toContain("{http.request.tls.client.fingerprint} in ['aa']");
    expect(expressions).not.toContain("{http.request.tls.client.fingerprint} != ''");
  });

  it("denies every cert on gated paths once all of a managed CA's certs have expired", async () => {
    await seedCa(1, [{ id: 11, fp: 'aa', pem: 'EXPIRED', expired: true }]);
    const domain = 'legacy-expired.example.com';
    await createProxyHost(
      {
        name: 'legacy-expired',
        domains: [domain],
        upstreams: ['10.0.0.5:8080'],
        mtls: { enabled: true, ca_certificate_ids: [1], excluded_paths: ['/public/*'] },
      },
      1,
    );

    const doc = await buildCaddyDocument();
    const expressions = expressionsForHost(doc, domain);
    expect(expressions).toEqual(['{http.request.tls.client.fingerprint} in []']);
  });

  it('trusts any verified cert of an unmanaged CA, with the CA required at the TLS layer', async () => {
    await seedCa(2, []);
    const domain = 'legacy-unmanaged.example.com';
    await createProxyHost(
      {
        name: 'legacy-unmanaged',
        domains: [domain],
        upstreams: ['10.0.0.5:8080'],
        mtls: { enabled: true, ca_certificate_ids: [2], protected_paths: ['/admin/*'] },
      },
      1,
    );

    const doc = await buildCaddyDocument();
    const auth = policyForDomain(doc, domain)?.client_authentication as Record<string, unknown>;
    expect(auth).toEqual({ mode: 'verify_if_given', trusted_ca_certs: ['CA2'] });
    expect(expressionsForHost(doc, domain)).toContain(
      "{http.request.tls.client.fingerprint} != ''",
    );
  });

  it('keeps separate policies for path-scoped hosts trusting different CAs', async () => {
    await seedCa(1, []);
    await seedCa(2, []);
    for (const [ca, domain] of [
      [1, 'scoped-a.example.com'],
      [2, 'scoped-b.example.com'],
    ] as const) {
      await createProxyHost(
        {
          name: domain,
          domains: [domain],
          upstreams: ['10.0.0.5:8080'],
          mtls: { enabled: true, ca_certificate_ids: [ca], protected_paths: ['/admin/*'] },
        },
        1,
      );
    }

    const doc = await buildCaddyDocument();
    const a = policyForDomain(doc, 'scoped-a.example.com');
    const b = policyForDomain(doc, 'scoped-b.example.com');
    expect(a).not.toBe(b);
    expect((a!.client_authentication as Record<string, unknown>).trusted_ca_certs).toEqual(['CA1']);
    expect((b!.client_authentication as Record<string, unknown>).trusted_ca_certs).toEqual(['CA2']);
  });

  it('drops a host whose only directly-trusted cert has expired', async () => {
    await seedCa(1, [
      { id: 11, fp: 'aa', pem: 'EXPIRED', expired: true },
      { id: 12, fp: 'bb', pem: 'SIBLING' },
    ]);
    const domain = 'expired-direct.example.com';
    await createProxyHost(
      {
        name: 'expired-direct',
        domains: [domain],
        upstreams: ['10.0.0.5:8080'],
        mtls: { enabled: true, trusted_client_cert_ids: [11], protected_paths: ['/admin/*'] },
      },
      1,
    );

    const policy = policyForDomain(await buildCaddyDocument(), domain);
    expect(policy?.drop).toBe(true);
  });

  it('leaves expired certs out of the full-site leaf pins', async () => {
    await seedCa(1, [
      { id: 11, fp: 'aa', pem: 'ACTIVE' },
      { id: 12, fp: 'cc', pem: 'EXPIRED', expired: true },
    ]);
    const domain = 'legacy-full.example.com';
    await createProxyHost(
      {
        name: 'legacy-full',
        domains: [domain],
        upstreams: ['10.0.0.5:8080'],
        mtls: { enabled: true, ca_certificate_ids: [1] },
      },
      1,
    );

    const auth = policyForDomain(await buildCaddyDocument(), domain)
      ?.client_authentication as Record<string, unknown>;
    expect(auth.mode).toBe('require_and_verify');
    expect(auth.trusted_leaf_certs).toEqual(['ACTIVE']);
  });
});
