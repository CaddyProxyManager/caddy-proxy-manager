/**
 * CrowdSec in a built document: the app only when configured and compiled in, the handler's place
 * in every chain, per-host opt-out, the L4 guard, and the bouncer key kept out of everything but
 * the document Caddy loads.
 */
import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
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

import { setCaddyAdminTransport } from '../../src/lib/caddy-admin';
import { buildCaddyDocument } from '../../src/lib/caddy';
import { findModuleConflicts } from '../../src/lib/caddy-build-conflicts';
import { CADDY_MODULES, CROWDSEC_MODULE_ID } from '../../src/lib/caddy-modules';
import {
  getCaddyBuildSettings,
  getCrowdSecSettings,
  getSetting,
  saveCaddyBuildSettings,
  saveCrowdSecSettings,
  setSetting,
} from '../../src/lib/settings';
import { MANAGED_CROWDSEC_API_URL, MANAGED_CROWDSEC_APPSEC_URL } from '../../src/lib/crowdsec';
import { decryptSecret, encryptSecret } from '../../src/lib/secret';
import { readSettingsGroup, saveSettingsGroup } from '../../src/lib/settings-api';
import { diffConfigDocuments } from '../../src/lib/settings/config-diff';
import { resolvers } from '../../src/lib/graphql/resolvers';
import type { GraphQLContext } from '../../src/lib/graphql/context';
import { createProxyHost, getProxyHost, updateProxyHost } from '../../src/lib/models/proxy-hosts';
import { DomainError } from '../../src/lib/domain-error';
import { startFakeAgent } from '../helpers/fake-agent';
import { chainLabels, chainsTo, handlerLabel } from '../helpers/host-chains';
import * as schema from '../../src/lib/db/schema';

const NOW = new Date().toISOString();
const UPSTREAM = '10.0.0.5:8080';
const OTHER_UPSTREAM = '10.0.0.6:9000';
const KEY = 'crowdsec-bouncer-key-9f3a';
const ALL_MODULE_PATHS = CADDY_MODULES.map((m) => m.modulePath);
const CROWDSEC_PATH = CADDY_MODULES.find((m) => m.id === CROWDSEC_MODULE_ID)!.modulePath;

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
const RATE_LIMIT = {
  enabled: true,
  zones: [{ paths: [], maxEvents: 10, window: '1m', key: 'ip' as const, ipv6Prefix: null }],
};

type Doc = { apps: Record<string, unknown> };
type Route = { match?: Record<string, unknown>[]; handle: Record<string, unknown>[] };

let agent: Awaited<ReturnType<typeof startFakeAgent>>;

async function withModules(applied: string[], disabledIds: string[] = []) {
  agent.state.appliedModules = applied;
  await saveCaddyBuildSettings({
    modules: Object.fromEntries(CADDY_MODULES.map((m) => [m.id, !disabledIds.includes(m.id)])),
    customModules: [],
  });
}

async function configure(overrides: Record<string, unknown> = {}) {
  await saveCrowdSecSettings({
    enabled: true,
    apiUrl: 'http://crowdsec:8080',
    apiKey: KEY,
    ...overrides,
  });
}

async function create(domain: string, options: Record<string, unknown> = {}) {
  return createProxyHost({ name: domain, domains: [domain], upstreams: [UPSTREAM], ...options }, 1);
}

async function document(): Promise<Doc> {
  return (await buildCaddyDocument()) as Doc;
}

