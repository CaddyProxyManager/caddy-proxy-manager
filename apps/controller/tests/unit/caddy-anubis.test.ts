/** The Anubis bot challenge: its subroute, its place in every chain, and what the model refuses. */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { createProxyHost, updateProxyHost } from '../../src/lib/models/proxy-hosts';
import { buildCaddyDocument } from '../../src/lib/caddy';
import { EMPTY_DASHBOARD_HOST_OPTIONS } from '../../src/lib/dashboard-host';
import { saveDashboardSettings } from '../../src/lib/settings';
import { buildAnubisHandler, ANUBIS_EXEMPT_PATHS_MAX } from '../../src/lib/host-anubis';
import { parseProxyHostOptionUpdates } from '../../src/lib/proxy-host-form';
import * as schema from '../../src/lib/db/schema';
import { chainLabels, chainsTo, type Handler } from '../helpers/host-chains';

const NOW = new Date().toISOString();
const UPSTREAM = '10.0.0.5:8080';
const ANUBIS = { enabled: true, upstream: 'http://anubis:8923' };
const WAF = { enabled: true, mode: 'On', load_owasp_crs: true, waf_mode: 'override' };

type Route = { match?: Record<string, unknown>[]; handle: Handler[] };

async function build(domain: string, options: Record<string, unknown>) {
  await createProxyHost({ name: domain, domains: [domain], upstreams: [UPSTREAM], ...options }, 1);
  return buildCaddyDocument();
}

