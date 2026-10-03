/**
 * Caddy validates a posted config as one document, so a handler naming an absent module takes every
 * host offline and must not appear at all. An unadaptable Caddyfile snippet is skipped.
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

import { setCaddyAdminTransport, type CaddyAdminRequest } from '../../src/lib/caddy-admin';
import { buildCaddyDocument } from '../../src/lib/caddy';
import { CADDY_MODULES } from '../../src/lib/caddy-modules';
import {
  saveCaddyBuildSettings,
  saveGeoBlockSettings,
  saveHttpCacheSettings,
  saveWafSettings,
  type GeoBlockSettings,
} from '../../src/lib/settings';
import { createProxyHost } from '../../src/lib/models/proxy-hosts';
import { createL4ProxyHost } from '../../src/lib/models/l4-proxy-hosts';
import { startFakeAgent } from '../helpers/fake-agent';
import * as schema from '../../src/lib/db/schema';

type FakeAgent = Awaited<ReturnType<typeof startFakeAgent>>;
let agent: FakeAgent;

const ALL_MODULE_PATHS = CADDY_MODULES.map((m) => m.modulePath);

const GEOBLOCK: GeoBlockSettings = {
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

/** The agent's *applied* set, reported only after a build succeeds - not the selection. */
function setAppliedModules(specs: string[]) {
  agent.state.appliedModules = specs;
}

async function selectAllModulesExcept(...disabledIds: string[]) {
  await saveCaddyBuildSettings({
    modules: Object.fromEntries(CADDY_MODULES.map((m) => [m.id, !disabledIds.includes(m.id)])),
    customModules: [],
  });
}

let adaptRequests: CaddyAdminRequest[] = [];

/** Answer /adapt with one static_response route; other paths behave as Caddy would. */
function installAdapter(options: { failAdapt?: boolean } = {}) {
  adaptRequests = [];
  setCaddyAdminTransport(async (request) => {
    if (request.path === '/adapt') {
      adaptRequests.push(request);
      if (options.failAdapt) {
        return {
          status: 400,
          text: JSON.stringify({ error: 'unrecognized directive: madeup' }),
          headers: {},
        };
      }
      return {
        status: 200,
        text: JSON.stringify({
          result: {
            apps: {
              http: {
                servers: {
                  srv0: {
                    routes: [
                      {
                        match: [{ path: ['/status*'] }],
                        handle: [{ handler: 'static_response', body: 'ok' }],
                      },
                    ],
                  },
                },
              },
            },
          },
        }),
        headers: {},
      };
    }
    return { status: 200, text: '{}', headers: {} };
  });
}

function handlerNames(document: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      if (typeof record.handler === 'string') found.push(record.handler);
      Object.values(record).forEach(walk);
    }
  };
  walk(document);
  return found;
}

