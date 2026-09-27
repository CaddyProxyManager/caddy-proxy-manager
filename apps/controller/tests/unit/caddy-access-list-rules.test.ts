import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => ({
  default: ctx.db,
  sqlite: undefined,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null =>
    !value ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
}));
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
  opts: { users?: string[]; cidrs?: string[]; satisfy?: string },
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
