/** Cache assets: what each mode emits, and that it lands after auth, right before the upstream. */
import { describe, it, expect, beforeEach } from 'bun:test';
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

import { createProxyHost, getProxyHost, updateProxyHost } from '../../src/lib/models/proxy-hosts';
import { buildCaddyDocument } from '../../src/lib/caddy';
import { parseCacheConfig } from '../../src/lib/proxy-host-form';
import {
  buildHostCacheHandler,
  CACHE_ASSET_PATHS,
  sanitizeHostCache,
  withHostCache,
} from '../../src/lib/host-cache';
import * as schema from '../../src/lib/db/schema';

const NOW = new Date().toISOString();

type Handler = Record<string, unknown> & { handler?: string };
type Route = { match?: { host?: string[]; path?: string[] }[]; handle?: Handler[] };

async function hostRoutes(domain: string): Promise<Route[]> {
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
  walk(await buildCaddyDocument());
  return found;
}

/** The proxy position of a route: a bare reverse_proxy, or the cache wrapper around one. */
function proxyStep(route: Route): Handler | undefined {
  return route.handle?.at(-1);
}

function isCacheWrapper(handler: Handler | undefined): boolean {
  const inner = (handler?.routes as Route[] | undefined)?.[0]?.handle;
  return (
    handler?.handler === 'subroute' &&
    inner?.length === 2 &&
    inner[1].handler === 'reverse_proxy' &&
    JSON.stringify(inner[0]).includes('*.woff2')
  );
}

async function create(domain: string, options: Record<string, unknown>) {
  return createProxyHost(
    { name: domain, domains: [domain], upstreams: ['10.0.0.5:8080'], ...options },
    1,
  );
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
    createdAt: NOW,
    updatedAt: NOW,
  });
});

describe('buildHostCacheHandler', () => {
  it('is null when caching is off', () => {
    expect(buildHostCacheHandler(undefined, true)).toBeNull();
  });

  it('only fills in Cache-Control on asset paths in browser mode', () => {
    const handler = buildHostCacheHandler({ mode: 'browser', max_age: 3600 }, true) as {
      routes: Route[];
    };
    const [route] = handler.routes;
    expect(route.match).toEqual([{ path: CACHE_ASSET_PATHS }]);
    expect(route.handle?.map((h) => h.handler)).toEqual(['headers', 'headers']);
    expect(route.handle?.[1]).toEqual({
      handler: 'headers',
      response: {
        set: { 'Cache-Control': ['max-age=3600'] },
        require: { headers: { 'Cache-Control': null } },
      },
    });
  });

  it('marks responses that set a cookie private, in either mode', () => {
    for (const mode of ['browser', 'caddy'] as const) {
      const json = JSON.stringify(buildHostCacheHandler({ mode, max_age: 60 }, true));
      expect(json).toContain(
        '"set":{"Cache-Control":["private"]},"require":{"headers":{"Set-Cookie":[]}}',
      );
    }
  });

  it('puts the shared cache first in Caddy mode, with the TTL where Souin reads it', () => {
    const handler = buildHostCacheHandler({ mode: 'caddy', max_age: 600 }, true) as {
      routes: Route[];
    };
    expect(handler.routes[0].handle?.[0]).toEqual({
      handler: 'cache',
      Configuration: { DefaultCache: { ttl: '600s' } },
    });
  });

  it('degrades Caddy mode to browser mode when the module is not usable', () => {
    const json = JSON.stringify(buildHostCacheHandler({ mode: 'caddy', max_age: 600 }, false));
    expect(json).not.toContain('"handler":"cache"');
    expect(json).toContain('max-age=600');
  });

  it('wraps nothing when caching is off', () => {
    const proxy = { handler: 'reverse_proxy' };
    expect(withHostCache(proxy, null)).toBe(proxy);
  });
});

