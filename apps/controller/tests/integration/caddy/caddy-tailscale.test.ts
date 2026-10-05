/**
 * Which server a Tailscale host lands in (handler shapes are in the unit test). A tailnet-only
 * host must disappear without the plugin, never fall back to the public listener.
 */
import { describe, it, expect, afterEach, beforeEach, spyOn } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

// createTestDb is async and a Bun mock factory must be synchronous, so it is hoisted out.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { setCaddyAdminTransport } from '../../../src/lib/caddy/admin';
import { buildCaddyDocument } from '../../../src/lib/caddy';
import { CADDY_MODULES } from '../../../src/lib/caddy/image-build/modules';
import {
  saveCaddyBuildSettings,
  saveHttpProtocolsSettings,
  saveTailscaleSettings,
} from '../../../src/lib/settings';
import { createProxyHost } from '../../../src/lib/models/proxy-hosts';
import { startFakeAgent } from '../../helpers/fake-agent';
import * as schema from '../../../src/lib/db/schema';

type FakeAgent = Awaited<ReturnType<typeof startFakeAgent>>;
let agent: FakeAgent;

const ALL_MODULE_PATHS = CADDY_MODULES.map((m) => m.modulePath);
const TAILSCALE_PATH = 'github.com/tailscale/caddy-tailscale';

type CaddyDocument = {
  apps: {
    http?: { servers: Record<string, { listen: string[]; routes: unknown[] }> };
    tls?: { automation?: { policies: Record<string, unknown>[] } };
    tailscale?: Record<string, unknown>;
  };
};

function servers(document: CaddyDocument) {
  return document.apps.http?.servers ?? {};
}

/** Distinct, since one host contributes several routes. */
function matchedHosts(server: { routes: unknown[] } | undefined): string[] {
  const found = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      if (Array.isArray(record.host)) for (const host of record.host) found.add(host as string);
      Object.values(record).forEach(walk);
    }
  };
  walk(server?.routes ?? []);
  return [...found];
}

/** Narrowed rather than cast: `policy.subjects` is `unknown`. */
function subjectsOf(policy: Record<string, unknown>): string[] {
  return Array.isArray(policy.subjects) ? (policy.subjects as string[]) : [];
}

/** `some(===)`, not `includes`: an analyser reads that as a substring test over a hostname. */
function policyForSubject(
  policies: Record<string, unknown>[],
  subject: string,
): Record<string, unknown> | undefined {
  return policies.find((policy) => subjectsOf(policy).some((value) => value === subject));
}

function handlerNames(document: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      if (typeof record.handler === 'string') found.push(record.handler);
      Object.values(record).forEach(walk);
    }
  };
  walk(document);
  return found;
}

function setAppliedModules(specs: string[]) {
  agent.state.appliedModules = specs;
}

async function selectAllModulesExcept(...disabledIds: string[]) {
  await saveCaddyBuildSettings({
    modules: Object.fromEntries(CADDY_MODULES.map((m) => [m.id, !disabledIds.includes(m.id)])),
    customModules: [],
  });
}

const TAILSCALE_SETTINGS = {
  enabled: true,
  authKey: 'tskey-auth-abcDEF1CNTRL-secret',
  controlUrl: '',
  ephemeral: false,
  stateDir: '/data/tailscale',
  tags: ['tag:caddy'],
  defaultNode: 'caddy',
  validateAuthKey: false,
  apiAccessToken: '',
  apiTailnet: '-',
};

async function enableTailscale(overrides: Record<string, unknown> = {}) {
  await saveTailscaleSettings({ ...TAILSCALE_SETTINGS, ...overrides } as never);
}