function routesOf(handler: Handler | null): Route[] {
  expect(handler?.handler).toBe('subroute');
  return handler!.routes as Route[];
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

describe('the subroute', () => {
  it('proxies the challenge prefix to Anubis with the client IP', () => {
    const [challenge] = routesOf(buildAnubisHandler(ANUBIS));
    expect(challenge!.match).toEqual([{ path: ['/.within.website/*'] }]);
    const proxy = challenge!.handle[0]!;
    expect(proxy).toMatchObject({
      handler: 'reverse_proxy',
      upstreams: [{ dial: 'anubis:8923' }],
      headers: {
        request: {
          set: {
            'X-Real-Ip': ['{http.vars.client_ip}'],
            'X-Forwarded-For': ['{http.vars.client_ip}'],
          },
        },
      },
    });
    expect(proxy).not.toHaveProperty('transport');
  });

  it('checks every other request and redirects a 401 to the challenge, escaped', () => {
    const [, checkRoute] = routesOf(buildAnubisHandler(ANUBIS));
    // Disjoint from the challenge route: `terminal` inside a subroute would end the request.
    expect(checkRoute!.match).toEqual([{ not: [{ path: ['/.within.website/*'] }] }]);
    const check = checkRoute!.handle[0]!;
    // The trailing `?` empties the query; without it Caddy forwards the client's.
    expect(check.rewrite).toEqual({
      method: 'GET',
      uri: '/.within.website/x/cmd/anubis/api/check?',
    });
    const set = (check.headers as { request: { set: Record<string, string[]> } }).request.set;
    expect(set['X-Real-Ip']).toEqual(['{http.vars.client_ip}']);
    expect(set['X-Forwarded-Uri']).toEqual(['{http.request.uri}']);
    expect(set['X-Forwarded-Host']).toEqual(['{http.request.hostport}']);
    expect(set['X-Forwarded-Proto']).toEqual(['{http.request.scheme}']);

    const responses = check.handle_response as {
      match: { status_code: number[] };
      routes: { handle: Handler[] }[];
    }[];
    // A 2xx must have a route, or the check's own 200 becomes the answer.
    expect(responses[0]!.match.status_code).toEqual([2]);
    expect(responses[0]!.routes.length).toBeGreaterThan(0);
    expect(responses[1]!.match.status_code).toEqual([401]);
    const redirect = responses[1]!.routes[0]!.handle[0]!;
    expect(redirect.status_code).toBe(307);
    expect((redirect.headers as Record<string, string[]>).Location).toEqual([
      '/.within.website/?redir={http.request.uri_escaped}',
    ]);
    // Anubis's 403 (DENY) and its own PUBLIC_URL redirect pass through untouched.
    expect(responses).toHaveLength(2);
  });

  it('leaves the exempt paths out of the check, but not out of the challenge route', () => {
    const [challenge, checkRoute] = routesOf(
      buildAnubisHandler({ ...ANUBIS, exempt_paths: ['/api/*', '/feed.xml'] }),
    );
    expect(challenge!.match).toEqual([{ path: ['/.within.website/*'] }]);
    expect(checkRoute!.match).toEqual([
      { not: [{ path: ['/.within.website/*', '/api/*', '/feed.xml'] }] },
    ]);
  });

  it("never forwards the client's Authorization to Anubis, but keeps its cookies", () => {
    for (const route of routesOf(buildAnubisHandler(ANUBIS))) {
      const request = (route.handle[0]!.headers as { request: Record<string, unknown> }).request;
      expect(request.delete).toEqual(['Authorization']);
      expect(JSON.stringify(request)).not.toContain('Cookie');
    }
  });

  it('speaks TLS to an https Anubis on its default port', () => {
    const routes = routesOf(buildAnubisHandler({ enabled: true, upstream: 'https://anubis.lan' }));
    for (const route of routes) {
      expect(route.handle[0]).toMatchObject({
        upstreams: [{ dial: 'anubis.lan:443' }],
        transport: { protocol: 'http', tls: {} },
      });
    }
  });

  it('is nothing while off or without a usable upstream', () => {
    expect(buildAnubisHandler({ ...ANUBIS, enabled: false })).toBeNull();
    expect(buildAnubisHandler({ enabled: true })).toBeNull();
    expect(buildAnubisHandler({ enabled: true, upstream: 'http://{env.X}:1' })).toBeNull();
    expect(buildAnubisHandler(undefined)).toBeNull();
  });
});

describe('placement', () => {
  it('comes after the WAF and HSTS, before path rules and redirects', async () => {
    const doc = await build('order.example.com', {
      anubis: ANUBIS,
      waf: WAF,
      hstsEnabled: true,
      pathBlocks: [{ path: '/private/*', status: 403 }],
      redirects: [{ from: '/old', to: '/new', status: 301 }],
    });
    const chains = chainLabels(doc, UPSTREAM);
    expect(chains.length).toBeGreaterThan(0);
    for (const labels of chains) {
      const at = labels.indexOf('anubis');
      expect(at).toBeGreaterThan(labels.indexOf('waf'));
      expect(at).toBeGreaterThan(labels.indexOf('hsts'));
      // Path rules and redirects are the two subroutes after it.
      expect(labels.slice(at + 1).filter((l) => l === 'subroute')).toHaveLength(2);
      expect(at).toBeLessThan(labels.lastIndexOf('reverse_proxy'));
    }
  });

  it('runs before the forward-auth subrequest, so the two combine on one host', async () => {
    const doc = await build('both.example.com', {
      anubis: ANUBIS,
      forwardAuth: { enabled: true, provider: 'authelia', authUpstream: 'http://authelia:9091' },
    });
    const chains = chainsTo(doc, UPSTREAM);
    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) {
      const anubis = chain.findIndex((h) => JSON.stringify(h).includes('/.within.website/'));
      const auth = chain.findIndex(
        (h) => h.handler === 'reverse_proxy' && JSON.stringify(h.upstreams).includes('authelia'),
      );
      expect(anubis).toBeGreaterThanOrEqual(0);
      // Excluded paths carry no auth handler, but still get the challenge.
      if (auth >= 0) expect(anubis).toBeLessThan(auth);
    }
  });

  it('reaches location rules through the shared chain', async () => {
    const doc = await build('loc.example.com', {
      anubis: ANUBIS,
      locationRules: [{ path: '/app/*', upstreams: ['10.0.0.6:9000'] }],
    });
    for (const labels of chainLabels(doc, '10.0.0.6:9000')) {
      expect(labels).toContain('anubis');
    }
  });

  it('is never put on the dashboard host, even when its options carry it', async () => {
    await saveDashboardSettings({
      enabled: true,
      domain: 'cpm.example.com',
      tls: false,
      options: { ...EMPTY_DASHBOARD_HOST_OPTIONS, meta: JSON.stringify({ anubis: ANUBIS }) },
    });
    try {
      const json = JSON.stringify(await buildCaddyDocument());
      expect(json).toContain('cpm.example.com');
      expect(json).not.toContain('/.within.website/');
    } finally {
      await saveDashboardSettings({ enabled: false, domain: 'cpm.example.com', tls: false });
    }
  });

  it('is left out while off, and the settings are kept', async () => {
    const host = await createProxyHost(
      {
        name: 'off',
        domains: ['off.example.com'],
        upstreams: [UPSTREAM],
        anubis: { ...ANUBIS, enabled: false, exemptPaths: ['/api/*'] },
      },
      1,
    );
    expect(JSON.stringify(await buildCaddyDocument())).not.toContain('/.within.website/');
    expect(host.anubis).toEqual({
      enabled: false,
      upstream: 'http://anubis:8923',
      exemptPaths: ['/api/*'],
    });
  });
});

