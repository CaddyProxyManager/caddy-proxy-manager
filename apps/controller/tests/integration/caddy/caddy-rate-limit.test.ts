/** Rate limiting in a built document: its place in every chain, and absence without the module. */
import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { buildCaddyDocument } from '../../../src/lib/caddy';
import { CADDY_MODULES } from '../../../src/lib/caddy/image-build/modules';
import { saveCaddyBuildSettings } from '../../../src/lib/settings';
import { createProxyHost } from '../../../src/lib/models/proxy-hosts';
import { startFakeAgent } from '../../helpers/fake-agent';
import { chainLabels, chainsTo, type Handler } from '../../helpers/host-chains';
import type { HostRateLimitConfig } from '../../../src/lib/proxy-hosts/rate-limit';
import * as schema from '../../../src/lib/db/schema';

const NOW = new Date().toISOString();
const UPSTREAM = '10.0.0.5:8080';
const LOCATION_UPSTREAM = '10.0.0.6:9000';
const ALL_MODULE_PATHS = CADDY_MODULES.map((m) => m.modulePath);

const RATE_LIMIT: HostRateLimitConfig = {
  enabled: true,
  zones: [
    { paths: ['/login'], maxEvents: 10, window: '1m', key: 'ip', ipv6Prefix: 64 },
    { paths: [], maxEvents: 600, window: '1m', key: 'ip+path', ipv6Prefix: null },
  ],
};

const GEOBLOCK = {
  enabled: true,
  block_countries: ['RU'],
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
const WAF = { enabled: true, mode: 'On', load_owasp_crs: true, waf_mode: 'override' };

let agent: Awaited<ReturnType<typeof startFakeAgent>>;

async function withModules(applied: string[], disabledIds: string[] = []) {
  agent.state.appliedModules = applied;
  await saveCaddyBuildSettings({
    modules: Object.fromEntries(CADDY_MODULES.map((m) => [m.id, !disabledIds.includes(m.id)])),
    customModules: [],
  });
}

async function create(domain: string, options: Record<string, unknown> = {}) {
  return createProxyHost(
    { name: domain, domains: [domain], upstreams: [UPSTREAM], rateLimit: RATE_LIMIT, ...options },
    1,
  );
}

function rateLimitHandlers(doc: unknown, upstream = UPSTREAM): Handler[] {
  return chainsTo(doc, upstream).flatMap((chain) =>
    chain.filter((h) => h.handler === 'rate_limit'),
  );
}

beforeEach(async () => {
  agent = await startFakeAgent();
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.settings);
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

afterEach(async () => {
  await agent.stop();
});

describe('rate limiting in the document', () => {
  it('keys on the trusted-proxy-aware client IP and names zones after the host', async () => {
    await withModules(ALL_MODULE_PATHS);
    const host = await create('rl.example.com');
    const handlers = rateLimitHandlers(await buildCaddyDocument());
    expect(handlers.length).toBeGreaterThan(0);
    for (const handler of handlers) {
      expect(handler).toEqual({
        handler: 'rate_limit',
        rate_limits: {
          [`h${host.id}_0`]: {
            match: [{ path: ['/login'] }],
            key: '{http.vars.client_ip}',
            window: '1m',
            max_events: 10,
            ipv6_prefix: 64,
          },
          [`h${host.id}_1`]: {
            key: '{http.vars.client_ip} {http.request.uri.path}',
            window: '1m',
            max_events: 600,
          },
        },
      });
    }
  });

  it('gives two hosts distinct zone names', async () => {
    await withModules(ALL_MODULE_PATHS);
    await create('one.example.com');
    await createProxyHost(
      {
        name: 'two',
        domains: ['two.example.com'],
        upstreams: [LOCATION_UPSTREAM],
        rateLimit: RATE_LIMIT,
      },
      1,
    );
    const doc = await buildCaddyDocument();
    const zones = (upstream: string) =>
      rateLimitHandlers(doc, upstream).flatMap((h) =>
        Object.keys(h.rate_limits as Record<string, unknown>),
      );
    const first = new Set(zones(UPSTREAM));
    expect(zones(LOCATION_UPSTREAM).some((name) => first.has(name))).toBe(false);
  });

  it('runs after encode and ws-refuse, ahead of geo blocking and the WAF', async () => {
    await withModules(ALL_MODULE_PATHS);
    await create('order.example.com', {
      allowWebsocket: false,
      geoblock: GEOBLOCK,
      geoblockMode: 'override',
      waf: WAF,
    });
    const all = chainLabels(await buildCaddyDocument(), UPSTREAM);
    expect(all.length).toBeGreaterThan(0);
    for (const labels of all) {
      const rateLimit = labels.indexOf('rate_limit');
      expect(rateLimit).toBeGreaterThan(labels.indexOf('ws-refuse'));
      expect(rateLimit).toBeGreaterThan(labels.indexOf('encode'));
      expect(labels.indexOf('blocker')).toBeGreaterThan(rateLimit);
      expect(labels.indexOf('waf')).toBeGreaterThan(labels.indexOf('blocker'));
    }
  });

  it('runs ahead of the auth subrequest on a forward-auth host', async () => {
    await withModules(ALL_MODULE_PATHS);
    await create('fa.example.com', {
      forwardAuth: { enabled: true, provider: 'authelia', authUpstream: 'http://authelia:9091' },
    });
    const all = chainLabels(await buildCaddyDocument(), UPSTREAM);
    expect(all.length).toBeGreaterThan(0);
    for (const labels of all) {
      expect(labels.filter((label) => label === 'rate_limit')).toHaveLength(1);
      expect(labels.indexOf('rate_limit')).toBeLessThan(labels.indexOf('reverse_proxy'));
    }
  });

  it('reaches location rules through the shared chain', async () => {
    await withModules(ALL_MODULE_PATHS);
    await create('loc.example.com', {
      locationRules: [{ path: '/api/*', upstreams: [LOCATION_UPSTREAM] }],
    });
    const chains = chainsTo(await buildCaddyDocument(), LOCATION_UPSTREAM);
    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) {
      expect(chain.some((handler) => handler.handler === 'rate_limit')).toBe(true);
    }
  });

  it('declares no events app: Caddy loads the one the handler asks for', async () => {
    await withModules(ALL_MODULE_PATHS);
    await create('events.example.com');
    const doc = (await buildCaddyDocument()) as { apps: Record<string, unknown> };
    expect(doc.apps.events).toBeUndefined();
  });

  it('emits nothing while switched off', async () => {
    await withModules(ALL_MODULE_PATHS);
    await create('off.example.com', { rateLimit: { ...RATE_LIMIT, enabled: false } });
    expect(rateLimitHandlers(await buildCaddyDocument())).toEqual([]);
  });
});

describe('module gating', () => {
  it('omits the handler while the opt-in module is not compiled in', async () => {
    // Selected but not rebuilt: the shipped image lacks it.
    await withModules(ALL_MODULE_PATHS.filter((p) => !p.includes('caddy-ratelimit')));
    await create('unbuilt.example.com');
    expect(JSON.stringify(await buildCaddyDocument())).not.toContain('"rate_limit"');
  });

  it('omits the handler once the module is deselected', async () => {
    await withModules(ALL_MODULE_PATHS, ['caddy-ratelimit']);
    await create('deselected.example.com');
    expect(JSON.stringify(await buildCaddyDocument())).not.toContain('"rate_limit"');
  });
});
