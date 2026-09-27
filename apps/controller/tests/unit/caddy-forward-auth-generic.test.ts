/**
 * Asserts route shape, not handler fields: the browser/API split, the bypass header winning over
 * both, and the identity-header strip without which a caller forges Remote-User to the upstream.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

// Hoisted: a Bun mock factory must be synchronous, and an async one hangs the file.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => {
  return {
    default: ctx.db,
    sqlite: undefined,
    schema: schemaModule,
    nowIso: () => new Date().toISOString(),
    toIso: (value: string | Date | null | undefined): string | null => {
      if (!value) return null;
      return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    },
  };
});

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { createProxyHost, getProxyHost } from '../../src/lib/models/proxy-hosts';
import { buildCaddyDocument } from '../../src/lib/caddy';
import * as schema from '../../src/lib/db/schema';

const UPSTREAM = '10.0.0.9:8080';
const AUTH_DIAL = 'authelia:9091';
const AUTHELIA_HEADERS = [
  'Remote-User',
  'Remote-Groups',
  'Remote-Email',
  'Remote-Name',
  'Remote-Ip',
];

type Handler = Record<string, unknown>;
type Route = { match?: Record<string, unknown>[]; handle?: unknown[] };

/** In Caddy's order, minus the scheme redirect, which proxies nothing. */
async function routesFor(domain: string): Promise<Route[]> {
  const doc = (await buildCaddyDocument()) as Record<string, unknown>;
  const servers = ((doc.apps as Record<string, { servers?: Record<string, { routes?: Route[] }> }>)
    .http.servers ?? {}) as Record<string, { routes?: Route[] }>;
  const all = Object.values(servers).flatMap((server) => server.routes ?? []);
  return all.filter(
    (route) =>
      JSON.stringify(route.match ?? []).includes(domain) &&
      (route.handle ?? []).some((handler) => (handler as Handler)?.handler === 'reverse_proxy'),
  );
}

function isAuthSubrequest(handler: unknown): boolean {
  const h = handler as Handler;
  if (h?.handler !== 'reverse_proxy') return false;
  const dials = ((h.upstreams as { dial?: string }[]) ?? []).map((u) => u.dial);
  return dials.includes(AUTH_DIAL);
}

function isUpstreamProxy(handler: unknown): boolean {
  const h = handler as Handler;
  if (h?.handler !== 'reverse_proxy') return false;
  const dials = ((h.upstreams as { dial?: string }[]) ?? []).map((u) => u.dial);
  return dials.includes(UPSTREAM);
}

function isIdentityStrip(handler: unknown): boolean {
  const h = handler as Handler;
  if (h?.handler !== 'headers') return false;
  const deleted = (h.request as { delete?: string[] } | undefined)?.delete ?? [];
  const lowered = deleted.map((name) => name.toLowerCase());
  return AUTHELIA_HEADERS.every((name) => lowered.includes(name.toLowerCase()));
}

function authHandler(route: Route): Handler | undefined {
  return (route.handle ?? []).find(isAuthSubrequest) as Handler | undefined;
}

/** True when this route's auth subrequest turns the portal redirect into a 401. */
function answers401(route: Route): boolean {
  const responses = (authHandler(route)?.handle_response ?? []) as {
    match?: { status_code?: number[] };
    routes?: { handle?: Handler[] }[];
  }[];
  return responses.some(
    (response) =>
      (response.match?.status_code ?? []).includes(302) &&
      (response.routes ?? []).some((r) =>
        (r.handle ?? []).some((h) => h.handler === 'static_response' && h.status_code === 401),
      ),
  );
}