beforeEach(async () => {
  agent = await startFakeAgent();
  installAdapter();
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.l4ProxyHosts);
  await ctx.db.delete(schema.settings);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

afterEach(async () => {
  await agent.stop();
});

async function createHost(overrides: Record<string, unknown> = {}) {
  return await createProxyHost(
    {
      name: 'app',
      domains: ['app.example.com'],
      upstreams: ['backend:8080'],
      ...overrides,
    } as never,
    1,
  );
}

describe('geoblock gating', () => {
  it('emits the blocker handler when the module is selected and built', async () => {
    setAppliedModules(ALL_MODULE_PATHS);
    await selectAllModulesExcept();
    await saveGeoBlockSettings(GEOBLOCK);
    await createHost();

    expect(handlerNames(await buildCaddyDocument())).toContain('blocker');
  });

  it('omits the blocker handler once the module is deselected', async () => {
    setAppliedModules(ALL_MODULE_PATHS);
    await selectAllModulesExcept('caddy-blocker');
    await saveGeoBlockSettings(GEOBLOCK);
    await createHost();

    expect(handlerNames(await buildCaddyDocument())).not.toContain('blocker');
  });

  it('omits the blocker handler when it is selected but not yet compiled in', async () => {
    // Only a rebuild puts a module in the binary; emitting it before would fail the whole config.
    setAppliedModules(ALL_MODULE_PATHS.filter((p) => !p.includes('caddy-blocker-plugin')));
    await selectAllModulesExcept();
    await saveGeoBlockSettings(GEOBLOCK);
    await createHost();

    expect(handlerNames(await buildCaddyDocument())).not.toContain('blocker');
  });

  it('leaves the rest of the host config intact when geoblocking is dropped', async () => {
    setAppliedModules(ALL_MODULE_PATHS);
    await selectAllModulesExcept('caddy-blocker');
    await saveGeoBlockSettings(GEOBLOCK);
    await createHost();

    // The point of gating rather than failing: unrelated hosts keep serving.
    expect(handlerNames(await buildCaddyDocument())).toContain('reverse_proxy');
  });
});

describe('WAF gating', () => {
  const WAF = {
    enabled: true,
    mode: 'On' as const,
    load_owasp_crs: true,
    custom_directives: '',
  };

  it('emits the waf handler when Coraza is selected and built', async () => {
    setAppliedModules(ALL_MODULE_PATHS);
    await selectAllModulesExcept();
    await saveWafSettings(WAF);
    await createHost();

    expect(handlerNames(await buildCaddyDocument())).toContain('waf');
  });

  it('omits the waf handler once Coraza is deselected', async () => {
    setAppliedModules(ALL_MODULE_PATHS);
    await selectAllModulesExcept('coraza-waf');
    await saveWafSettings(WAF);
    await createHost();

    expect(handlerNames(await buildCaddyDocument())).not.toContain('waf');
  });
});

describe('cache gating', () => {
  const CACHE = { cache: { mode: 'caddy', maxAge: 3600 } };

  it('emits the cache handler when cache-handler is selected and built', async () => {
    setAppliedModules(ALL_MODULE_PATHS);
    await selectAllModulesExcept();
    await createHost(CACHE);

    expect(handlerNames(await buildCaddyDocument())).toContain('cache');
  });

  it('falls back to browser caching while the opt-in module is not compiled in', async () => {
    // Selected but not rebuilt: the shipped image lacks it.
    setAppliedModules(ALL_MODULE_PATHS.filter((p) => !p.includes('cache-handler')));
    await selectAllModulesExcept();
    await createHost(CACHE);

    const document = await buildCaddyDocument();
    expect(handlerNames(document)).not.toContain('cache');
    expect(JSON.stringify(document)).toContain('max-age=3600');
  });
});

describe('cache storage gating', () => {
  const REDIS = {
    storage: 'redis',
    redis: { addresses: ['redis:6379'], password: 'hunter2' },
  };
  const cacheApp = async () =>
    ((await buildCaddyDocument()) as { apps: Record<string, unknown> }).apps.cache as
      | Record<string, unknown>
      | undefined;

  it('points the cache at Redis once both modules are built, with the password decrypted', async () => {
    setAppliedModules(ALL_MODULE_PATHS);
    await selectAllModulesExcept();
    await saveHttpCacheSettings(REDIS);

    const stored = await ctx.db.select().from(schema.settings);
    const row = JSON.stringify(stored.find((r) => r.key === 'http_cache'));
    expect(row).not.toContain('hunter2');
    expect(row).toContain('enc:v1:');

    const app = await cacheApp();
    expect(app?.redis).toMatchObject({
      found: true,
      configuration: { InitAddress: ['redis:6379'], Password: 'hunter2' },
    });
  });

  it('keeps the stored key when the form sends it blank, and refuses a CDN without one', async () => {
    const cdn = { provider: 'fastly', serviceId: 'svc' };
    await expect(saveHttpCacheSettings({ cdn })).rejects.toThrow(
      /Fastly purging needs an API token/,
    );
    await saveHttpCacheSettings({ cdn: { ...cdn, apiKey: 'fastly-key' } });
    await saveHttpCacheSettings({ cdn: { ...cdn, strategy: 'hard' } });

    setAppliedModules(ALL_MODULE_PATHS);
    await selectAllModulesExcept();
    expect((await cacheApp())?.cdn).toEqual({
      provider: 'fastly',
      api_key: 'fastly-key',
      service_id: 'svc',
      strategy: 'hard',
    });
  });

  it('leaves the storage out until its own module is compiled in', async () => {
    setAppliedModules(ALL_MODULE_PATHS.filter((p) => !p.includes('storages/redis')));
    await selectAllModulesExcept();
    await saveHttpCacheSettings(REDIS);

    expect(await cacheApp()).toBeUndefined();
  });

  it('emits no cache app without HTTP Cache itself', async () => {
    setAppliedModules(ALL_MODULE_PATHS);
    await selectAllModulesExcept('cache-handler');
    await saveHttpCacheSettings(REDIS);

    expect(await cacheApp()).toBeUndefined();
  });
});

describe('layer 4 gating', () => {
  beforeEach(async () => {
    await createL4ProxyHost(
      {
        name: 'db',
        listenAddress: ':5432',
        protocol: 'tcp',
        upstreams: ['db:5432'],
        matcherType: 'none',
        matcherValue: [],
      } as never,
      1,
    );
  });

  it('emits the layer4 app when caddy-l4 is selected and built', async () => {
    setAppliedModules(ALL_MODULE_PATHS);
    await selectAllModulesExcept();

    const document = (await buildCaddyDocument()) as { apps: Record<string, unknown> };
    expect(document.apps.layer4).toBeDefined();
  });

  it('omits the whole layer4 app once caddy-l4 is deselected', async () => {
    // Without the plugin there is no `layer4` to unmarshal, so the key must be absent entirely.
    setAppliedModules(ALL_MODULE_PATHS);
    await selectAllModulesExcept('caddy-l4');

    const document = (await buildCaddyDocument()) as { apps: Record<string, unknown> };
    expect(document.apps.layer4).toBeUndefined();
  });
});

describe('per-host Caddyfile', () => {
  it('adapts the snippet and nests it in a subroute before the reverse proxy', async () => {
    setAppliedModules(ALL_MODULE_PATHS);
    await selectAllModulesExcept();
    await createHost({ customCaddyfile: 'handle /status* {\n  respond "ok" 200\n}' });

    const document = await buildCaddyDocument();
    // Flattening would apply the adapted route's path matcher to every request.
    expect(handlerNames(document)).toContain('subroute');
    expect(handlerNames(document)).toContain('reverse_proxy');
    // static_response also appears in the HTTP-to-HTTPS redirect route.
    expect(JSON.stringify(document)).toContain('"body":"ok"');
  });

  it('skips a snippet that no longer adapts instead of failing the build', async () => {
    setAppliedModules(ALL_MODULE_PATHS);
    await selectAllModulesExcept();
    // Saved while it was valid, then the plugin it used was switched off.
    await createHost({ customCaddyfile: 'handle /status* {\n  respond "ok" 200\n}' });

    installAdapter({ failAdapt: true });
    const document = await buildCaddyDocument();

    // Nor may it block the very edit needed to fix it.
    expect(handlerNames(document)).toContain('reverse_proxy');
    expect(JSON.stringify(document)).not.toContain('"body":"ok"');
  });

  it('does not call the adapter for hosts without a snippet', async () => {
    setAppliedModules(ALL_MODULE_PATHS);
    await selectAllModulesExcept();
    await createHost();

    await buildCaddyDocument();
    expect(adaptRequests).toHaveLength(0);
  });
});
