import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));
vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { buildCaddyDocument } from '../../src/lib/caddy';
import * as schema from '../../src/lib/db/schema';

const NOW = new Date().toISOString();
const HASH = '$2b$10$abcdefghijklmnopqrstuuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012';

type Route = { match?: { host?: string[]; path?: string[] }[]; handle?: unknown[] };

function routesFor(doc: unknown, domain: string): Route[] {
  const found: Route[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const route = node as Route;
    if (Array.isArray(route.handle) && route.match?.some((m) => m.host?.includes(domain))) {
      found.push(route);
    }
    Object.values(node).forEach(walk);
  };
  walk(doc);
  return found;
}

async function seedList(
  id: number,
  opts: {
    users?: string[];
    cidrs?: string[];
    rules?: { action: string; cidr?: string; hostname?: string }[];
    satisfy?: string;
  },
) {
  await ctx.db.insert(schema.accessLists).values({
    id,
    name: `list-${id}`,
    satisfy: opts.satisfy ?? 'all',
    createdAt: NOW,
    updatedAt: NOW,
  });
  for (const username of opts.users ?? []) {
    await ctx.db.insert(schema.accessListEntries).values({
      accessListId: id,
      username,
      passwordHash: HASH,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  for (const [index, rule] of (opts.rules ?? []).entries()) {
    await ctx.db.insert(schema.accessListIpRules).values({
      accessListId: id,
      ...rule,
      sortOrder: index,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  for (const [index, cidr] of (opts.cidrs ?? []).entries()) {
    await ctx.db.insert(schema.accessListIpRules).values({
      accessListId: id,
      action: 'allow',
      cidr,
      sortOrder: index,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
}

async function seedHost(
  domain: string,
  accessListId: number | null,
  locationRules: unknown[] = [],
) {
  await ctx.db.insert(schema.proxyHosts).values({
    name: domain,
    domains: JSON.stringify([domain]),
    upstreams: '["app:80"]',
    accessListId,
    meta: JSON.stringify({ location_rules: locationRules }),
    createdAt: NOW,
    updatedAt: NOW,
  });
}

beforeEach(async () => {
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.accessListIpRules);
  await ctx.db.delete(schema.accessListDnsCache);
  await ctx.db.delete(schema.accessListEntries);
  await ctx.db.delete(schema.accessLists);
});

describe('access lists in the config', () => {
  it('puts IP rules in as client_ip matchers', async () => {
    await seedList(1, { cidrs: ['10.0.0.0/8'] });
    await seedHost('ip.example.com', 1);
    const json = JSON.stringify(routesFor(await buildCaddyDocument(), 'ip.example.com'));
    expect(json).toContain('"client_ip":{"ranges":["10.0.0.0/8"]}');
    expect(json).not.toContain('"handler":"authentication"');
  });

  it('expands a hostname rule where it stands, widening IPv6 to its prefix', async () => {
    await ctx.db.insert(schema.accessListDnsCache).values({
      hostname: 'home.example.net',
      addresses: JSON.stringify(['198.51.100.4', '2001:db8:aa:bb::1']),
      resolvedAt: NOW,
      expiresAt: NOW,
    });
    await seedList(1, {
      rules: [
        { action: 'deny', cidr: '198.51.100.0/24' },
        { action: 'allow', hostname: 'home.example.net/56' },
        { action: 'allow', cidr: '10.0.0.0/8' },
      ],
    });
    await seedHost('dyn.example.com', 1);
    const json = JSON.stringify(routesFor(await buildCaddyDocument(), 'dyn.example.com'));
    // The default's exclusion lists every range in rule order, the name's where the name was.
    expect(json).toContain(
      '"client_ip":{"ranges":["198.51.100.0/24","198.51.100.4/32","2001:db8:aa::/56","10.0.0.0/8"]}',
    );
  });

  it('fails closed on an allow rule whose name has not resolved', async () => {
    await seedList(1, { rules: [{ action: 'allow', hostname: 'unknown.example.net' }] });
    await seedHost('closed.example.com', 1);
    const json = JSON.stringify(routesFor(await buildCaddyDocument(), 'closed.example.com'));
    expect(json).toContain('"client_ip":{"ranges":["0.0.0.0/0","::/0"]}');
    expect(json).toContain('"status_code":403');
  });

  it("gives a location rule its own list, and none, without touching the host's", async () => {
    await seedList(1, { users: ['host-user'] });
    await seedList(2, { users: ['admin-user'] });
    await seedHost('paths.example.com', 1, [
      { path: '/admin/*', upstreams: ['admin:80'], access_list_id: 2 },
      { path: '/public/*', upstreams: ['public:80'], access_list_id: null },
      { path: '/api/*', upstreams: ['api:80'] },
    ]);
    const routes = routesFor(await buildCaddyDocument(), 'paths.example.com');
    const byPath = (path: string) =>
      JSON.stringify(routes.find((r) => r.match?.some((m) => m.path?.includes(path))));

    expect(byPath('/admin/*')).toContain('admin-user');
    expect(byPath('/admin/*')).not.toContain('host-user');
    expect(byPath('/public/*')).not.toContain('"handler":"authentication"');
    expect(byPath('/api/*')).toContain('host-user');

    const catchAll = routes.find(
      (r) => !r.match?.some((m) => m.path) && JSON.stringify(r).includes('reverse_proxy'),
    );
    expect(JSON.stringify(catchAll)).toContain('host-user');
  });

  it('protects just one path of a host that has no list', async () => {
    await seedList(3, { users: ['admin-user'] });
    await seedHost('open.example.com', null, [
      { path: '/admin/*', upstreams: ['admin:80'], access_list_id: 3 },
    ]);
    const routes = routesFor(await buildCaddyDocument(), 'open.example.com');
    const admin = routes.find((r) => r.match?.some((m) => m.path?.includes('/admin/*')));
    expect(JSON.stringify(admin)).toContain('admin-user');
    const catchAll = routes.find(
      (r) => !r.match?.some((m) => m.path) && JSON.stringify(r).includes('reverse_proxy'),
    );
    expect(JSON.stringify(catchAll)).not.toContain('"handler":"authentication"');
  });

  it('refuses a path whose list no longer exists', async () => {
    await seedHost('gone.example.com', null, [
      { path: '/admin/*', upstreams: ['admin:80'], access_list_id: 999 },
    ]);
    const routes = routesFor(await buildCaddyDocument(), 'gone.example.com');
    const admin = routes.find((r) => r.match?.some((m) => m.path?.includes('/admin/*')));
    expect(JSON.stringify(admin)).toContain('"status_code":403');
  });
});
