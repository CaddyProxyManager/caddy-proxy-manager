/**
 * Parity: a mutation and its `/api/v1/` route call the same model function, so writes go through
 * GraphQL and are read back through the model. The gate: management is admin-only, operators too,
 * and that one line per resolver is easy to forget, so it is asserted per operation.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { graphql } from 'graphql';
import { schema } from '../../../src/lib/graphql/schema';
import type { GraphQLContext } from '../../../src/lib/graphql/context';
import { listProxyHosts } from '../../../src/lib/models/proxy-hosts';
import { listApiTokens } from '../../../src/lib/models/api-tokens';
import { getUserById } from '../../../src/lib/models/user';
import { getSetting, saveCloudflareSettings } from '../../../src/lib/settings';
import * as dbSchema from '../../../src/lib/db/schema';

/** The viewer decided up front; token and session auth belong to api-auth's tests. */
function contextFor(
  role: string | null,
  authMethod: 'bearer' | 'session' = 'bearer',
): GraphQLContext {
  const viewer = async () => {
    if (!role) throw new Error('Unauthorized');
    return { userId: 1, role, authMethod };
  };
  return {
    viewer,
    access: async () => ({
      userId: 1,
      role: role ?? '',
      isAdmin: role === 'admin',
      isOperator: role === 'operator',
      grants: { proxyHosts: new Map(), l4ProxyHosts: new Map(), agents: new Map() },
    }),
    // Nothing here signs a request; the agent fields are covered by their own tests.
    rawBody: async () => '',
    request: {} as never,
  };
}

async function run(
  document: string,
  role: string | null,
  variableValues?: Record<string, unknown>,
  authMethod: 'bearer' | 'session' = 'bearer',
) {
  return await graphql({
    schema,
    source: document,
    contextValue: contextFor(role, authMethod),
    variableValues,
  });
}