describe('the model', () => {
  const create = (anubis: Record<string, unknown>) =>
    createProxyHost(
      { name: 'm', domains: ['m.example.com'], upstreams: [UPSTREAM], anubis } as never,
      1,
    );

  it('refuses enabling it without an upstream', async () => {
    await expect(create({ enabled: true })).rejects.toMatchObject({
      code: 'hostAnubisUpstreamRequired',
    });
  });

  it('refuses an upstream that is not an http or https URL', async () => {
    for (const upstream of ['ftp://anubis:21', 'anubis:8923', 'http://u:p@anubis:8923']) {
      await expect(create({ enabled: true, upstream })).rejects.toMatchObject({
        code: 'hostAnubisUpstreamInvalid',
      });
    }
  });

  it('refuses exempt paths that are relative, hold a placeholder, or are too many', async () => {
    for (const path of ['api/*', '/api/{http.request.host}', '/a b']) {
      await expect(create({ ...ANUBIS, exemptPaths: [path] })).rejects.toMatchObject({
        code: 'hostAnubisExemptPathInvalid',
      });
    }
    const many = Array.from({ length: ANUBIS_EXEMPT_PATHS_MAX + 1 }, (_, i) => `/p${i}`);
    await expect(create({ ...ANUBIS, exemptPaths: many })).rejects.toMatchObject({
      code: 'hostAnubisExemptPathsTooMany',
    });
  });

  it('forgets it on null and keeps it when an update leaves it out', async () => {
    const host = await create({ ...ANUBIS, exemptPaths: ['/api/*', '/api/*'] });
    expect(host.anubis?.exemptPaths).toEqual(['/api/*']);
    const kept = await updateProxyHost(host.id, { name: 'renamed' }, 1);
    expect(kept?.anubis?.enabled).toBe(true);
    const cleared = await updateProxyHost(host.id, { anubis: null }, 1);
    expect(cleared?.anubis).toBeNull();
  });
});

describe('the form', () => {
  it('reads the card only when it was rendered', () => {
    expect(parseProxyHostOptionUpdates(new FormData()).anubis).toBeUndefined();
    const form = new FormData();
    form.set('anubisPresent', '1');
    form.set('anubisEnabled', 'on');
    form.set('anubisUpstream', ' http://anubis:8923 ');
    form.set('anubisExemptPaths', '/api/*\n/feed.xml, /hooks/*');
    expect(parseProxyHostOptionUpdates(form).anubis).toEqual({
      enabled: true,
      upstream: 'http://anubis:8923',
      exemptPaths: ['/api/*', '/feed.xml', '/hooks/*'],
    });
  });
});
