/**
 * An access list must FAIL CLOSED: an empty list means "nobody", not "nothing to check", on every
 * route the host owns, location rules included.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

// Hoisted: an async Bun mock factory never resolves and the file hangs.
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

import { createProxyHost } from '../../src/lib/models/proxy-hosts';
import { buildCaddyDocument } from '../../src/lib/caddy';
import * as schema from '../../src/lib/db/schema';

type Handler = { handler?: string; status_code?: number | string };
type Route = { match?: { host?: string[] }[]; handle?: Handler[] };

function routesForDomain(doc: unknown, domain: string): Route[] {
  const found: Route[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const route = node as Route;
    if (Array.isArray(route.handle) && route.match?.some((m) => m.host?.includes(domain))) {
      found.push(route);
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(doc);
  return found;
}

/** Nobody reaches reverse_proxy without passing a gate first. */
function isGatedBeforeProxy(route: Route): boolean {
  const handlers = route.handle ?? [];
  const proxyAt = handlers.findIndex((h) => h.handler === 'reverse_proxy');
  if (proxyAt === -1) return true;
  return handlers
    .slice(0, proxyAt)
    .some(
      (h) =>
        h.handler === 'authentication' ||
        (h.handler === 'static_response' && Number(h.status_code) >= 400),
    );
}

const NOW = new Date().toISOString();

async function seedList(id: number, usernames: string[]) {
  await ctx.db.insert(schema.accessLists).values({
    id,
    name: `list-${id}`,
    createdAt: NOW,
    updatedAt: NOW,
  });
  for (const username of usernames) {
    await ctx.db.insert(schema.accessListEntries).values({
      accessListId: id,
      username,
      // Only bcrypt-shaped: nothing verifies it here.
      passwordHash: '$2b$10$abcdefghijklmnopqrstuuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
}

beforeEach(async () => {
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.accessListEntries);
  await ctx.db.delete(schema.accessLists);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    provider: 'credentials',
    subject: 'admin',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
});

describe('access list fail-closed', () => {
  it('denies every request to a host whose access list has no members', async () => {
    const domain = 'empty-list.example.com';
    await seedList(10, []);
    await createProxyHost(
      { name: 'empty-list', domains: [domain], upstreams: ['10.0.0.5:8080'], accessListId: 10 },
      1,
    );

    const routes = routesForDomain(await buildCaddyDocument(), domain);

    // Dropping it would hand the domain to whatever else matches.
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(isGatedBeforeProxy(route)).toBe(true);
    }
  });

  it('denies location-rule paths on that host too', async () => {
    const domain = 'empty-list-locations.example.com';
    await seedList(11, []);
    await createProxyHost(
      {
        name: 'empty-list-locations',
        domains: [domain],
        upstreams: ['10.0.0.5:8080'],
        accessListId: 11,
        locationRules: [{ path: '/api/*', upstreams: ['10.0.0.6:9000'] }],
      },
      1,
    );

    const routes = routesForDomain(await buildCaddyDocument(), domain);

    expect(routes.some((r) => JSON.stringify(r).includes('10.0.0.6:9000'))).toBe(true);
    for (const route of routes) {
      expect(isGatedBeforeProxy(route)).toBe(true);
    }
  });

  it('still authenticates with http_basic when the list has members', async () => {
    const domain = 'members.example.com';
    await seedList(12, ['alice']);
    await createProxyHost(
      { name: 'members', domains: [domain], upstreams: ['10.0.0.5:8080'], accessListId: 12 },
      1,
    );

    const routes = routesForDomain(await buildCaddyDocument(), domain);
    const chain = JSON.stringify(routes);

    expect(chain).toContain('"http_basic"');
    expect(chain).toContain('"alice"');
    for (const route of routes) {
      expect(isGatedBeforeProxy(route)).toBe(true);
    }
  });

  it('leaves a host with no access list open', async () => {
    const domain = 'open.example.com';
    await createProxyHost({ name: 'open', domains: [domain], upstreams: ['10.0.0.5:8080'] }, 1);

    const routes = routesForDomain(await buildCaddyDocument(), domain);

    expect(routes.some((route) => !isGatedBeforeProxy(route))).toBe(true);
  });
});