beforeEach(async () => {
  await ctx.db.delete(dbSchema.proxyHosts);
  await ctx.db.delete(dbSchema.users).catch(() => {});
  await ctx.db.insert(dbSchema.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

describe('the GraphQL schema', () => {
  it('exposes the resources the REST API covers', async () => {
    const result = await run('{ __schema { queryType { fields { name } } } }', 'admin');

    const names = (
      result.data as { __schema: { queryType: { fields: { name: string }[] } } }
    ).__schema.queryType.fields.map((f) => f.name);

    // Not an exhaustive list - a spot check that the big resources are reachable, so a schema that
    // silently lost a query fails here rather than in somebody's client.
    expect(names).toContain('proxyHosts');
    expect(names).toContain('l4ProxyHosts');
    expect(names).toContain('certificates');
    expect(names).toContain('users');
    expect(names).toContain('auditLog');
  });
});

describe('reading through GraphQL', () => {
  it('returns what the model returns', async () => {
    const created = await run(
      'mutation ($input: JSON!) { createProxyHost(input: $input) { id name domains } }',
      'admin',
      { input: { name: 'app', domains: ['app.example.com'], upstreams: ['backend:8080'] } },
    );
    expect(created.errors).toBeUndefined();

    const query = await run('{ proxyHosts { id name domains upstreams enabled } }', 'admin');
    const hosts = (query.data as { proxyHosts: { name: string; domains: string[] }[] }).proxyHosts;

    expect(hosts).toHaveLength(1);
    expect(hosts[0].name).toBe('app');
    expect(hosts[0].domains).toEqual(['app.example.com']);

    // The same row the REST route would have served.
    const viaModel = await listProxyHosts();
    expect(viaModel).toHaveLength(1);
    expect(viaModel[0].name).toBe(hosts[0].name);
  });

  it('says whether an agent is connected, which no column holds', async () => {
    const { attach, resetRegistry } = await import('../../../src/lib/agent/registry');
    const now = new Date().toISOString();
    const agentId = 'c'.repeat(32);
    const [row] = await ctx.db
      .insert(dbSchema.agents)
      .values({ name: 'edge', agentId, secret: 'unused', createdAt: now, updatedAt: now })
      .returning();
    try {
      const query = '{ agents { id name connected } }';
      const before = await run(query, 'admin');
      expect(before.errors).toBeUndefined();
      expect(before.data).toEqual({ agents: [{ id: row.id, name: 'edge', connected: false }] });

      resetRegistry();
      attach({
        agentId,
        agentRowId: row.id,
        name: 'edge',
        controllerId: 'controller',
        controllerName: 'CPM',
        initialState: {} as Parameters<typeof attach>[0]['initialState'],
      });
      const after = await run(query, 'admin');
      expect(after.errors).toBeUndefined();
      expect(after.data).toEqual({ agents: [{ id: row.id, name: 'edge', connected: true }] });
    } finally {
      resetRegistry();
      await ctx.db.delete(dbSchema.agents);
    }
  });

  it("answers an agent's last refused apply until a load succeeds", async () => {
    const { recordApplyFailure, recordApplySuccess } = await import(
      '../../../src/lib/caddy/apply-status'
    );
    const { CaddyApplyError } = await import('../../../src/lib/caddy/apply-error');
    const now = new Date().toISOString();
    const agentId = 'f'.repeat(32);
    await ctx.db
      .insert(dbSchema.agents)
      .values({ name: 'edge', agentId, secret: 'unused', createdAt: now, updatedAt: now });
    const query = '{ agents { name lastApplyFailure { at error } } }';
    try {
      await recordApplyFailure(
        { agentId, name: 'edge' },
        new CaddyApplyError('Caddy rejected configuration on edge', 'CADDY_REJECTED'),
        Date.parse('2026-03-01T00:00:00.000Z'),
      );
      const refused = await run(query, 'admin');
      expect(refused.errors).toBeUndefined();
      expect(refused.data).toEqual({
        agents: [
          {
            name: 'edge',
            lastApplyFailure: {
              at: '2026-03-01T00:00:00.000Z',
              error: 'Caddy rejected configuration on edge',
            },
          },
        ],
      });

      await recordApplySuccess({ agentId });
      const cleared = await run(query, 'admin');
      expect(cleared.data).toEqual({ agents: [{ name: 'edge', lastApplyFailure: null }] });
    } finally {
      await recordApplySuccess(null);
      await ctx.db.delete(dbSchema.agents);
    }
  });

  it('puts the configuration the models validate into config', async () => {
    await run('mutation ($input: JSON!) { createProxyHost(input: $input) { id } }', 'admin', {
      input: { name: 'app', domains: ['app.example.com'], upstreams: ['backend:8080'] },
    });

    const result = await run('{ proxyHosts { config } }', 'admin');
    const config = (result.data as { proxyHosts: { config: Record<string, unknown> }[] })
      .proxyHosts[0].config;

    // Everything the type does not name is still reachable, rather than being dropped on the way
    // out - which is the whole justification for the JSON scalar.
    expect(config).toHaveProperty('locationRules');
    expect(config).toHaveProperty('geoblockMode');
    // ...and nothing promoted to a real field is duplicated inside it.
    expect(config).not.toHaveProperty('name');
    expect(config).not.toHaveProperty('domains');
  });
});

describe('writing through GraphQL', () => {
  it('validates with the model, not the resolver', async () => {
    // A host with no domains is refused by createProxyHost. The resolver adds no validation of its
    // own, so the message a GraphQL client sees is the model's.
    const result = await run(
      'mutation ($input: JSON!) { createProxyHost(input: $input) { id } }',
      'admin',
      { input: { name: 'broken', domains: [], upstreams: ['backend:8080'] } },
    );

    expect(result.errors).toBeDefined();
    expect(await listProxyHosts()).toHaveLength(0);
  });

  it('round-trips an update', async () => {
    const created = await run(
      'mutation ($input: JSON!) { createProxyHost(input: $input) { id } }',
      'admin',
      { input: { name: 'app', domains: ['app.example.com'], upstreams: ['backend:8080'] } },
    );
    const id = (created.data as { createProxyHost: { id: number } }).createProxyHost.id;

    const updated = await run(
      'mutation ($id: Int!, $input: JSON!) { updateProxyHost(id: $id, input: $input) { name } }',
      'admin',
      { id, input: { name: 'renamed', domains: ['app.example.com'], upstreams: ['backend:8080'] } },
    );

    expect(updated.errors).toBeUndefined();
    expect((await listProxyHosts())[0].name).toBe('renamed');
  });

  it('deletes', async () => {
    const created = await run(
      'mutation ($input: JSON!) { createProxyHost(input: $input) { id } }',
      'admin',
      { input: { name: 'app', domains: ['app.example.com'], upstreams: ['backend:8080'] } },
    );
    const id = (created.data as { createProxyHost: { id: number } }).createProxyHost.id;

    const result = await run('mutation ($id: Int!) { deleteProxyHost(id: $id) }', 'admin', { id });

    expect(result.errors).toBeUndefined();
    expect(await listProxyHosts()).toHaveLength(0);
  });
});

describe('the admin gate', () => {
  const cases: [string, string][] = [
    ['proxyHosts', '{ proxyHosts { id } }'],
    ['users', '{ users { id } }'],
    ['auditLog', '{ auditLog { total } }'],
    ['certificates', '{ certificates { id } }'],
    ['createProxyHost', 'mutation { createProxyHost(input: {}) { id } }'],
    ['deleteProxyHost', 'mutation { deleteProxyHost(id: 1) }'],
    ['applyCaddyConfig', 'mutation { applyCaddyConfig }'],
  ];

  for (const [name, document] of cases) {
    it(`refuses ${name} to a non-admin`, async () => {
      // An operator too: grants delegate the dashboard, not the API. That is the rule the REST
      // layer documents, and the one most likely to be forgotten on a newly added resolver.
      for (const role of ['user', 'viewer', 'operator']) {
        const result = await run(document, role);
        expect(result.errors?.[0]?.message, `${name} as ${role}`).toContain(
          'Administrator privileges required',
        );
      }
    });
  }

  it('lets any signed-in role manage its own API tokens', async () => {
    // Deliberately not admin-gated, matching /api/v1/tokens: a viewer's token is how a viewer uses
    // the API at all.
    const result = await run('{ apiTokens { id name } }', 'viewer');
    expect(result.errors).toBeUndefined();
  });

  it('refuses everything to an unauthenticated caller', async () => {
    const result = await run('{ proxyHosts { id } }', null);
    expect(result.errors?.[0]?.message).toContain('Unauthorized');
  });
});

/**
 * Rules `/api/v1/` already enforced and GraphQL did not. Each is asserted against what was stored,
 * not only the error, since a resolver that reports a refusal after writing would pass otherwise.
 */
describe('the rules REST already enforced', () => {
  async function seedUser(id: number, role: string) {
    await ctx.db.insert(dbSchema.users).values({
      id,
      email: `user-${id}@example.com`,
      name: `User ${id}`,
      role,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  it('refuses to mint an API token over a Bearer token', async () => {
    const result = await run(
      'mutation { createApiToken(input: { name: "ci" }) { secret } }',
      'admin',
    );

    expect(result.errors?.[0]?.message).toContain('authenticated session');
    expect(await listApiTokens(1)).toHaveLength(0);
  });

  it('mints an API token from a session', async () => {
    const result = await run(
      'mutation { createApiToken(input: { name: "ci" }) { secret } }',
      'viewer',
      undefined,
      'session',
    );

    expect(result.errors).toBeUndefined();
    expect(await listApiTokens(1)).toHaveLength(1);
  });

  it('refuses a role outside the allowlist', async () => {
    await seedUser(2, 'user');

    const result = await run(
      'mutation { updateUser(id: 2, input: { role: "superadmin" }) { role } }',
      'admin',
    );

    expect(result.errors?.[0]?.message).toBe('That is not a valid role');
    expect((await getUserById(2))?.role).toBe('user');
  });

  it('assigns a role inside it', async () => {
    await seedUser(2, 'user');

    const result = await run(
      'mutation { updateUser(id: 2, input: { role: "operator" }) { role } }',
      'admin',
    );

    expect(result.errors).toBeUndefined();
    expect((await getUserById(2))?.role).toBe('operator');
  });

  it('refuses an administrator changing their own role', async () => {
    const result = await run(
      'mutation { updateUser(id: 1, input: { role: "viewer" }) { role } }',
      'admin',
    );

    expect(result.errors?.[0]?.message).toBe('Cannot change your own role');
    expect((await getUserById(1))?.role).toBe('admin');
  });

  it('refuses an administrator deleting their own account', async () => {
    const result = await run('mutation { deleteUser(id: 1) }', 'admin');

    expect(result.errors?.[0]?.message).toBe('Cannot delete your own account');
    expect(await getUserById(1)).not.toBeNull();
  });

  it('pages the audit log at 200 events at most', async () => {
    await ctx.db.delete(dbSchema.auditEvents);
    const createdAt = new Date().toISOString();
    await ctx.db.insert(dbSchema.auditEvents).values(
      Array.from({ length: 205 }, (_, i) => ({
        action: 'test',
        entityType: 'test',
        summary: `event ${i}`,
        createdAt,
      })),
    );

    const result = await run('{ auditLog(limit: 100000) { total items { id } } }', 'admin');

    expect(result.errors).toBeUndefined();
    const page = (result.data as { auditLog: { total: number; items: unknown[] } }).auditLog;
    expect(page.total).toBe(205);
    expect(page.items).toHaveLength(200);
  });

  it('reads a settings group, never a raw storage key', async () => {
    await ctx.db
      .insert(dbSchema.settings)
      .values({
        key: 'setup:migrated_from',
        value: '/data/legacy.db',
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoNothing();

    const result = await run('{ settings(group: "setup:migrated_from") }', 'admin');

    expect(result.errors?.[0]?.message).toBe('Unknown settings group');
    expect(JSON.stringify(result.data)).not.toContain('legacy.db');
  });

  it('redacts a credential group the way REST does', async () => {
    await saveCloudflareSettings({ apiToken: 'cf-secret-token' });

    const result = await run('{ settings(group: "cloudflare") }', 'admin');

    expect(result.errors).toBeUndefined();
    expect((result.data as { settings: unknown }).settings).toEqual({ hasApiToken: true });
  });

  it('saves a group under its storage key, through its own saver', async () => {
    const result = await run(
      'mutation ($input: JSON!) { saveSettings(group: "trusted-proxies", input: $input) }',
      'admin',
      { input: { ranges: ['private_ranges'], default_geoblock: true } },
    );

    expect(result.errors).toBeUndefined();
    expect(await getSetting('trusted_proxies')).toMatchObject({ ranges: ['private_ranges'] });
    // The group name used to be the key, leaving a row nothing reads.
    expect(await getSetting('trusted-proxies')).toBeNull();
  });

  it('refuses a group REST does not expose', async () => {
    const result = await run('mutation { saveSettings(group: "dashboard", input: {}) }', 'admin');

    expect(result.errors?.[0]?.message).toBe('Unknown settings group');
  });
});