describe('sanitizeHostCache', () => {
  it('clamps the max age and falls back to browser mode', () => {
    expect(sanitizeHostCache({ mode: 'nope', maxAge: 1 })).toEqual({
      mode: 'browser',
      max_age: 60,
    });
    expect(sanitizeHostCache({ mode: 'caddy', max_age: 1e12 })).toEqual({
      mode: 'caddy',
      max_age: 31_536_000,
    });
    expect(sanitizeHostCache({ mode: 'caddy', maxAge: 'abc' })).toEqual({
      mode: 'caddy',
      max_age: 86_400,
    });
    expect(sanitizeHostCache(null)).toBeUndefined();
    expect(sanitizeHostCache('browser')).toBeUndefined();
  });
});

describe('parseCacheConfig', () => {
  const form = (entries: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(entries)) data.set(key, value);
    return data;
  };

  it('leaves an unrendered section alone', () => {
    expect(parseCacheConfig(form({}))).toBeUndefined();
  });

  it('turns caching off when the switch is off', () => {
    expect(parseCacheConfig(form({ cachePresent: '1' }))).toBeNull();
  });

  it('reads the mode and max age', () => {
    expect(
      parseCacheConfig(
        form({ cachePresent: '1', cacheEnabled: 'on', cacheMode: 'caddy', cacheMaxAge: '120' }),
      ),
    ).toEqual({ mode: 'caddy', maxAge: 120 });
  });
});

describe('cache assets on a host', () => {
  it('round-trips through the model and switches off with null', async () => {
    const host = await create('rt.example.com', { cache: { mode: 'caddy', maxAge: 5 } });
    expect(host.cache).toEqual({ mode: 'caddy', maxAge: 60 });

    await updateProxyHost(host.id, { cache: null }, 1);
    expect((await getProxyHost(host.id))?.cache).toBeNull();
  });

  it('adds nothing to a host without it', async () => {
    await create('plain.example.com', {});
    const json = JSON.stringify(await hostRoutes('plain.example.com'));
    expect(json).not.toContain('*.woff2');
  });

  it('wraps the proxy, and emits no cache handler for a module the image lacks', async () => {
    await create('assets.example.com', { cache: { mode: 'caddy', maxAge: 3600 } });
    const routes = await hostRoutes('assets.example.com');
    const proxied = routes.filter((route) => isCacheWrapper(proxyStep(route)));
    expect(proxied.length).toBeGreaterThan(0);
    expect(JSON.stringify(routes)).not.toContain('"handler":"cache"');
  });

  it('caches location-rule proxies too', async () => {
    await create('loc.example.com', {
      cache: { mode: 'browser', maxAge: 3600 },
      locationRules: [{ path: '/static/*', upstreams: ['10.0.0.9:80'] }],
    });
    const routes = await hostRoutes('loc.example.com');
    const location = routes.find((route) =>
      route.match?.some((m) => m.path?.includes('/static/*')),
    );
    expect(isCacheWrapper(proxyStep(location as Route))).toBe(true);
  });

  it('sits after forward auth, so a cached asset is never served to an unauthenticated caller', async () => {
    await create('auth.example.com', {
      cache: { mode: 'browser', maxAge: 3600 },
      forwardAuth: { enabled: true, provider: 'authelia', authUpstream: 'http://authelia:9091' },
    });
    const routes = await hostRoutes('auth.example.com');
    const gated = routes.filter((route) =>
      route.handle?.some((h) => JSON.stringify(h).includes('authelia:9091')),
    );
    expect(gated.length).toBeGreaterThan(0);
    for (const route of gated) {
      const handle = route.handle ?? [];
      const authIndex = handle.findIndex((h) => JSON.stringify(h).includes('authelia:9091'));
      expect(isCacheWrapper(handle.at(-1))).toBe(true);
      // Nothing before the auth step may carry the cache.
      expect(JSON.stringify(handle.slice(0, authIndex + 1))).not.toContain('*.woff2');
    }
  });
});
