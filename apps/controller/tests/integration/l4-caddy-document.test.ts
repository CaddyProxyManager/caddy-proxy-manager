/**
 * The layer4 app as buildCaddyDocument() emits it: what closes a connection, and in what order
 * relative to PROXY protocol, which decides whose address those guards see.
 */
import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

// Hoisted out of the factory: a Bun mock factory must be synchronous, or the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));
vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { setCaddyAdminTransport } from '../../src/lib/caddy-admin';
import { buildCaddyDocument } from '../../src/lib/caddy';
import { CADDY_MODULES } from '../../src/lib/caddy-modules';
import { saveCaddyBuildSettings } from '../../src/lib/settings';
import { startFakeAgent } from '../helpers/fake-agent';
import * as schema from '../../src/lib/db/schema';

type FakeAgent = Awaited<ReturnType<typeof startFakeAgent>>;
type Route = { match?: Record<string, unknown>[]; handle: Record<string, unknown>[] };

let agent: FakeAgent;

const GEO = {
  enabled: true,
  block_countries: ['CN'],
  block_continents: [],
  block_asns: [],
  block_cidrs: [],
  block_ips: [],
  allow_countries: [],
  allow_continents: [],
  allow_asns: [],
  allow_cidrs: [],
  allow_ips: [],
  trusted_proxies: [],
  fail_closed: false,
  response_status: 403,
  response_body: 'Forbidden',
  response_headers: {},
  redirect_url: '',
};

beforeEach(async () => {
  agent = await startFakeAgent();
  setCaddyAdminTransport(async () => ({ status: 200, text: '{}', headers: {} }));
  await ctx.db.delete(schema.l4ProxyHosts);
  await ctx.db.delete(schema.accessListIpRules);
  await ctx.db.delete(schema.accessListDnsCache);
  await ctx.db.delete(schema.accessLists);
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.settings);
  agent.state.appliedModules = CADDY_MODULES.map((m) => m.modulePath);
  await saveCaddyBuildSettings({
    modules: Object.fromEntries(CADDY_MODULES.map((m) => [m.id, true])),
    customModules: [],
  });
});

afterEach(async () => {
  await agent.stop();
});