beforeEach(async () => {
  agent = await startFakeAgent();
  setCaddyAdminTransport(async () => ({ status: 200, text: '{}', headers: {} }));
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
  setAppliedModules(ALL_MODULE_PATHS);
  await selectAllModulesExcept();
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

describe('serving a host on the tailnet', () => {
  it('gives the node its own server and keeps a tailnet-only host off the public one', async () => {
    await enableTailscale();
    await createHost({ tailscale: { serve: true, tailnetOnly: true } });

    const document = (await buildCaddyDocument()) as CaddyDocument;
    const all = servers(document);

    expect(all.cpm_tailscale_caddy?.listen).toEqual(['tailscale/caddy:80', 'tailscale/caddy:443']);
    expect(matchedHosts(all.cpm_tailscale_caddy)).toContain('app.example.com');
    // The point of "tailnet only": the public server does not carry the host at all.
    expect(matchedHosts(all.cpm)).not.toContain('app.example.com');
  });

  it('serves the host in both places when tailnet-only is off', async () => {
    await enableTailscale();
    await createHost({ tailscale: { serve: true, tailnetOnly: false } });

    const all = servers((await buildCaddyDocument()) as CaddyDocument);
    expect(matchedHosts(all.cpm_tailscale_caddy)).toContain('app.example.com');
    expect(matchedHosts(all.cpm)).toContain('app.example.com');
  });

  it('groups hosts sharing a node into one server, and separates different nodes', async () => {
    await enableTailscale();
    await createHost({ name: 'a', domains: ['a.example.com'], tailscale: { serve: true } });
    await createHost({
      name: 'b',
      domains: ['b.example.com'],
      tailscale: { serve: true, node: 'edge' },
    });
    await createHost({ name: 'c', domains: ['c.example.com'], tailscale: { serve: true } });

    const all = servers((await buildCaddyDocument()) as CaddyDocument);
    expect(matchedHosts(all.cpm_tailscale_caddy).sort()).toEqual([
      'a.example.com',
      'c.example.com',
    ]);
    expect(matchedHosts(all.cpm_tailscale_edge)).toEqual(['b.example.com']);
  });

  it('emits the tailscale app with the decrypted auth key', async () => {
    await enableTailscale();
    await createHost({ tailscale: { serve: true } });

    const document = (await buildCaddyDocument()) as CaddyDocument;
    expect(document.apps.tailscale).toEqual({
      auth_key: 'tskey-auth-abcDEF1CNTRL-secret',
      state_dir: '/data/tailscale',
      tags: ['tag:caddy'],
    });
  });

  it('omits the tailscale app when no host names a node', async () => {
    // Registering a node that serves nothing would put a machine on the tailnet for no reason.
    await enableTailscale();
    await createHost();

    expect((await buildCaddyDocument()) as CaddyDocument).not.toHaveProperty('apps.tailscale');
  });
});

describe('HTTP/3 on tailnet listeners', () => {
  type ServerWithProtocols = { protocols?: string[] };
  const protocolsOf = (document: CaddyDocument, name: string) =>
    (servers(document)[name] as ServerWithProtocols | undefined)?.protocols;

  it('leaves h3 off the tailnet server by default, and the public server alone', async () => {
    // An h3 listener brings the node up inside config load, which hangs while the control
    // server is unreachable and holds Caddy's admin API with it.
    await enableTailscale();
    await createHost({ tailscale: { serve: true, tailnetOnly: false } });

    const document = (await buildCaddyDocument()) as CaddyDocument;
    expect(protocolsOf(document, 'cpm_tailscale_caddy')).toEqual(['h1', 'h2']);
    expect(protocolsOf(document, 'cpm')).toBeUndefined();
  });

  it('follows Caddy default, h3 included, once the operator opts in', async () => {
    await enableTailscale({ http3: true });
    await createHost({ tailscale: { serve: true } });

    const document = (await buildCaddyDocument()) as CaddyDocument;
    expect(servers(document).cpm_tailscale_caddy).toBeDefined();
    expect(protocolsOf(document, 'cpm_tailscale_caddy')).toBeUndefined();
  });

  it('still honours HTTP/3 being off globally', async () => {
    await enableTailscale({ http3: true });
    await saveHttpProtocolsSettings({ http2: true, http3: false });
    await createHost({ tailscale: { serve: true, tailnetOnly: false } });

    const document = (await buildCaddyDocument()) as CaddyDocument;
    expect(protocolsOf(document, 'cpm_tailscale_caddy')).toEqual(['h1', 'h2']);
    expect(protocolsOf(document, 'cpm')).toEqual(['h1', 'h2']);
  });
});

describe('when Tailscale is not usable', () => {
  it('drops a tailnet-only host rather than publishing it', async () => {
    // Fail closed: the public listener would expose a deliberately private service.
    await enableTailscale();
    await createHost({ tailscale: { serve: true, tailnetOnly: true } });
    setAppliedModules(ALL_MODULE_PATHS.filter((path) => path !== TAILSCALE_PATH));

    const all = servers((await buildCaddyDocument()) as CaddyDocument);
    expect(Object.keys(all)).not.toContain('cpm_tailscale_caddy');
    expect(matchedHosts(all.cpm)).not.toContain('app.example.com');
  });

  it('keeps a dual-published host on the public listener', async () => {
    await enableTailscale();
    await createHost({ tailscale: { serve: true, tailnetOnly: false } });
    setAppliedModules(ALL_MODULE_PATHS.filter((path) => path !== TAILSCALE_PATH));

    const all = servers((await buildCaddyDocument()) as CaddyDocument);
    expect(Object.keys(all)).not.toContain('cpm_tailscale_caddy');
    expect(matchedHosts(all.cpm)).toContain('app.example.com');
  });

  it('emits nothing tailscale-shaped while the setting itself is off', async () => {
    // Configured first: the save-time gate refuses a tailnet host while no auth key exists.
    await enableTailscale();
    await createHost({ tailscale: { serve: true, tailnetOnly: false } });
    await enableTailscale({ enabled: false });

    const document = (await buildCaddyDocument()) as CaddyDocument;
    expect(document.apps.tailscale).toBeUndefined();
    expect(Object.keys(servers(document))).not.toContain('cpm_tailscale_caddy');
    expect(JSON.stringify(document)).not.toContain('tailscale/');
  });
});

describe('identity authentication', () => {
  it('gates the host on the tailscale provider', async () => {
    await enableTailscale();
    await createHost({ tailscale: { serve: true, auth: true } });

    const document = await buildCaddyDocument();
    expect(handlerNames(document)).toContain('authentication');
    expect(JSON.stringify(document)).toContain('"providers":{"tailscale":{}}');
  });

  it('strips client-supplied identity headers on every route, gated or not', async () => {
    // An excluded path authenticates nothing, so a caller could forge X-Tailscale-User.
    await enableTailscale();
    await createHost({
      tailscale: {
        serve: true,
        auth: true,
        forwardIdentity: true,
        excluded_paths: ['/healthz'],
      },
    });

    const server = servers((await buildCaddyDocument()) as CaddyDocument).cpm_tailscale_caddy;
    const routes = server.routes as { handle: Record<string, unknown>[] }[];
    // The HTTPS redirect route proxies nothing, so it has no header to strip.
    const proxying = routes.filter((route) =>
      JSON.stringify(route.handle).includes('"reverse_proxy"'),
    );
    expect(proxying.length).toBeGreaterThan(1);
    for (const route of proxying) {
      const first = route.handle[0] as { handler: string; request?: { delete?: string[] } };
      expect(first.handler).toBe('headers');
      expect(first.request?.delete).toContain('X-Tailscale-User');
    }
  });

  it('does not authenticate when the host is not served on the tailnet', async () => {
    // Without the listener the authenticator falls back to a tailscaled this image does not run.
    await enableTailscale();
    await createHost({ tailscale: { serve: false, auth: true } });

    expect(JSON.stringify(await buildCaddyDocument())).not.toContain('"tailscale":{}');
  });
});

describe('reaching an upstream over the tailnet', () => {
  it('replaces the reverse-proxy transport', async () => {
    await enableTailscale();
    await createHost({ tailscale: { upstreamNode: 'edge' } });

    expect(JSON.stringify(await buildCaddyDocument())).toContain(
      '"transport":{"protocol":"tailscale","name":"edge"}',
    );
  });

  it('keeps the TLS settings of an https upstream', async () => {
    await enableTailscale();
    await createHost({
      upstreams: ['https://backend.tail1234.ts.net'],
      skipHttpsHostnameValidation: true,
      tailscale: { upstreamNode: 'edge' },
    });

    expect(JSON.stringify(await buildCaddyDocument())).toContain(
      '"transport":{"protocol":"tailscale","name":"edge","tls":{"insecure_skip_verify":true}}',
    );
  });

  it('drops the transport timeouts but keeps the stream ones', async () => {
    await enableTailscale();
    await createHost({
      tailscale: { upstreamNode: 'edge' },
      upstreamTimeouts: { dialTimeout: '5s', readTimeout: '1m', streamTimeout: '1h' },
    });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const json = JSON.stringify(await buildCaddyDocument());
      expect(json).toContain('"transport":{"protocol":"tailscale","name":"edge"}');
      expect(json).not.toContain('dial_timeout');
      expect(json).not.toContain('read_timeout');
      expect(json).toContain('"stream_timeout":"1h"');
      expect(warn.mock.calls.some((call) => String(call[0]).includes('upstream timeouts'))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('serves nothing on a node it only dials through', async () => {
    // Registered (the transport needs its auth key) but unlistened; the plugin fork makes that
    // safe - see the replace directive in docker/caddy/go.mod.
    await enableTailscale();
    await createHost({ tailscale: { upstreamNode: 'edge' } });

    const document = (await buildCaddyDocument()) as CaddyDocument;
    expect(document.apps.tailscale).toBeDefined();
    expect(Object.keys(servers(document))).not.toContain('cpm_tailscale_edge');
    expect(JSON.stringify(document)).not.toContain('tailscale/edge');
  });
});

describe('the stored host config', () => {
  it('drops the identity gate when the host is not served on the tailnet', async () => {
    // Without a listener the authenticator has no tsnet server to ask.
    const host = await createHost({ tailscale: { serve: false, auth: true } });
    expect(host.tailscale).toBeNull();
  });

  it('defaults a newly served host to tailnet only', async () => {
    await enableTailscale();
    const host = await createHost({ tailscale: { serve: true } });
    expect(host.tailscale?.tailnetOnly).toBe(true);
  });

  it('keeps a dual-published host dual-published across a read', async () => {
    // Re-normalized on every read; the new-host default would pull it off the public listener.
    await enableTailscale();
    const host = await createHost({ tailscale: { serve: true, tailnetOnly: false } });
    expect(host.tailscale?.tailnetOnly).toBe(false);
    const { getProxyHost } = await import('../../../src/lib/models/proxy-hosts');
    expect((await getProxyHost(host.id))?.tailscale?.tailnetOnly).toBe(false);
  });

  it('refuses to store a tailnet host while no auth key is configured', async () => {
    // Fleet-wide otherwise: a node that cannot register makes Caddy reject the whole document.
    await saveTailscaleSettings({
      ...TAILSCALE_SETTINGS,
      authKey: '',
    } as never);

    await expect(createHost({ tailscale: { serve: true } })).rejects.toThrow(
      /no Tailscale auth key is configured/i,
    );
    await expect(createHost({ tailscale: { upstreamNode: 'edge' } })).rejects.toThrow(
      /no Tailscale auth key is configured/i,
    );
  });

  it('still stores a host that does not use Tailscale when no key is configured', async () => {
    await saveTailscaleSettings({ ...TAILSCALE_SETTINGS, authKey: '' } as never);
    const host = await createHost();
    expect(host.tailscale).toBeNull();
  });

  it('counts a Caddy placeholder as a stored key', async () => {
    // Only the Caddy container knows whether its environment defines it.
    await saveTailscaleSettings({
      ...TAILSCALE_SETTINGS,
      authKey: '{env.TS_AUTHKEY}',
    } as never);
    const host = await createHost({ tailscale: { serve: true } });
    expect(host.tailscale?.serve).toBe(true);
  });

  it('lets a host turn Tailscale off again after the key is gone', async () => {
    // Otherwise the gate would trap a host in a state it cannot be edited out of.
    await enableTailscale();
    const host = await createHost({ tailscale: { serve: true } });
    await saveTailscaleSettings({ ...TAILSCALE_SETTINGS, authKey: '' } as never);

    const { updateProxyHost } = await import('../../../src/lib/models/proxy-hosts');
    const updated = await updateProxyHost(host.id, { tailscale: null }, 1);
    expect(updated.tailscale).toBeNull();
  });

  it('refuses a node name that would break out of the listener address', async () => {
    await enableTailscale();
    await expect(createHost({ tailscale: { serve: true, node: 'caddy/../evil' } })).rejects.toThrow(
      /not a valid tailnet machine name/,
    );
  });

  it('leaves untouched fields alone on a partial update', async () => {
    await enableTailscale();
    const { updateProxyHost } = await import('../../../src/lib/models/proxy-hosts');
    const host = await createHost({
      tailscale: { serve: true, node: 'edge', auth: true, forwardIdentity: true },
    });

    const updated = await updateProxyHost(host.id, { tailscale: { tailnetOnly: false } }, 1);
    expect(updated.tailscale).toMatchObject({
      serve: true,
      node: 'edge',
      auth: true,
      forwardIdentity: true,
      tailnetOnly: false,
    });
  });
});

describe('certificates for MagicDNS names', () => {
  it('serves a .ts.net subject from Tailscale instead of ACME', async () => {
    await enableTailscale();
    await createHost({
      domains: ['app.tail1234.ts.net'],
      tailscale: { serve: true },
    });

    const policies =
      ((await buildCaddyDocument()) as CaddyDocument).apps.tls?.automation?.policies ?? [];
    const tailscalePolicy = policyForSubject(policies, 'app.tail1234.ts.net');
    expect(tailscalePolicy).toEqual({
      subjects: ['app.tail1234.ts.net'],
      get_certificate: [{ via: 'tailscale' }],
    });
    expect(tailscalePolicy).not.toHaveProperty('issuers');
  });

  it('leaves a public domain on ACME, in a policy of its own', async () => {
    await enableTailscale();
    await createHost({
      domains: ['app.tail1234.ts.net', 'app.example.com'],
      tailscale: { serve: true, tailnetOnly: false },
    });

    const policies =
      ((await buildCaddyDocument()) as CaddyDocument).apps.tls?.automation?.policies ?? [];
    const acmePolicy = policyForSubject(policies, 'app.example.com');
    // Caddy skips ACME only when *every* subject is MagicDNS; mixing leaks the name to a CA.
    expect(acmePolicy?.subjects).toEqual(['app.example.com']);
    expect(acmePolicy?.issuers).toBeDefined();
  });
});