function matchesBrowser(route: Route): boolean {
  return (route.match ?? []).some((matcher) => 'header' in matcher && 'not' in matcher);
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

describe('generic forward auth - stored block', () => {
  it('fills the Authelia preset in from the provider alone', async () => {
    const host = await createProxyHost(
      {
        name: 'authelia-host',
        domains: ['app.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: {
          enabled: true,
          provider: 'authelia',
          authUpstream: 'http://authelia:9091',
        },
      },
      1,
    );

    expect(host.forwardAuth).toMatchObject({
      enabled: true,
      provider: 'authelia',
      authUpstream: 'http://authelia:9091',
      authEndpoint: '/api/authz/forward-auth',
    });
    expect(host.forwardAuth?.copyHeaders).toEqual([
      'Remote-User',
      'Remote-Groups',
      'Remote-Email',
      'Remote-Name',
      'Remote-IP',
    ]);
  });

  it('refuses to enable a block that would publish the host unprotected', async () => {
    const base = { domains: ['bad.example.com'], upstreams: [UPSTREAM] };
    await expect(
      createProxyHost(
        { ...base, name: 'no-upstream', forwardAuth: { enabled: true, provider: 'authelia' } },
        1,
      ),
    ).rejects.toThrow(/authUpstream is required/);
    await expect(
      createProxyHost(
        {
          ...base,
          name: 'bad-scheme',
          forwardAuth: { enabled: true, provider: 'authelia', authUpstream: 'ftp://authelia' },
        },
        1,
      ),
    ).rejects.toThrow(/http or https/);
    await expect(
      createProxyHost(
        {
          ...base,
          name: 'custom-no-endpoint',
          forwardAuth: {
            enabled: true,
            provider: 'custom',
            authUpstream: 'http://tinyauth:3000',
          },
        },
        1,
      ),
    ).rejects.toThrow(/authEndpoint is required/);
  });

  it('drops a header name that is not a header name, and a placeholder in a path', async () => {
    const host = await createProxyHost(
      {
        name: 'sanitised',
        domains: ['sanitised.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: {
          enabled: true,
          provider: 'custom',
          authUpstream: 'http://tinyauth:3000',
          authEndpoint: '/api/auth/caddy{http.request.uri}',
          copyHeaders: ['Remote-User', 'Bad Header', 'X-Real:Ip'],
          apiBypassHeaders: ['X-Api-Key', 'no spaces allowed'],
          protectedPaths: ['/admin/{http.request.host}*'],
        },
      },
      1,
    );

    expect(host.forwardAuth?.authEndpoint).toBe('/api/auth/caddy');
    expect(host.forwardAuth?.copyHeaders).toEqual(['Remote-User']);
    expect(host.forwardAuth?.apiBypassHeaders).toEqual(['X-Api-Key']);
    expect(host.forwardAuth?.protectedPaths).toEqual(['/admin/*']);
  });

  it('refuses a second authenticator on the same host', async () => {
    const host = await createProxyHost(
      {
        name: 'two-providers',
        domains: ['both.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: {
          enabled: true,
          provider: 'authelia',
          authUpstream: 'http://authelia:9091',
        },
      },
      1,
    );

    const { updateProxyHost } = await import('../../src/lib/models/proxy-hosts');
    await expect(
      updateProxyHost(host.id, { cpmForwardAuth: { enabled: true } }, 1),
    ).rejects.toThrow(/one authenticator/);

    expect((await getProxyHost(host.id))?.forwardAuth?.enabled).toBe(true);
  });
});

describe('generic forward auth - generated routes', () => {
  it('gates the whole site through one auth subrequest, stripping identity headers first', async () => {
    await createProxyHost(
      {
        name: 'fullsite',
        domains: ['app.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: {
          enabled: true,
          provider: 'authelia',
          authUpstream: 'http://authelia:9091',
        },
      },
      1,
    );

    const routes = await routesFor('app.example.com');
    expect(routes).toHaveLength(1);

    const handle = routes[0].handle ?? [];
    const stripIdx = handle.findIndex(isIdentityStrip);
    const authIdx = handle.findIndex(isAuthSubrequest);
    const proxyIdx = handle.findIndex(isUpstreamProxy);
    expect(stripIdx).toBeGreaterThanOrEqual(0);
    expect(stripIdx).toBeLessThan(authIdx);
    expect(authIdx).toBeLessThan(proxyIdx);

    // Without the split, the auth server's redirect passes through to the caller.
    expect(answers401(routes[0])).toBe(false);

    const auth = authHandler(routes[0]) as Handler;
    expect(auth.rewrite).toEqual({ method: 'GET', uri: '/api/authz/forward-auth' });
    expect(auth.trusted_proxies).toContain('10.0.0.0/8');
  });

  it('answers a browser with the portal redirect and everything else with 401', async () => {
    await createProxyHost(
      {
        name: 'split',
        domains: ['split.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: {
          enabled: true,
          provider: 'authelia',
          authUpstream: 'http://authelia:9091',
          apiSplit: true,
        },
      },
      1,
    );

    const routes = await routesFor('split.example.com');
    expect(routes).toHaveLength(2);

    // Browser first: Caddy takes the first match, and the API route matches everything.
    expect(matchesBrowser(routes[0])).toBe(true);
    expect(answers401(routes[0])).toBe(false);
    expect(matchesBrowser(routes[1])).toBe(false);
    expect(answers401(routes[1])).toBe(true);

    const browserMatch = (routes[0].match ?? [])[0];
    expect(browserMatch.header).toMatchObject({ Accept: ['*text/html*'] });
    expect(browserMatch.not).toEqual([{ header: { 'X-Requested-With': ['*'] } }]);
  });

  it('lets a bypass header reach the upstream without asking the auth server', async () => {
    await createProxyHost(
      {
        name: 'bypass',
        domains: ['bypass.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: {
          enabled: true,
          provider: 'authelia',
          authUpstream: 'http://authelia:9091',
          apiSplit: true,
          apiBypassHeaders: ['X-Api-Key'],
        },
      },
      1,
    );

    const routes = await routesFor('bypass.example.com');
    const bypass = routes[0];

    // First: a caller holding the upstream's own credential must never reach the auth server.
    expect((bypass.match ?? [])[0].header).toEqual({ 'X-Api-Key': ['*'] });
    expect(authHandler(bypass)).toBeUndefined();
    expect((bypass.handle ?? []).some(isUpstreamProxy)).toBe(true);
    // Still stripped: the upstream must not believe a forged Remote-User either.
    expect((bypass.handle ?? []).some(isIdentityStrip)).toBe(true);
  });

  it('leaves the rest of the site open in whitelist mode, and strips there too', async () => {
    await createProxyHost(
      {
        name: 'whitelist',
        domains: ['whitelist.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: {
          enabled: true,
          provider: 'authelia',
          authUpstream: 'http://authelia:9091',
          protectedPaths: ['/admin/*'],
        },
      },
      1,
    );

    const routes = await routesFor('whitelist.example.com');
    const gated = routes.filter((route) => authHandler(route) !== undefined);
    const open = routes.filter((route) => authHandler(route) === undefined);

    expect(gated).toHaveLength(1);
    expect((gated[0].match ?? [])[0].path).toEqual(['/admin/*']);
    expect(open.length).toBeGreaterThan(0);
    // The catch-all sees no auth server, so the strip alone stops a forged identity header.
    for (const route of open) {
      expect((route.handle ?? []).some(isIdentityStrip)).toBe(true);
    }
  });

  it('is not published at all for a block that cannot be read', async () => {
    // Straight to the row, which the model would refuse: "enabled but unusable" is not "off".
    const host = await createProxyHost(
      { name: 'broken', domains: ['broken.example.com'], upstreams: [UPSTREAM] },
      1,
    );
    await ctx.db
      .update(schema.proxyHosts)
      .set({ meta: JSON.stringify({ forward_auth: { enabled: true, auth_upstream: 'nonsense' } }) })
      .where(eq(schema.proxyHosts.id, host.id));

    const routes = await routesFor('broken.example.com');
    // Falls back to an ordinary host rather than failing the document - hence the model's refusal.
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) expect(authHandler(route)).toBeUndefined();
  });
});
