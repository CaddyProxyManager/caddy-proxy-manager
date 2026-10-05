/**
 * Integration: host tags stored, searched and filtered on both host tables, the bulk "Add tag"
 * (all or nothing, one audit row per host, no apply), the GraphQL fields, and live upstream
 * health read through the Caddy admin seam per agent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { createTestDb, type TestDb } from '../../helpers/db';

let db: TestDb;

vi.mock('../../../src/lib/db', () => dbModuleMock(() => db));
const actualCaddy = await import('../../../src/lib/caddy');
const { buildCaddyDocument } = actualCaddy;
const applyCaddyConfig = vi.fn(async () => {});
vi.mock('../../../src/lib/caddy', () => ({ ...actualCaddy, buildCaddyDocument, applyCaddyConfig }));

import { graphql } from 'graphql';
import * as schema from '../../../src/lib/db/schema';
import { DomainError } from '../../../src/lib/errors/domain-error';
import {
  type CaddyAdminRequest,
  type CaddyAdminTransport,
  setCaddyAdminTransport,
} from '../../../src/lib/caddy/admin';
import { HOST_TAGS_MAX } from '../../../src/lib/proxy-hosts/tag-rules';

const proxyModel = await import('../../../src/lib/models/proxy-hosts');
const l4Model = await import('../../../src/lib/models/l4-proxy-hosts');
const bulk = await import('../../../src/lib/models/bulk-hosts');
const { getProxyHostUpstreamHealth } = await import('../../../src/lib/proxy-hosts/upstream-health');
const { schema: graphqlSchema } = await import('../../../src/lib/graphql/schema');
const { attach, resetRegistry } = await import('../../../src/lib/agent/registry');

let userId: number;
const now = () => new Date().toISOString();

beforeEach(async () => {
  db = await createTestDb();
  vi.clearAllMocks();
  const [user] = await db
    .insert(schema.users)
    .values({
      email: 'admin@test',
      name: 'Admin',
      role: 'admin',
      provider: 'credentials',
      subject: 'admin@test',
      status: 'active',
      createdAt: now(),
      updatedAt: now(),
    })
    .returning();
  userId = user.id;
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error);
  }
  return undefined;
}

function createHost(name: string, tags?: string[] | null, upstreams = ['10.0.0.5:8080']) {
  return proxyModel.createProxyHost(
    { name, domains: [`${name}.example.com`], upstreams, tags },
    userId,
  );
}

function createL4(name: string, port: number, tags?: string[]) {
  return l4Model.createL4ProxyHost(
    {
      name,
      protocol: 'tcp',
      listenAddress: `:${port}`,
      upstreams: ['10.0.0.9:5432'],
      tags,
    },
    userId,
  );
}

describe('proxy host tags', () => {
  it('stores them normalised, keeps them on an unrelated save, and clears them', async () => {
    const host = await createHost('app', [' Prod', 'web', 'prod']);
    expect(host.tags).toEqual(['prod', 'web']);

    const renamed = await proxyModel.updateProxyHost(host.id, { name: 'renamed' }, userId);
    expect(renamed.tags).toEqual(['prod', 'web']);

    const cleared = await proxyModel.updateProxyHost(host.id, { tags: [] }, userId);
    expect(cleared.tags).toEqual([]);
    const nulled = await proxyModel.updateProxyHost(host.id, { tags: ['x'] }, userId);
    expect((await proxyModel.updateProxyHost(nulled.id, { tags: null }, userId)).tags).toEqual([]);
  });

  it('refuses an invalid tag before anything is written', async () => {
    expect(await codeOf(createHost('bad', ['no spaces']))).toBe('hostTagInvalid');
    expect(await db.select().from(schema.proxyHosts)).toHaveLength(0);
  });

  it('is found by the list search and filtered exactly by the tag filter', async () => {
    const a = await createHost('alpha', ['team_web']);
    const b = await createHost('beta', ['teamxweb']);
    await createHost('gamma');

    const search = await proxyModel.listProxyHostsPaginated(50, 0, 'team');
    expect(search.map((h) => h.id).sort()).toEqual([a.id, b.id].sort());

    // `_` is a LIKE wildcard: unescaped, the filter would match teamxweb too.
    const filtered = await proxyModel.listProxyHostsPaginated(
      50,
      0,
      undefined,
      undefined,
      undefined,
      null,
      undefined,
      'Team_Web',
    );
    expect(filtered.map((h) => h.id)).toEqual([a.id]);
    expect(await proxyModel.countProxyHosts(undefined, null, undefined, 'team_web')).toBe(1);
    expect((await proxyModel.countProxyHostsByState(undefined, null, 'team_web')).total).toBe(1);
    // A tag that is a prefix of another is not a match.
    expect(await proxyModel.countProxyHosts(undefined, null, undefined, 'team')).toBe(0);
  });

  it('lists the tags in use on the hosts the viewer can see', async () => {
    const a = await createHost('alpha', ['prod', 'web']);
    await createHost('beta', ['prod', 'secret-team']);
    expect(await proxyModel.listProxyHostTags(null)).toEqual(['prod', 'secret-team', 'web']);
    expect(await proxyModel.listProxyHostTags([a.id])).toEqual(['prod', 'web']);
    expect(await proxyModel.listProxyHostTags([])).toEqual([]);
  });

  it('never reaches the Caddy config, so the build does not read the column', async () => {
    await createHost('quiet', ['canary-only-tag']);
    expect(JSON.stringify(await buildCaddyDocument())).not.toContain('canary-only-tag');
  });
});

describe('L4 host tags', () => {
  it('stores, keeps, filters and lists them', async () => {
    const db1 = await createL4('db', 15432, ['Database']);
    const cache = await createL4('cache', 16379, ['cache']);
    expect(db1.tags).toEqual(['database']);
    expect((await l4Model.updateL4ProxyHost(db1.id, { name: 'db1' }, userId)).tags).toEqual([
      'database',
    ]);
    const filtered = await l4Model.listL4ProxyHostsPaginated(
      50,
      0,
      undefined,
      undefined,
      undefined,
      null,
      undefined,
      'cache',
    );
    expect(filtered.map((h) => h.id)).toEqual([cache.id]);
    expect(await l4Model.countL4ProxyHosts('datab')).toBe(1);
    expect(await l4Model.listL4ProxyHostTags(null)).toEqual(['cache', 'database']);
    expect(await codeOf(l4Model.updateL4ProxyHost(cache.id, { tags: ['/bad'] }, userId))).toBe(
      'hostTagInvalid',
    );
  });
});

describe('bulk add tag', () => {
  it('tags every host, audits each, and does not reload Caddy', async () => {
    const a = await createHost('alpha', ['web']);
    const b = await createHost('beta');
    applyCaddyConfig.mockClear();
    await db.delete(schema.auditEvents);

    const request = bulk.parseProxyHostBulkRequest({
      action: 'addTag',
      ids: [a.id, b.id],
      tag: ' Prod ',
    });
    expect(request.tag).toBe('prod');
    expect((await bulk.bulkUpdateProxyHosts(request, userId)).count).toBe(2);

    expect((await proxyModel.getProxyHost(a.id))?.tags).toEqual(['prod', 'web']);
    expect((await proxyModel.getProxyHost(b.id))?.tags).toEqual(['prod']);
    expect(applyCaddyConfig).not.toHaveBeenCalled();
    const audits = await db.select().from(schema.auditEvents);
    expect(audits.map((row) => row.entityId).sort()).toEqual([a.id, b.id].sort());
    expect(audits.every((row) => row.entityType === 'proxy_host')).toBe(true);
  });

  it('refuses the whole batch when one host is already full', async () => {
    const full = await createHost(
      'full',
      Array.from({ length: HOST_TAGS_MAX }, (_, i) => `t${i}`),
    );
    const other = await createHost('other');
    const code = await codeOf(
      bulk.bulkUpdateProxyHosts({ action: 'addTag', ids: [other.id, full.id], tag: 'new' }, userId),
    );
    expect(code).toBe('hostTooManyTags');
    expect((await proxyModel.getProxyHost(other.id))?.tags).toEqual([]);
  });

  it('needs exactly one valid tag', async () => {
    expect(() => bulk.parseProxyHostBulkRequest({ action: 'addTag', ids: [1] })).toThrow();
    expect(() =>
      bulk.parseProxyHostBulkRequest({ action: 'addTag', ids: [1], tag: ' ' }),
    ).toThrow();
    expect(() => bulk.parseL4HostBulkRequest({ action: 'addTag', ids: [1], tag: '-x' })).toThrow();
  });

  it('tags L4 hosts the same way', async () => {
    const one = await createL4('one', 15001);
    const two = await createL4('two', 15002, ['db']);
    applyCaddyConfig.mockClear();
    const request = bulk.parseL4HostBulkRequest({
      action: 'addTag',
      ids: [one.id, two.id],
      tag: 'edge',
    });
    expect((await bulk.bulkUpdateL4ProxyHosts(request, userId)).count).toBe(2);
    expect((await l4Model.getL4ProxyHost(two.id))?.tags).toEqual(['db', 'edge']);
    expect(applyCaddyConfig).not.toHaveBeenCalled();
  });
});

describe('GraphQL', () => {
  const context = {
    viewer: async () => ({ userId, role: 'admin', authMethod: 'bearer' as const }),
    access: async () => ({}) as never,
    rawBody: async () => '',
    request: {} as never,
  };

  it('exposes tags as fields and takes them in the input', async () => {
    const created = await graphql({
      schema: graphqlSchema,
      source: 'mutation ($input: JSON!) { createProxyHost(input: $input) { tags config } }',
      contextValue: context,
      variableValues: {
        input: { name: 'gql', domains: ['gql.example.com'], upstreams: ['a:80'], tags: ['B', 'a'] },
      },
    });
    expect(created.errors).toBeUndefined();
    const host = (created.data as { createProxyHost: { tags: string[]; config: object } })
      .createProxyHost;
    expect(host.tags).toEqual(['a', 'b']);
    expect(host.config).not.toHaveProperty('tags');
  });
});

describe('live upstream health', () => {
  let previous: CaddyAdminTransport;
  let requests: CaddyAdminRequest[];

  function serve(byAgent: Record<string, unknown[] | 'hang' | 'error'>) {
    requests = [];
    previous = setCaddyAdminTransport(async (request) => {
      requests.push(request);
      const answer = byAgent[request.agentId ?? 'direct'];
      if (answer === 'error') throw new Error('agent went away');
      if (answer === 'hang') return await new Promise(() => {});
      return { status: 200, text: JSON.stringify(answer ?? []), headers: {} };
    });
  }

  afterEach(() => {
    setCaddyAdminTransport(previous);
    resetRegistry();
  });

  async function pairAgent(name: string, connected: boolean) {
    const agentId = name.padEnd(32, 'x');
    const [row] = await db
      .insert(schema.agents)
      .values({ name, agentId, secret: 'unused', createdAt: now(), updatedAt: now() })
      .returning();
    if (connected) {
      attach({
        agentId,
        agentRowId: row.id,
        name,
        controllerId: 'controller',
        controllerName: 'CPM',
        initialState: {} as Parameters<typeof attach>[0]['initialState'],
      });
    }
    return { row, agentId };
  }

  it('asks the Caddy run without an agent when none is paired', async () => {
    serve({ direct: [{ address: '10.0.0.5:8080', num_requests: 2, fails: 0 }] });
    const host = await createHost('solo', null, ['http://10.0.0.5:8080', '10.0.0.6:8080']);
    const health = await getProxyHostUpstreamHealth(host.id);
    expect(requests.map((r) => [r.method, r.path, r.agentId])).toEqual([
      ['GET', '/reverse_proxy/upstreams', undefined],
    ]);
    expect(health.healthChecks).toBe(false);
    expect(health.upstreams.map((u) => u.state)).toEqual(['unchecked', 'unreported']);
  });

  it('asks each pinned agent by name and reports an offline one as unknown', async () => {
    const fra = await pairAgent('fra', true);
    const ams = await pairAgent('ams', false);
    const lab = await pairAgent('lab', true);
    serve({
      [fra.agentId]: [{ address: '10.0.0.5:8080', num_requests: 1, fails: 2 }],
      [lab.agentId]: [{ address: '10.0.0.5:8080', num_requests: 9, fails: 0 }],
    });
    const host = await proxyModel.createProxyHost(
      {
        name: 'pinned',
        domains: ['pinned.example.com'],
        upstreams: ['10.0.0.5:8080'],
        agentIds: [fra.row.id, ams.row.id],
        loadBalancer: {
          enabled: true,
          passiveHealthCheck: { enabled: true, failDuration: '30s', maxFails: 2 },
        },
      },
      userId,
    );

    const health = await getProxyHostUpstreamHealth(host.id);
    // The unpinned agent is not asked, and the offline one is not dialled at all.
    expect(requests.map((r) => r.agentId)).toEqual([fra.agentId]);
    expect(health.agents).toEqual([
      { agentId: fra.row.id, name: 'fra', reachable: true },
      { agentId: ams.row.id, name: 'ams', reachable: false },
    ]);
    expect(health.upstreams[0]).toMatchObject({ state: 'failing', fails: 2, outOfRotation: true });
    expect(health.upstreams[0].agents.map((a) => a.state)).toEqual(['failing', 'unknown']);
  });

  it('reads an agent that errors as unknown, never as failing', async () => {
    const fra = await pairAgent('fra', true);
    serve({ [fra.agentId]: 'error' });
    const host = await createHost('broken');
    const health = await getProxyHostUpstreamHealth(host.id);
    expect(health.upstreams[0].state).toBe('unknown');
    expect(health.agents[0].reachable).toBe(false);
  });

  it('matches a name Caddy was handed as addresses', async () => {
    serve({ direct: [{ address: '192.0.2.10:80', num_requests: 1, fails: 0 }] });
    const host = await createHost('named', null, ['http://app.internal']);
    const health = await getProxyHostUpstreamHealth(host.id, {
      lookup: async (name) => (name === 'app.internal' ? ['192.0.2.10'] : []),
    });
    expect(health.upstreams[0]).toMatchObject({
      state: 'unchecked',
      dials: ['app.internal:80', '192.0.2.10:80'],
    });
  });

  it('refuses an unknown host, and GraphQL is admin-only', async () => {
    expect(await codeOf(getProxyHostUpstreamHealth(999))).toBe('proxyHostNotFound');
    const result = await graphql({
      schema: graphqlSchema,
      source: '{ proxyHostUpstreamHealth(id: 1) { hostId } }',
      contextValue: {
        viewer: async () => ({ userId, role: 'user', authMethod: 'bearer' as const }),
        access: async () => ({}) as never,
        rawBody: async () => '',
        request: {} as never,
      },
    });
    expect(result.errors?.[0]?.message).toMatch(/Administrator/);
  });

  it('answers the GraphQL query from the same model function', async () => {
    serve({ direct: [{ address: '10.0.0.5:8080', num_requests: 0, fails: 0 }] });
    const host = await createHost('gql-health');
    const result = await graphql({
      schema: graphqlSchema,
      source: `{ proxyHostUpstreamHealth(id: ${host.id}) {
        hostId healthChecks upstreams { upstream state fails outOfRotation agents { name state } }
      } }`,
      contextValue: {
        viewer: async () => ({ userId, role: 'admin', authMethod: 'bearer' as const }),
        access: async () => ({}) as never,
        rawBody: async () => '',
        request: {} as never,
      },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      proxyHostUpstreamHealth: {
        hostId: host.id,
        healthChecks: false,
        upstreams: [
          {
            upstream: '10.0.0.5:8080',
            state: 'unchecked',
            fails: 0,
            outOfRotation: false,
            agents: [{ name: null, state: 'unchecked' }],
          },
        ],
      },
    });
  });
});
