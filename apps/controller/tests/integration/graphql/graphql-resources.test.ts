/**
 * The GraphQL resources graphql-api.test.ts leaves out: every one answers what its model stores,
 * projects away secret columns, and refuses a non-admin. Writes go through GraphQL and are read
 * back from the database, so a resolver that reports success without writing fails here.
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
import { createApiToken, listApiTokens } from '../../../src/lib/models/api-tokens';
import { createOAuthProvider } from '../../../src/lib/models/oauth-providers';
import { DNS_PROVIDERS } from '../../../src/lib/dns/providers';
import * as db from '../../../src/lib/db/schema';
import { type FakeCaddy, installFakeCaddy } from '../../helpers/caddy-admin';

const NOW = '2026-03-01T00:00:00.000Z';

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

async function seedUser(id: number, role = 'user', email = `user-${id}@example.com`) {
  await ctx.db.insert(db.users).values({
    id,
    email,
    name: `User ${id}`,
    role,
    passwordHash: 'hash-that-must-not-leak',
    subject: `subject-${id}`,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

let caddy: FakeCaddy;

beforeEach(async () => {
  caddy = installFakeCaddy();
  for (const table of [
    db.groupMembers,
    db.groups,
    db.l4ProxyHosts,
    db.proxyHosts,
    db.accessLists,
    db.issuedClientCertificates,
    db.caCertificates,
    db.certificates,
    db.mtlsRoles,
    db.oauthProviders,
    db.apiTokens,
    db.users,
  ]) {
    await ctx.db.delete(table);
  }
  await seedUser(1, 'admin', 'admin@example.com');
});

describe('the admin gate on the remaining resources', () => {
  const documents = [
    '{ proxyHost(id: 1) { id } }',
    '{ l4ProxyHosts { id } }',
    '{ l4ProxyHost(id: 1) { id } }',
    '{ certificate(id: 1) { id } }',
    '{ caCertificates { id } }',
    '{ clientCertificates { id } }',
    '{ mtlsRoles { id } }',
    '{ accessLists { id } }',
    '{ accessList(id: 1) { id } }',
    '{ user(id: 1) { id } }',
    '{ groups { id } }',
    '{ group(id: 1) { id } }',
    '{ agents { id } }',
    '{ oauthProviders { id } }',
    '{ dnsProviders { id } }',
    '{ caddyModules }',
    '{ settings(group: "general") }',
    'mutation { updateProxyHost(id: 1, input: {}) { id } }',
    'mutation { bulkProxyHosts(input: {}) }',
    'mutation { createL4ProxyHost(input: {}) { id } }',
    'mutation { updateL4ProxyHost(id: 1, input: {}) { id } }',
    'mutation { deleteL4ProxyHost(id: 1) }',
    'mutation { bulkL4ProxyHosts(input: {}) }',
    'mutation { createAccessList(input: {}) { id } }',
    'mutation { updateAccessList(id: 1, input: {}) { id } }',
    'mutation { deleteAccessList(id: 1) }',
    'mutation { createGroup(input: {}) { id } }',
    'mutation { updateGroup(id: 1, input: {}) { id } }',
    'mutation { deleteGroup(id: 1) }',
    'mutation { addGroupMember(groupId: 1, userId: 1) }',
    'mutation { removeGroupMember(groupId: 1, userId: 1) }',
    'mutation { updateUser(id: 1, input: {}) { id } }',
    'mutation { deleteUser(id: 2) }',
    'mutation { saveSettings(group: "general", input: {}) }',
  ];

  it('refuses every one to an operator, and writes nothing', async () => {
    for (const document of documents) {
      const result = await run(document, 'operator');
      expect(result.errors?.[0]?.message, document).toContain(
        "This account's role does not allow this request",
      );
    }
    expect(await ctx.db.select().from(db.groups)).toEqual([]);
    expect(await ctx.db.select().from(db.accessLists)).toEqual([]);
    expect(caddy.loads).toEqual([]);
  });
});

describe('proxy hosts', () => {
  async function createHost(name: string) {
    const data = await ok<{ createProxyHost: { id: number } }>(
      'mutation ($input: JSON!) { createProxyHost(input: $input) { id } }',
      { input: { name, domains: [`${name}.example.com`], upstreams: ['backend:8080'] } },
    );
    return data.createProxyHost.id;
  }

  it('reads one host by id, and null for none', async () => {
    const id = await createHost('app');
    const data = await ok<{ found: { name: string } | null; missing: unknown }>(
      'query ($id: Int!) { found: proxyHost(id: $id) { name } missing: proxyHost(id: 99999) { id } }',
      { id },
    );
    expect(data).toEqual({ found: { name: 'app' }, missing: null });
  });

  it('bulk-disables and answers how many changed', async () => {
    const first = await createHost('one');
    const second = await createHost('two');

    const data = await ok<{ bulkProxyHosts: number }>(
      'mutation ($input: JSON!) { bulkProxyHosts(input: $input) }',
      { input: { action: 'disable', ids: [first, second] } },
    );

    expect(data.bulkProxyHosts).toBe(2);
    const rows = await ctx.db.select({ enabled: db.proxyHosts.enabled }).from(db.proxyHosts);
    expect(rows.map((row) => row.enabled)).toEqual([false, false]);
  });

  it('refuses a bulk action it does not know, changing nothing', async () => {
    const id = await createHost('app');
    const result = await run(
      'mutation ($input: JSON!) { bulkProxyHosts(input: $input) }',
      'admin',
      { input: { action: 'explode', ids: [id] } },
    );
    expect(result.errors).toBeDefined();
    const [row] = await ctx.db.select().from(db.proxyHosts).where(eq(db.proxyHosts.id, id));
    expect(row.enabled).toBe(true);
  });
});

describe('L4 proxy hosts', () => {
  const input = {
    name: 'ssh',
    protocol: 'tcp',
    listenAddress: ':2222',
    upstreams: ['box:22'],
  };

  it('creates, reads, updates, bulk-disables and deletes', async () => {
    const created = await ok<{ createL4ProxyHost: { id: number; name: string } }>(
      'mutation ($input: JSON!) { createL4ProxyHost(input: $input) { id name } }',
      { input },
    );
    const id = created.createL4ProxyHost.id;

    const read = await ok<{ l4ProxyHosts: unknown[]; l4ProxyHost: Record<string, unknown> }>(
      'query ($id: Int!) { l4ProxyHosts { id } l4ProxyHost(id: $id) { protocol listenAddress upstreams config } }',
      { id },
    );
    expect(read.l4ProxyHosts).toHaveLength(1);
    expect(read.l4ProxyHost).toMatchObject({
      protocol: 'tcp',
      listenAddress: ':2222',
      upstreams: ['box:22'],
    });
    // Promoted fields are not repeated inside config.
    expect(read.l4ProxyHost.config).not.toHaveProperty('listenAddress');

    const updated = await ok<{ updateL4ProxyHost: { name: string } }>(
      'mutation ($id: Int!, $input: JSON!) { updateL4ProxyHost(id: $id, input: $input) { name } }',
      { id, input: { name: 'ssh-renamed' } },
    );
    expect(updated.updateL4ProxyHost.name).toBe('ssh-renamed');

    const bulk = await ok<{ bulkL4ProxyHosts: number }>(
      'mutation ($input: JSON!) { bulkL4ProxyHosts(input: $input) }',
      { input: { action: 'disable', ids: [id] } },
    );
    expect(bulk.bulkL4ProxyHosts).toBe(1);
    const [row] = await ctx.db.select().from(db.l4ProxyHosts).where(eq(db.l4ProxyHosts.id, id));
    expect(row).toMatchObject({ name: 'ssh-renamed', enabled: false });

    const deleted = await ok<{ deleteL4ProxyHost: boolean }>(
      'mutation ($id: Int!) { deleteL4ProxyHost(id: $id) }',
      { id },
    );
    expect(deleted.deleteL4ProxyHost).toBe(true);
    expect(await ctx.db.select().from(db.l4ProxyHosts)).toEqual([]);
  });
});

describe('certificates', () => {
  it('never exposes the PEM or the private key, even when selected by introspection', async () => {
    const [cert] = await ctx.db
      .insert(db.certificates)
      .values({
        name: 'wildcard',
        type: 'imported',
        domainNames: JSON.stringify(['*.example.com']),
        certificatePem: 'CERT',
        privateKeyPem: 'KEY',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning();

    const data = await ok<{ certificates: unknown[]; one: Record<string, unknown>; none: null }>(
      `query ($id: Int!) {
        certificates { id name domainNames source }
        one: certificate(id: $id) { id name type domainNames autoRenew source }
        none: certificate(id: 99999) { id }
      }`,
      { id: cert.id },
    );

    expect(data.certificates).toEqual([
      { id: cert.id, name: 'wildcard', domainNames: ['*.example.com'], source: 'upload' },
    ]);
    expect(data.one).toMatchObject({ name: 'wildcard', type: 'imported', autoRenew: true });
    expect(data.none).toBeNull();
    // The schema has no field for either.
    const field = await run('{ certificates { privateKeyPem } }', 'admin');
    expect(field.errors?.[0]?.message).toContain('privateKeyPem');
  });

  it('names a certificate’s own DNS provider, and nothing else stored beside it', async () => {
    const [cert] = await ctx.db
      .insert(db.certificates)
      .values({
        name: 'managed',
        type: 'managed',
        domainNames: JSON.stringify(['*.example.com']),
        providerOptions: JSON.stringify({ provider: 'cloudflare', api_token: 'leaked-token' }),
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning();
    const [plain] = await ctx.db
      .insert(db.certificates)
      .values({
        name: 'default',
        type: 'managed',
        domainNames: JSON.stringify(['example.org']),
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning();

    const data = await ok<{ certificates: { id: number; providerOptions: unknown }[] }>(
      '{ certificates { id providerOptions { provider } } }',
    );
    expect(data.certificates.sort((a, b) => a.id - b.id)).toEqual([
      { id: cert.id, providerOptions: { provider: 'cloudflare' } },
      { id: plain.id, providerOptions: null },
    ]);
    expect(JSON.stringify(data)).not.toContain('leaked-token');
  });

  it('lists CA certificates, the client certificates they issued and mTLS roles', async () => {
    const [ca] = await ctx.db
      .insert(db.caCertificates)
      .values({ name: 'Root', certificatePem: 'PEM', createdAt: NOW, updatedAt: NOW })
      .returning();
    await ctx.db.insert(db.issuedClientCertificates).values({
      caCertificateId: ca.id,
      commonName: 'alice',
      serialNumber: '01',
      fingerprintSha256: 'AA',
      certificatePem: 'PEM',
      validFrom: NOW,
      validTo: NOW,
      revokedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db
      .insert(db.mtlsRoles)
      .values({ name: 'finance', description: 'Payroll', createdAt: NOW, updatedAt: NOW });

    const data = await ok(
      '{ caCertificates { id name } clientCertificates { caCertificateId revokedAt } mtlsRoles { name description } }',
    );

    expect(data).toEqual({
      caCertificates: [{ id: ca.id, name: 'Root' }],
      clientCertificates: [{ caCertificateId: ca.id, revokedAt: NOW }],
      mtlsRoles: [{ name: 'finance', description: 'Payroll' }],
    });
  });
});

describe('access lists', () => {
  it('creates, reads, updates and deletes, never answering with a password hash', async () => {
    const created = await ok<{ createAccessList: { id: number } }>(
      'mutation ($input: JSON!) { createAccessList(input: $input) { id } }',
      { input: { name: 'office', users: [{ username: 'alice', password: 'Correct-Horse-1!' }] } },
    );
    const id = created.createAccessList.id;

    const read = await ok<{ accessLists: unknown[]; accessList: unknown }>(
      'query ($id: Int!) { accessLists { name } accessList(id: $id) { name entries { username } } }',
      { id },
    );
    expect(read).toEqual({
      accessLists: [{ name: 'office' }],
      accessList: { name: 'office', entries: [{ username: 'alice' }] },
    });
    expect(
      (await run('{ accessLists { entries { passwordHash } } }', 'admin')).errors,
    ).toBeDefined();

    const updated = await ok<{ updateAccessList: { name: string; description: string } }>(
      'mutation ($id: Int!, $input: JSON!) { updateAccessList(id: $id, input: $input) { name description } }',
      { id, input: { name: 'head office', description: 'HQ' } },
    );
    expect(updated.updateAccessList).toEqual({ name: 'head office', description: 'HQ' });

    await ok('mutation ($id: Int!) { deleteAccessList(id: $id) }', { id });
    expect(await ctx.db.select().from(db.accessLists)).toEqual([]);
  });
});

describe('groups', () => {
  it('creates a group, manages its members and deletes it', async () => {
    await seedUser(2);
    const created = await ok<{ createGroup: { id: number; source: string } }>(
      'mutation { createGroup(input: { name: "ops" }) { id source } }',
    );
    const groupId = created.createGroup.id;
    expect(created.createGroup.source).toBe('ui');

    await ok('mutation ($g: Int!) { addGroupMember(groupId: $g, userId: 2) }', { g: groupId });
    const withMember = await ok<{ group: unknown; groups: unknown[] }>(
      'query ($g: Int!) { group(id: $g) { name members { userId email } } groups { name } }',
      { g: groupId },
    );
    expect(withMember).toEqual({
      group: { name: 'ops', members: [{ userId: 2, email: 'user-2@example.com' }] },
      groups: [{ name: 'ops' }],
    });

    const renamed = await ok<{ updateGroup: { name: string; description: string } }>(
      'mutation ($g: Int!) { updateGroup(id: $g, input: { description: "on call" }) { name description } }',
      { g: groupId },
    );
    expect(renamed.updateGroup).toEqual({ name: 'ops', description: 'on call' });

    await ok('mutation ($g: Int!) { removeGroupMember(groupId: $g, userId: 2) }', { g: groupId });
    expect(await ctx.db.select().from(db.groupMembers)).toEqual([]);

    await ok('mutation ($g: Int!) { deleteGroup(id: $g) }', { g: groupId });
    expect(await ctx.db.select().from(db.groups)).toEqual([]);
    expect((await ok<{ group: unknown }>('{ group(id: 1) { id } }')).group).toBeNull();
  });

  it("surfaces the model's refusal for a group that does not exist", async () => {
    const result = await run('mutation { deleteGroup(id: 99999) }', 'admin');
    expect(result.errors?.[0]?.message).toBe('Group not found');
  });
});

describe('users', () => {
  it('lists and reads users without their hash or OAuth subject', async () => {
    await seedUser(2, 'viewer');
    const data = await ok<{ users: { id: number }[]; user: unknown; none: unknown }>(
      '{ users { id email role status } user(id: 2) { id email role } none: user(id: 99999) { id } }',
    );
    expect(data.users.map((user) => user.id)).toEqual([1, 2]);
    expect(data.user).toEqual({ id: 2, email: 'user-2@example.com', role: 'viewer' });
    expect(data.none).toBeNull();
    expect((await run('{ users { passwordHash } }', 'admin')).errors).toBeDefined();
    expect((await run('{ users { subject } }', 'admin')).errors).toBeDefined();
  });

  it('answers an update without a role with the user unchanged', async () => {
    await seedUser(2, 'viewer');
    const data = await ok<{ updateUser: { role: string } }>(
      'mutation { updateUser(id: 2, input: { role: null }) { role } }',
    );
    expect(data.updateUser.role).toBe('viewer');
  });

  it('refuses to update or delete a user that does not exist', async () => {
    for (const document of [
      'mutation { updateUser(id: 99999, input: { role: "user" }) { id } }',
      'mutation { deleteUser(id: 99999) }',
    ]) {
      const result = await run(document, 'admin');
      expect(result.errors?.[0]?.message, document).toBe('User not found');
    }
  });

  it('deletes another user', async () => {
    await seedUser(2);
    await ok('mutation { deleteUser(id: 2) }');
    const rows = await ctx.db.select({ id: db.users.id }).from(db.users);
    expect(rows).toEqual([{ id: 1 }]);
  });
});

describe('API tokens', () => {
  it("deletes the caller's own token", async () => {
    const { token } = await createApiToken('ci', 1);
    const data = await ok<{ deleteApiToken: boolean }>(
      'mutation ($id: Int!) { deleteApiToken(id: $id) }',
      { id: token.id },
    );
    expect(data.deleteApiToken).toBe(true);
    expect(await listApiTokens(1)).toEqual([]);
  });

  it("does not delete another user's token", async () => {
    await seedUser(2);
    const { token } = await createApiToken('theirs', 2);
    await run('mutation ($id: Int!) { deleteApiToken(id: $id) }', 'viewer', { id: token.id });
    expect(await listApiTokens(2)).toHaveLength(1);
  });
});

describe('providers and modules', () => {
  it('lists OIDC providers without their secrets', async () => {
    await createOAuthProvider({
      name: 'Keycloak',
      clientId: 'cpm',
      clientSecret: 'client-secret-value',
      issuer: 'https://id.example.com/realms/cpm',
    });
    const data = await ok('{ oauthProviders { name enabled issuer } }');
    expect(data).toEqual({
      oauthProviders: [
        { name: 'Keycloak', enabled: true, issuer: 'https://id.example.com/realms/cpm' },
      ],
    });
    expect((await run('{ oauthProviders { clientSecret } }', 'admin')).errors).toBeDefined();
  });

  it('lists every DNS provider the image ships', async () => {
    const data = await ok<{ dnsProviders: { id: string; configured: boolean }[] }>(
      '{ dnsProviders { id name configured } }',
    );
    expect(data.dnsProviders.map((provider) => provider.id)).toEqual(
      DNS_PROVIDERS.map((provider) => provider.name),
    );
    expect(data.dnsProviders.every((provider) => provider.configured === false)).toBe(true);
  });

  it('answers the Caddy module availability', async () => {
    const data = await ok<{ caddyModules: { desired: unknown; applied: unknown } }>(
      '{ caddyModules }',
    );
    expect(data.caddyModules).toHaveProperty('desired');
    expect(data.caddyModules).toHaveProperty('applied');
  });
});

describe('applyCaddyConfig', () => {
  it('pushes a configuration to Caddy', async () => {
    const data = await ok<{ applyCaddyConfig: boolean }>('mutation { applyCaddyConfig }');
    expect(data.applyCaddyConfig).toBe(true);
    expect(caddy.loads.length).toBeGreaterThan(0);
  });
});
