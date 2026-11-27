/** A host answering for an IP address: its own issuers, no DNS-01, and a policy for no-SNI clients. */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

// A Bun mock factory must be synchronous, so the database is created out here.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { createProxyHost } from '../../../src/lib/models/proxy-hosts';
import { buildCaddyDocument, buildTlsAutomation } from '../../../src/lib/caddy';
import { isPublicIp, noSniPolicyForIpHosts } from '../../../src/lib/caddy/ip-subjects';
import * as schema from '../../../src/lib/db/schema';

const NO_DNS = { enabled: false, resolvers: [] };
const CLOUDFLARE = {
  default: 'cloudflare',
  providers: { cloudflare: { api_token: 'token' } },
};

type Policy = { subjects?: string[]; issuers?: Record<string, unknown>[] };

async function automationPolicies(domains: string[], extra: Record<string, unknown> = {}) {
  const result = await buildTlsAutomation(new Map(), new Set(domains), {
    acmeEmail: 'admin@example.com',
    dnsSettings: NO_DNS,
    ...extra,
  });
  return ((result.tlsApp as any)?.automation?.policies ?? []) as Policy[];
}

function policyFor(policies: Policy[], subject: string) {
  return policies.find((policy) => policy.subjects?.includes(subject));
}

describe('isPublicIp', () => {
  it('tells public addresses from private and reserved ones', () => {
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('2606:4700::1111')).toBe(true);
    for (const address of [
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.10',
      '127.0.0.1',
      '100.64.0.1',
      '203.0.113.10',
      '::1',
      'fd00::1',
      'fe80::1',
      '2001:db8::1',
      '::ffff:192.168.1.1',
    ]) {
      expect(isPublicIp(address)).toBe(false);
    }
    expect(isPublicIp('::ffff:8.8.8.8')).toBe(true);
  });
});

describe('buildTlsAutomation - IP subjects', () => {
  it('sends a private address to the local CA only', async () => {
    const policies = await automationPolicies(['192.168.1.10', 'app.example.com']);
    expect(policyFor(policies, '192.168.1.10')).toEqual({
      subjects: ['192.168.1.10'],
      issuers: [{ module: 'internal' }],
    });
    expect(policyFor(policies, 'app.example.com')?.subjects).toEqual(['app.example.com']);
  });

  it("tries Let's Encrypt's short-lived profile for a public address, then the local CA", async () => {
    const policy = policyFor(await automationPolicies(['8.8.4.4']), '8.8.4.4');
    expect(policy?.issuers).toEqual([
      { module: 'acme', email: 'admin@example.com', profile: 'shortlived' },
      { module: 'internal' },
    ]);
  });

  it('leaves the profile out for a custom ACME directory', async () => {
    const policy = policyFor(
      await automationPolicies(['8.8.4.4'], {
        acmeSettings: { caUrl: 'https://ca.internal.example.com/acme/directory' },
      }),
      '8.8.4.4',
    );
    expect(policy?.issuers?.[0]).toEqual({
      module: 'acme',
      email: 'admin@example.com',
      ca: 'https://ca.internal.example.com/acme/directory',
    });
  });

  it('never gives an address a DNS challenge', async () => {
    const policies = await automationPolicies(['8.8.4.4', 'app.example.com'], {
      dnsProviderSettings: CLOUDFLARE,
    });
    expect(policyFor(policies, '8.8.4.4')?.issuers?.[0]).not.toHaveProperty('challenges');
    expect(policyFor(policies, 'app.example.com')?.issuers?.[0]).toHaveProperty('challenges');
  });
});

describe('noSniPolicyForIpHosts', () => {
  it('copies the first IP policy for clients that send no SNI', () => {
    expect(
      noSniPolicyForIpHosts([
        { match: { sni: ['app.example.com'] } },
        { match: { sni: ['2001:db8::10'] }, client_authentication: { mode: 'require_and_verify' } },
      ]),
    ).toEqual({
      match: { sni: [''] },
      default_sni: '2001:db8::10',
      client_authentication: { mode: 'require_and_verify' },
    });
  });

  it('adds nothing without an IP host', () => {
    expect(noSniPolicyForIpHosts([{ match: { sni: ['app.example.com'] } }])).toBeNull();
  });
});

describe('buildCaddyDocument - IP hosts', () => {
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

  it('routes by the address and answers TLS without SNI', async () => {
    await createProxyHost(
      { name: 'by-ip', domains: ['192.168.1.10'], upstreams: ['10.0.0.5:8080'] },
      1,
    );

    const doc = (await buildCaddyDocument()) as any;
    const server = doc.apps.http.servers.cpm;
    const hosts = server.routes.flatMap((route: any) =>
      (route.match ?? []).flatMap((match: any) => match.host ?? []),
    );
    expect(hosts).toContain('192.168.1.10');
    expect(server.tls_connection_policies).toContainEqual({ match: { sni: ['192.168.1.10'] } });
    expect(server.tls_connection_policies.at(-1)).toEqual({
      match: { sni: [''] },
      default_sni: '192.168.1.10',
    });
    expect(policyFor(doc.apps.tls.automation.policies, '192.168.1.10')?.issuers).toEqual([
      { module: 'internal' },
    ]);
  });
});