async function insertL4Host(overrides: Partial<typeof schema.l4ProxyHosts.$inferInsert> = {}) {
  const now = new Date().toISOString();
  await ctx.db.insert(schema.l4ProxyHosts).values({
    name: 'db',
    protocol: 'tcp',
    listenAddress: ':5432',
    upstreams: JSON.stringify(['db:5432']),
    matcherType: 'none',
    matcherValue: null,
    tlsTermination: false,
    proxyProtocolVersion: null,
    proxyProtocolReceive: false,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

async function l4Routes(): Promise<Route[]> {
  const doc = (await buildCaddyDocument()) as {
    apps: { layer4?: { servers: Record<string, { routes: Route[] }> } };
  };
  const servers = Object.values(doc.apps.layer4?.servers ?? {});
  expect(servers).toHaveLength(1);
  return servers[0].routes;
}

describe('L4 geo blocking', () => {
  it('closes before the proxy route, on the host matcher, without PROXY protocol', async () => {
    await insertL4Host({
      matcherType: 'tls_sni',
      matcherValue: JSON.stringify(['db.example.com']),
      meta: JSON.stringify({ geoblock: GEO }),
    });
    const routes = await l4Routes();
    expect(routes).toHaveLength(2);
    expect(routes[0].handle).toEqual([{ handler: 'close' }]);
    expect(routes[0].match?.[0]).toMatchObject({
      blocker: expect.any(Object),
      tls: { sni: ['db.example.com'] },
    });
    expect(routes[1].match).toEqual([{ tls: { sni: ['db.example.com'] } }]);
    expect(routes[1].handle.map((h) => h.handler)).toEqual(['proxy']);
  });

  it('matches after proxy_protocol when PROXY protocol is received', async () => {
    // Ahead of proxy_protocol the blocker would see the load balancer's address, not the client's.
    await insertL4Host({ proxyProtocolReceive: true, meta: JSON.stringify({ geoblock: GEO }) });
    const routes = await l4Routes();
    expect(routes).toHaveLength(1);
    const [first, subroute] = routes[0].handle;
    expect(first).toEqual({ handler: 'proxy_protocol' });
    expect(subroute.handler).toBe('subroute');
    const inner = subroute.routes as Route[];
    expect(inner).toHaveLength(2);
    expect(Object.keys(inner[0].match?.[0] ?? {})).toEqual(['blocker']);
    expect(inner[0].handle).toEqual([{ handler: 'close' }]);
    expect(inner[1].match).toBeUndefined();
    expect(inner[1].handle.map((h) => h.handler)).toEqual(['proxy']);
  });

  it('keeps the host matcher outside, and TLS termination after the guards', async () => {
    await insertL4Host({
      matcherType: 'proxy_protocol',
      proxyProtocolReceive: true,
      tlsTermination: true,
      meta: JSON.stringify({ geoblock: GEO }),
    });
    const routes = await l4Routes();
    expect(routes[0].match).toEqual([{ proxy_protocol: {} }]);
    const inner = routes[0].handle[1].routes as Route[];
    expect(inner[1].handle.map((h) => h.handler)).toEqual(['tls', 'proxy']);
  });

  it('leaves a host with nothing to guard as a flat chain', async () => {
    await insertL4Host({ proxyProtocolReceive: true, tlsTermination: true });
    const routes = await l4Routes();
    expect(routes).toHaveLength(1);
    expect(routes[0].handle.map((h) => h.handler)).toEqual(['proxy_protocol', 'tls', 'proxy']);
  });
});

async function insertList(
  rules: { action: 'allow' | 'deny'; cidr?: string; hostname?: string }[],
  ipDefault: 'allow' | 'deny' = 'deny',
): Promise<number> {
  const now = new Date().toISOString();
  const [list] = await ctx.db
    .insert(schema.accessLists)
    .values({ name: `list-${Math.random()}`, ipDefault, createdAt: now, updatedAt: now })
    .returning();
  if (rules.length > 0) {
    await ctx.db.insert(schema.accessListIpRules).values(
      rules.map((rule, sortOrder) => ({
        accessListId: list.id,
        ...rule,
        sortOrder,
        createdAt: now,
        updatedAt: now,
      })),
    );
  }
  return list.id;
}

const CLOSE = [{ handler: 'close' }];

describe('L4 access lists', () => {
  it('closes what the IP rules deny, on remote_ip and the host matcher, before geo', async () => {
    const listId = await insertList([
      { action: 'allow', cidr: '10.0.0.0/8' },
      { action: 'deny', cidr: '10.9.0.0/16' },
    ]);
    await insertL4Host({
      accessListId: listId,
      matcherType: 'tls_sni',
      matcherValue: JSON.stringify(['db.example.com']),
      meta: JSON.stringify({ geoblock: GEO }),
    });
    const routes = await l4Routes();
    const sni = { tls: { sni: ['db.example.com'] } };
    expect(routes).toHaveLength(3);
    expect(routes[0]).toEqual({
      match: [
        {
          remote_ip: { ranges: ['10.9.0.0/16'] },
          not: [{ remote_ip: { ranges: ['10.0.0.0/8'] } }],
          ...sni,
        },
        { not: [{ remote_ip: { ranges: ['10.0.0.0/8', '10.9.0.0/16'] } }], ...sni },
      ],
      handle: CLOSE,
    });
    expect(Object.keys(routes[1].match?.[0] ?? {})).toContain('blocker');
    expect(routes[2].handle.map((h) => h.handler)).toEqual(['proxy']);
  });

  it('checks the client behind PROXY protocol, ahead of geo, inside the subroute', async () => {
    const listId = await insertList([{ action: 'deny', cidr: '192.0.2.0/24' }], 'allow');
    await insertL4Host({
      accessListId: listId,
      proxyProtocolReceive: true,
      meta: JSON.stringify({ geoblock: GEO }),
    });
    const routes = await l4Routes();
    expect(routes).toHaveLength(1);
    expect(routes[0].handle[0]).toEqual({ handler: 'proxy_protocol' });
    const inner = routes[0].handle[1].routes as Route[];
    expect(inner[0]).toEqual({
      match: [{ remote_ip: { ranges: ['192.0.2.0/24'] } }],
      handle: CLOSE,
    });
    expect(Object.keys(inner[1].match?.[0] ?? {})).toEqual(['blocker']);
    expect(inner[2].handle.map((h) => h.handler)).toEqual(['proxy']);
  });

  it('adds nothing when the rules deny nobody', async () => {
    const listId = await insertList([{ action: 'allow', cidr: '10.0.0.0/8' }], 'allow');
    await insertL4Host({ accessListId: listId });
    const routes = await l4Routes();
    expect(routes).toHaveLength(1);
    expect(routes[0].handle.map((h) => h.handler)).toEqual(['proxy']);
  });

  it('fails closed on a list with no IP rules, which admits nobody at layer 4', async () => {
    // The model refuses both; a list emptied or deleted mid-build is what this guards.
    const listId = await insertList([]);
    await insertL4Host({
      accessListId: listId,
      matcherType: 'tls_sni',
      matcherValue: JSON.stringify(['db.example.com']),
    });
    const routes = await l4Routes();
    // A catch-all close on the host matcher: `match: [{}]` would never match in caddy-l4.
    expect(routes[0]).toEqual({ match: [{ tls: { sni: ['db.example.com'] } }], handle: CLOSE });
    expect(routes[1].handle.map((h) => h.handler)).toEqual(['proxy']);
  });

  it('fails closed without a host matcher too, behind PROXY protocol', async () => {
    const listId = await insertList([]);
    await insertL4Host({ accessListId: listId, proxyProtocolReceive: true });
    const inner = (await l4Routes())[0].handle[1].routes as Route[];
    expect(inner[0]).toEqual({ handle: CLOSE });
  });

  it('expands a hostname rule in place into what it last resolved to', async () => {
    const now = new Date().toISOString();
    await ctx.db.insert(schema.accessListDnsCache).values({
      hostname: 'home.example.com',
      addresses: JSON.stringify(['2001:db8:1:2:3:4:5:6', '203.0.113.7']),
      resolvedAt: now,
      expiresAt: now,
    });
    const listId = await insertList([
      { action: 'deny', cidr: '203.0.113.0/24' },
      { action: 'allow', hostname: 'home.example.com' },
    ]);
    await insertL4Host({ accessListId: listId });
    const routes = await l4Routes();
    expect(routes[0]).toEqual({
      match: [
        { remote_ip: { ranges: ['203.0.113.0/24'] } },
        {
          not: [
            { remote_ip: { ranges: ['203.0.113.0/24', '2001:db8:1:2::/64', '203.0.113.7/32'] } },
          ],
        },
      ],
      handle: CLOSE,
    });
  });

  it('closes every connection while a list names only a host that has not resolved', async () => {
    const listId = await insertList([{ action: 'allow', hostname: 'nowhere.example.com' }]);
    await insertL4Host({ accessListId: listId });
    const routes = await l4Routes();
    expect(routes[0]).toEqual({
      match: [{ remote_ip: { ranges: ['0.0.0.0/0', '::/0'] } }],
      handle: CLOSE,
    });
  });
});

describe('L4 port ranges', () => {
  const LPORT = { '{l4.conn.local_addr}': { name: 'lport', pattern: ':(\\d+)$' } };

  it('listens on the range as written, one server for the range', async () => {
    await insertL4Host({ protocol: 'udp', listenAddress: ':27015-27030' });
    const doc = (await buildCaddyDocument()) as {
      apps: { layer4: { servers: Record<string, { listen: string[] }> } };
    };
    expect(Object.values(doc.apps.layer4.servers).map((s) => s.listen)).toEqual([
      ['udp/:27015-27030'],
    ]);
  });

  it('dials the port the connection arrived on in same mode', async () => {
    await insertL4Host({
      listenAddress: ':27015-27030',
      upstreams: JSON.stringify(['srcds', '[2001:db8::1]']),
      meta: JSON.stringify({ upstream_port_mode: 'same' }),
    });
    const routes = await l4Routes();
    expect(routes).toEqual([
      {
        match: [{ vars_regexp: LPORT }],
        handle: [
          {
            handler: 'proxy',
            upstreams: [
              { dial: ['srcds:{l4.regexp.lport.1}'] },
              { dial: ['[2001:db8::1]:{l4.regexp.lport.1}'] },
            ],
          },
        ],
      },
    ]);
  });

  it('captures on the host matcher, so guards and PROXY protocol keep their order', async () => {
    await insertL4Host({
      listenAddress: ':27015-27030',
      upstreams: JSON.stringify(['srcds']),
      matcherType: 'tls_sni',
      matcherValue: JSON.stringify(['game.example.com']),
      proxyProtocolReceive: true,
      meta: JSON.stringify({ upstream_port_mode: 'same', geoblock: GEO }),
    });
    const routes = await l4Routes();
    expect(routes[0].match).toEqual([{ tls: { sni: ['game.example.com'] }, vars_regexp: LPORT }]);
    expect(routes[0].handle[0]).toEqual({ handler: 'proxy_protocol' });
  });

  it('leaves out an active health check a same-mode host still has stored', async () => {
    await insertL4Host({
      listenAddress: ':27015-27030',
      upstreams: JSON.stringify(['a', 'b']),
      meta: JSON.stringify({
        upstream_port_mode: 'same',
        load_balancer: {
          enabled: true,
          policy: 'round_robin',
          active_health_check: { enabled: true, interval: '10s' },
          passive_health_check: { enabled: true, max_fails: 3 },
        },
      }),
    });
    const proxy = (await l4Routes())[0].handle[0];
    expect(proxy.health_checks).toEqual({ passive: { max_fails: 3 } });
  });

  it('keeps a TCP and a UDP host on one port as two listeners', async () => {
    await insertL4Host({ listenAddress: ':5000' });
    await insertL4Host({ protocol: 'udp', listenAddress: ':5000' });
    const doc = (await buildCaddyDocument()) as {
      apps: { layer4: { servers: Record<string, { listen: string[] }> } };
    };
    expect(
      Object.values(doc.apps.layer4.servers)
        .map((s) => s.listen[0])
        .sort(),
    ).toEqual([':5000', 'udp/:5000']);
  });
});