beforeEach(async () => {
  agent = await startFakeAgent();
  setCaddyAdminTransport(async () => ({ status: 200, text: '{}', headers: {} }));
  await ctx.db.delete(schema.l4ProxyHosts);
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

describe('the crowdsec app', () => {
  it('carries the decrypted key once configured and compiled in', async () => {
    await withModules(ALL_MODULE_PATHS);
    await configure();
    const doc = await document();
    expect(doc.apps.crowdsec).toEqual({
      api_url: 'http://crowdsec:8080',
      api_key: KEY,
      ticker_interval: '60s',
      enable_streaming: true,
      enable_hard_fails: false,
    });
  });

  it('is left out, with every handler, while the module is not compiled in', async () => {
    await withModules(ALL_MODULE_PATHS.filter((p) => p !== CROWDSEC_PATH));
    await configure();
    await create('unbuilt.example.com');
    const json = JSON.stringify(await document());
    expect(json).not.toContain('"crowdsec"');
    expect(json).not.toContain(KEY);
  });

  it('is left out once the module is deselected', async () => {
    await withModules(ALL_MODULE_PATHS, [CROWDSEC_MODULE_ID]);
    await configure();
    expect((await document()).apps.crowdsec).toBeUndefined();
  });

  it('is left out while switched off', async () => {
    await withModules(ALL_MODULE_PATHS);
    await configure({ enabled: false });
    await create('off.example.com');
    const json = JSON.stringify(await document());
    expect(json).not.toContain('"crowdsec"');
    expect(json).not.toContain(KEY);
  });
});

describe('the handler chain', () => {
  it('runs crowdsec, rate_limit, blocker, appsec and the WAF in that order', async () => {
    await withModules(ALL_MODULE_PATHS);
    await configure({ appsecUrl: 'http://crowdsec:7422' });
    await create('order.example.com', {
      allowWebsocket: false,
      rateLimit: RATE_LIMIT,
      geoblock: GEOBLOCK,
      geoblockMode: 'override',
      waf: WAF,
    });
    const all = chainLabels(await document(), UPSTREAM);
    expect(all.length).toBeGreaterThan(0);
    for (const labels of all) {
      const order = [
        'ws-refuse',
        'encode',
        'crowdsec',
        'rate_limit',
        'blocker',
        'appsec',
        'waf',
      ].map((label) => labels.indexOf(label));
      expect(order.every((index) => index >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
  });

  it('keeps every gate of a host that has them all in the one order', async () => {
    await withModules(ALL_MODULE_PATHS);
    await configure({ appsecUrl: 'http://crowdsec:7422' });
    const [list] = await ctx.db
      .insert(schema.accessLists)
      .values({ name: 'staff', createdAt: NOW, updatedAt: NOW })
      .returning();
    await ctx.db.insert(schema.accessListEntries).values({
      accessListId: list.id,
      username: 'staff',
      passwordHash: '$2a$10$abcdefghijklmnopqrstuuM2Y0yJ7zGgNnLkJ3a6Yb5Wm0F2e1u6',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const everything = {
      allowWebsocket: false,
      hstsEnabled: true,
      compression: 'on',
      discourageIndexing: true,
      maintenance: { enabled: true, bypassCidrs: ['10.0.0.0/8'] },
      rateLimit: RATE_LIMIT,
      geoblock: GEOBLOCK,
      geoblockMode: 'override',
      waf: WAF,
      anubis: { enabled: true, upstream: 'http://anubis:8923' },
      pathBlocks: [{ path: '/private/*', status: 403 }],
      redirects: [{ from: '/old', to: '/new', status: 301 }],
      accessListId: list.id,
    };
    const label = (handler: Record<string, unknown>) => {
      const json = JSON.stringify(handler);
      if (handler.handler === 'subroute' && json.includes('"/private/*"')) return 'path-rules';
      if (handler.handler === 'subroute' && json.includes('"/old"')) return 'redirects';
      if (handler.handler === 'authentication') return 'access-list';
      if (handler.handler === 'headers' && json.includes('"Authorization"')) return 'drop-basic';
      if (handler.handler === 'headers' && json.includes('"Remote-User"')) return 'strip-remote';
      if (handler.handler === 'reverse_proxy' && json.includes('authelia')) return 'forward-auth';
      if (handler.handler === 'reverse_proxy') return 'proxy';
      return handlerLabel(handler);
    };
    const gates = [
      'ws-refuse',
      'maintenance',
      'encode',
      'crowdsec',
      'rate_limit',
      'blocker',
      'appsec',
      'waf',
      'hsts',
      'x-robots-tag',
      'robots',
      'anubis',
      'path-rules',
      'redirects',
      'access-list',
      'drop-basic',
    ];

    await create('all.example.com', everything);
    const plain = chainsTo(await document(), UPSTREAM);
    expect(plain).toHaveLength(1);
    expect(plain[0].map(label)).toEqual([...gates, 'proxy']);

    await ctx.db.delete(schema.proxyHosts);
    await create('all-fa.example.com', {
      ...everything,
      forwardAuth: { enabled: true, provider: 'authelia', authUpstream: 'http://authelia:9091' },
    });
    const withAuth = chainsTo(await document(), UPSTREAM);
    expect(withAuth).toHaveLength(1);
    expect(withAuth[0].map(label)).toEqual(['strip-remote', ...gates, 'forward-auth', 'proxy']);
  });

  it('runs once, ahead of the auth subrequest, on a forward-auth host', async () => {
    await withModules(ALL_MODULE_PATHS);
    await configure();
    await create('fa.example.com', {
      forwardAuth: { enabled: true, provider: 'authelia', authUpstream: 'http://authelia:9091' },
    });
    const all = chainLabels(await document(), UPSTREAM);
    expect(all.length).toBeGreaterThan(0);
    for (const labels of all) {
      expect(labels.filter((label) => label === 'crowdsec')).toHaveLength(1);
      expect(labels.indexOf('crowdsec')).toBeLessThan(labels.indexOf('reverse_proxy'));
    }
  });

  it('adds no appsec handler without an AppSec address', async () => {
    await withModules(ALL_MODULE_PATHS);
    await configure();
    await create('plain.example.com');
    for (const labels of chainLabels(await document(), UPSTREAM)) {
      expect(labels).toContain('crowdsec');
      expect(labels).not.toContain('appsec');
    }
  });

  it('skips a host that opted out, and only that host', async () => {
    await withModules(ALL_MODULE_PATHS);
    await configure();
    await create('out.example.com', { crowdsec: false });
    await createProxyHost(
      { name: 'in', domains: ['in.example.com'], upstreams: [OTHER_UPSTREAM] },
      1,
    );
    const doc = await document();
    for (const labels of chainLabels(doc, UPSTREAM)) expect(labels).not.toContain('crowdsec');
    for (const labels of chainLabels(doc, OTHER_UPSTREAM)) expect(labels).toContain('crowdsec');
  });

  it('keeps the opt-out across an edit that does not touch it, and drops it when turned on', async () => {
    const host = await create('keep.example.com', { crowdsec: false });
    expect((await getProxyHost(host.id))?.crowdsec).toBe(false);
    await updateProxyHost(host.id, { name: 'renamed' }, 1);
    expect((await getProxyHost(host.id))?.crowdsec).toBe(false);
    await updateProxyHost(host.id, { crowdsec: true }, 1);
    const [row] = await ctx.db.select().from(schema.proxyHosts);
    expect(row.meta ?? '').not.toContain('crowdsec');
  });

  it('reaches location rules through the shared chain', async () => {
    await withModules(ALL_MODULE_PATHS);
    await configure();
    await create('loc.example.com', {
      locationRules: [{ path: '/api/*', upstreams: [OTHER_UPSTREAM] }],
    });
    const chains = chainsTo(await document(), OTHER_UPSTREAM);
    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) {
      expect(chain.some((handler) => handler.handler === 'crowdsec')).toBe(true);
    }
  });
});

async function insertL4Host(meta: Record<string, unknown> | null, proxyProtocolReceive: boolean) {
  await ctx.db.insert(schema.l4ProxyHosts).values({
    name: 'db',
    protocol: 'tcp',
    listenAddress: ':5432',
    upstreams: JSON.stringify(['db:5432']),
    matcherType: 'none',
    matcherValue: null,
    tlsTermination: false,
    proxyProtocolVersion: null,
    proxyProtocolReceive,
    meta: meta ? JSON.stringify(meta) : null,
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function l4Routes(): Promise<Route[]> {
  const doc = (await document()) as {
    apps: { layer4?: { servers: Record<string, { routes: Route[] }> } };
  };
  const servers = Object.values(doc.apps.layer4?.servers ?? {});
  expect(servers).toHaveLength(1);
  return servers[0].routes;
}

describe('L4 hosts', () => {
  it('close a banned client before the proxy', async () => {
    await withModules(ALL_MODULE_PATHS);
    await configure();
    await insertL4Host(null, false);
    const routes = await l4Routes();
    expect(routes).toHaveLength(2);
    expect(routes[0]).toEqual({
      match: [{ not: [{ crowdsec: {} }] }],
      handle: [{ handler: 'close' }],
    });
    expect(routes[1].handle.map((h) => h.handler)).toEqual(['proxy']);
  });

  it('check the client behind PROXY protocol, inside the subroute', async () => {
    await withModules(ALL_MODULE_PATHS);
    await configure();
    await insertL4Host(null, true);
    const routes = await l4Routes();
    expect(routes).toHaveLength(1);
    expect(routes[0].handle[0]).toEqual({ handler: 'proxy_protocol' });
    const inner = routes[0].handle[1].routes as Route[];
    expect(inner[0]).toEqual({
      match: [{ not: [{ crowdsec: {} }] }],
      handle: [{ handler: 'close' }],
    });
  });

  it('skip a host that opted out', async () => {
    await withModules(ALL_MODULE_PATHS);
    await configure();
    await insertL4Host({ crowdsec: { enabled: false } }, false);
    const routes = await l4Routes();
    expect(JSON.stringify(routes)).not.toContain('crowdsec');
  });
});

describe('the bouncer key', () => {
  it('is stored encrypted', async () => {
    await configure();
    const stored = await getSetting<{ apiKey: string }>('crowdsec');
    expect(stored?.apiKey.startsWith('enc:v1:')).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(KEY);
  });

  it('is withheld from REST and GraphQL reads', async () => {
    await configure();
    const read = await readSettingsGroup('crowdsec');
    expect(read?.sensitive).toBe(true);
    expect(read?.value).toMatchObject({ hasApiKey: true, apiUrl: 'http://crowdsec:8080' });
    expect(JSON.stringify(read)).not.toContain(KEY);
    expect(JSON.stringify(read)).not.toContain('enc:v1:');
  });

  it('is masked in the config diff the review sheet and revisions render', async () => {
    await withModules(ALL_MODULE_PATHS);
    await configure();
    const diff = diffConfigDocuments({}, await document());
    const text = diff.lines.map((line) => line.text).join('\n');
    expect(text).toContain('"api_key": "********"');
    expect(text).not.toContain(KEY);
  });

  it('appears in no read-back surface, external or managed', async () => {
    await withModules(ALL_MODULE_PATHS);
    const admin = {
      viewer: async () => ({ role: 'admin', userId: 1 }),
    } as unknown as GraphQLContext;
    const surfaces = async () => {
      const stored = await getSetting('crowdsec');
      return [
        JSON.stringify(await readSettingsGroup('crowdsec')),
        JSON.stringify(await resolvers.Query.settings(null, { group: 'crowdsec' }, admin)),
        diffConfigDocuments({}, await document())
          .lines.map((line) => line.text)
          .join('\n'),
        // What a revision renders for the stored row.
        diffConfigDocuments({}, stored as Record<string, unknown>)
          .lines.map((line) => line.text)
          .join('\n'),
      ];
    };

    await configure();
    for (const text of await surfaces()) expect(text).not.toContain(KEY);

    await saveCrowdSecSettings({ enabled: true, mode: 'managed' });
    const managedKey = decryptSecret((await getCrowdSecSettings()).managedApiKey);
    expect(managedKey).toMatch(/^[0-9a-f]{64}$/);
    // Caddy does get it, so the check below is not vacuous.
    expect(JSON.stringify(await document())).toContain(managedKey);
    for (const text of await surfaces()) {
      expect(text).not.toContain(managedKey);
      expect(text).not.toContain(KEY);
    }
  });

  it('survives a REST write that omits it, but not one that moves the address', async () => {
    await withModules(ALL_MODULE_PATHS);
    await configure();
    await saveSettingsGroup('crowdsec', {
      enabled: true,
      apiUrl: 'http://crowdsec:8080',
      tickerInterval: '30s',
    });
    const kept = await getCrowdSecSettings();
    expect(kept.tickerInterval).toBe('30s');
    expect(kept.apiKey).not.toBe('');

    let error: unknown;
    try {
      await saveSettingsGroup('crowdsec', {
        enabled: true,
        apiUrl: 'https://elsewhere.example.com',
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('crowdsecApiKeyReenter');
    expect((await getCrowdSecSettings()).apiUrl).toBe('http://crowdsec:8080');
  });
});

describe('managed mode', () => {
  type Logging = { logs: Record<string, { encoder: { format: string } }> };
  const logging = (doc: Doc) => (doc as unknown as { logging: Logging }).logging.logs;

  async function pair(agentId: string): Promise<number> {
    const [row] = await ctx.db
      .insert(schema.agents)
      .values({
        name: agentId,
        agentId,
        secret: encryptSecret('a'.repeat(64)),
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning({ id: schema.agents.id });
    return row.id;
  }

  beforeEach(async () => {
    await ctx.db.delete(schema.agents);
  });

  it('points the bouncer at the container with a key it generated', async () => {
    await withModules(ALL_MODULE_PATHS);
    await saveCrowdSecSettings({ enabled: true, mode: 'managed', managedAppsec: true });
    const stored = await getCrowdSecSettings();
    expect(stored.managedApiKey.startsWith('enc:v1:')).toBe(true);
    const key = decryptSecret(stored.managedApiKey, 'test');
    expect(key).toMatch(/^[0-9a-f]{64}$/);

    const app = (await document()).apps.crowdsec as Record<string, unknown>;
    expect(app.api_url).toBe(MANAGED_CROWDSEC_API_URL);
    expect(app.api_key).toBe(key);
    expect(app.appsec_url).toBe(MANAGED_CROWDSEC_APPSEC_URL);
  });

  it('keeps the key across saves, one naming another key and a spell in external', async () => {
    await saveCrowdSecSettings({ enabled: true, mode: 'managed' });
    const first = (await getCrowdSecSettings()).managedApiKey;
    await saveCrowdSecSettings({ enabled: true, mode: 'managed', onlineApi: true });
    await saveCrowdSecSettings({ enabled: false, mode: 'external' });
    await saveCrowdSecSettings({ enabled: true, mode: 'managed', managedApiKey: 'mine' });
    expect((await getCrowdSecSettings()).managedApiKey).toBe(first);
    await expect(
      saveSettingsGroup('crowdsec', { enabled: true, mode: 'managed', managedApiKey: 'mine' }),
    ).rejects.toThrow();
  });

  it('never returns the key over REST', async () => {
    await saveCrowdSecSettings({ enabled: true, mode: 'managed' });
    const plain = decryptSecret((await getCrowdSecSettings()).managedApiKey, 'test');
    const read = await readSettingsGroup('crowdsec');
    expect(read?.value).toMatchObject({ mode: 'managed', hasApiKey: false });
    expect(read?.value).not.toHaveProperty('managedApiKey');
    expect(JSON.stringify(read)).not.toContain(plain);
    expect(JSON.stringify(read)).not.toContain('enc:v1:');
  });

  it('forces the access log on, as JSON, whatever Logging says', async () => {
    await setSetting('logging', { enabled: false, format: 'console' });
    expect(logging(await document()).http_access).toBeUndefined();

    await saveCrowdSecSettings({ enabled: true, mode: 'managed' });
    expect(logging(await document()).http_access?.encoder.format).toBe('json');

    // An external CrowdSec reads the log elsewhere, if at all: the operator's choice stands.
    await saveCrowdSecSettings({ enabled: true, apiUrl: 'http://crowdsec:8080', apiKey: KEY });
    expect(logging(await document()).http_access).toBeUndefined();
  });

  it('gives an agent other than the bundled one no LAPI and no forced log', async () => {
    await withModules(ALL_MODULE_PATHS);
    await setSetting('logging', { enabled: false });
    const bundled = await pair('bundled-agent');
    const remote = await pair('remote-agent');
    await setSetting('agent_bootstrap_agent_id', 'bundled-agent');
    await saveCrowdSecSettings({ enabled: true, mode: 'managed' });

    const forRemote = (await buildCaddyDocument(remote)) as Doc;
    expect(forRemote.apps.crowdsec).toBeUndefined();
    expect(logging(forRemote).http_access).toBeUndefined();
    expect(logging((await buildCaddyDocument(bundled)) as Doc).http_access).toBeDefined();
  });
});

describe('the Caddy Build page', () => {
  it('refuses dropping the module while CrowdSec is switched on', async () => {
    await withModules(ALL_MODULE_PATHS);
    await configure();
    const settings = await getCaddyBuildSettings();
    const without = {
      ...settings!,
      modules: { ...settings!.modules, [CROWDSEC_MODULE_ID]: false },
    };
    expect(await findModuleConflicts(without)).toContainEqual({ kind: 'globalCrowdsec' });
    await configure({ enabled: false });
    expect(await findModuleConflicts(without)).not.toContainEqual({ kind: 'globalCrowdsec' });
  });
});
