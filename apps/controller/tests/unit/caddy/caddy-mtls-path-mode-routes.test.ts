/**
 * Regression: the HTTP route shape per mTLS path mode. full-site - the TLS policy already runs
 * require_and_verify, so the catch-all is a plain proxy route. whitelist - only listed paths carry
 * a fingerprint expression. exclusion - everything but those, plus a 403 fallback. A host with mTLS
 * off resolves to "full" too, so gating the catch-all on a fingerprint would 403 every request.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

// Hoisted out of the factory below: createTestDb is async, and a Bun mock factory must be
// synchronous - an async one never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { createProxyHost } from '../../../src/lib/models/proxy-hosts';
import { buildCaddyDocument } from '../../../src/lib/caddy';
import * as schema from '../../../src/lib/db/schema';

const EMPTY_ROLE_ID = 999;

type Matcher = Record<string, unknown>;
type Route = { match?: Matcher[]; handle?: Record<string, unknown>[] };

/** Every route whose host matcher covers `domain`, in document order. */
function routesFor(doc: unknown, domain: string): Route[] {
  const all =
    (doc as { apps?: { http?: { servers?: { cpm?: { routes?: Route[] } } } } })?.apps?.http?.servers
      ?.cpm?.routes ?? [];
  return all.filter((r) =>
    (r.match ?? []).some((m) => {
      const host = m.host as string[] | undefined;
      return Array.isArray(host) && host.includes(domain);
    }),
  );
}

/** The HTTP→HTTPS redirect carries its own expression; it is not an mTLS gate. */
function isSchemeRedirect(route: Route): boolean {
  return (route.handle ?? []).some((h) => h.handler === 'static_response' && h.status_code === 308);
}

function mtlsGatedRoutes(routes: Route[]): Route[] {
  return routes.filter(
    (r) =>
      !isSchemeRedirect(r) &&
      (r.match ?? []).some(
        (m) => typeof m.expression === 'string' && (m.expression as string).includes('tls.client'),
      ),
  );
}

function denyRoutes(routes: Route[]): Route[] {
  return routes.filter((r) => (r.handle ?? []).some((h) => h.body === 'mTLS access denied'));
}

/** Routes matching only the host (the catch-all), ignoring path-scoped routes. */
function catchAllRoutes(routes: Route[]): Route[] {
  return routes.filter(
    (r) =>
      !isSchemeRedirect(r) &&
      (r.match ?? []).some((m) => m.host !== undefined && m.path === undefined),
  );
}

function routeForPath(routes: Route[], path: string): Route[] {
  return routes.filter((r) =>
    (r.match ?? []).some((m) => {
      const p = m.path as string[] | undefined;
      return Array.isArray(p) && p.includes(path);
    }),
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

describe('proxy host with mTLS disabled', () => {
  it('serves a plain catch-all with no client-cert gate and no 403', async () => {
    const domain = 'plain.example.com';
    await createProxyHost({ name: 'plain', domains: [domain], upstreams: ['10.0.0.5:8080'] }, 1);

    const routes = routesFor(await buildCaddyDocument(), domain);

    expect(denyRoutes(routes)).toHaveLength(0);
    expect(mtlsGatedRoutes(routes)).toHaveLength(0);

    const catchAll = catchAllRoutes(routes);
    expect(catchAll).toHaveLength(1);
    expect(catchAll[0].handle?.some((h) => h.handler === 'reverse_proxy')).toBe(true);
  });

  it('leaves location rules ungated', async () => {
    const domain = 'plain-loc.example.com';
    await createProxyHost(
      {
        name: 'plain-loc',
        domains: [domain],
        upstreams: ['10.0.0.5:8080'],
        locationRules: [{ path: '/api', upstreams: ['10.0.0.9:9000'] }],
      },
      1,
    );

    const routes = routesFor(await buildCaddyDocument(), domain);

    expect(denyRoutes(routes)).toHaveLength(0);
    expect(mtlsGatedRoutes(routes)).toHaveLength(0);
    expect(routeForPath(routes, '/api').length).toBeGreaterThan(0);
  });
});

describe('mTLS full-site mode', () => {
  it('emits a plain catch-all - the TLS connection policy does the enforcing', async () => {
    const domain = 'mtls-full.example.com';
    await createProxyHost(
      {
        name: 'mtls-full',
        domains: [domain],
        upstreams: ['10.0.0.5:8080'],
        mtls: { enabled: true, trusted_role_ids: [EMPTY_ROLE_ID] },
      },
      1,
    );

    const routes = routesFor(await buildCaddyDocument(), domain);

    const catchAll = catchAllRoutes(routes);
    expect(catchAll).toHaveLength(1);
    expect((catchAll[0].match ?? []).every((m) => m.expression === undefined)).toBe(true);
    expect(denyRoutes(routes)).toHaveLength(0);
  });
});

describe('mTLS whitelist mode (protected_paths)', () => {
  it('gates only the listed paths and leaves the catch-all open', async () => {
    const domain = 'mtls-white.example.com';
    await createProxyHost(
      {
        name: 'mtls-white',
        domains: [domain],
        upstreams: ['10.0.0.5:8080'],
        mtls: { enabled: true, trusted_role_ids: [EMPTY_ROLE_ID], protected_paths: ['/admin/*'] },
      },
      1,
    );

    const routes = routesFor(await buildCaddyDocument(), domain);

    // The protected path is gated and has a 403 fallback.
    const adminRoutes = routeForPath(routes, '/admin/*');
    expect(mtlsGatedRoutes(adminRoutes).length).toBeGreaterThan(0);
    expect(denyRoutes(adminRoutes).length).toBeGreaterThan(0);

    // The catch-all must stay open - this is what "whitelist" means.
    const catchAll = catchAllRoutes(routes);
    expect(catchAll).toHaveLength(1);
    expect((catchAll[0].match ?? []).every((m) => m.expression === undefined)).toBe(true);
    expect(denyRoutes(catchAll)).toHaveLength(0);
  });
});

describe('mTLS exclusion mode (excluded_paths)', () => {
  it('leaves the listed paths open and gates the catch-all', async () => {
    const domain = 'mtls-excl.example.com';
    await createProxyHost(
      {
        name: 'mtls-excl',
        domains: [domain],
        upstreams: ['10.0.0.5:8080'],
        mtls: { enabled: true, trusted_role_ids: [EMPTY_ROLE_ID], excluded_paths: ['/health'] },
      },
      1,
    );

    const routes = routesFor(await buildCaddyDocument(), domain);

    // The excluded path is served without a certificate.
    const healthRoutes = routeForPath(routes, '/health');
    expect(healthRoutes.length).toBeGreaterThan(0);
    expect(mtlsGatedRoutes(healthRoutes)).toHaveLength(0);
    expect(denyRoutes(healthRoutes)).toHaveLength(0);

    // Everything else is gated, with a 403 fallback.
    const catchAll = catchAllRoutes(routes);
    expect(mtlsGatedRoutes(catchAll).length).toBeGreaterThan(0);
    expect(denyRoutes(catchAll).length).toBeGreaterThan(0);
  });
});
