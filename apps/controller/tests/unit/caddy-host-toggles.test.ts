/**
 * The per-host switches in the editor: Force HTTPS, HSTS and WebSocket support each change the
 * generated config, and turning one off must actually remove what it adds.
 */
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

import {
  createProxyHost,
  listProxyHostsPaginated,
  updateProxyHost,
} from '../../src/lib/models/proxy-hosts';
import { buildCaddyDocument, buildServerProtocols } from '../../src/lib/caddy';
import { normalizeHttpProtocols } from '../../src/lib/settings';
import { parseProxyHostOptionUpdates } from '../../src/lib/proxy-host-form';
import * as schema from '../../src/lib/db/schema';

const NOW = new Date().toISOString();

/** The JSON of every route whose matcher names the domain. */
async function hostConfig(domain: string): Promise<string> {
  const found: unknown[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const route = node as { match?: { host?: string[] }[]; handle?: unknown[] };
    if (Array.isArray(route.handle) && route.match?.some((m) => m.host?.includes(domain))) {
      found.push(route);
    }
    Object.values(node).forEach(walk);
  };
  walk(await buildCaddyDocument());
  return JSON.stringify(found);
}

async function host(domain: string, options: Record<string, unknown>) {
  await createProxyHost(
    { name: domain, domains: [domain], upstreams: ['10.0.0.5:8080'], ...options },
    1,
  );
  return hostConfig(domain);
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

describe('host toggles', () => {
  it('redirects HTTP and sends HSTS by default', async () => {
    const config = await host('default.example.com', {});
    expect(config).toContain('"status_code":308');
    expect(config).toContain('Strict-Transport-Security');
  });

  it('drops the redirect and HSTS when both are off', async () => {
    const config = await host('plain.example.com', { sslForced: false, hstsEnabled: false });
    expect(config).not.toContain('"status_code":308');
    expect(config).not.toContain('Strict-Transport-Security');
  });

  it('refuses WebSocket upgrades only when WebSocket support is off', async () => {
    const off = await host('no-ws.example.com', { allowWebsocket: false });
    // Case-insensitive, and HTTP/2's extended CONNECT carries no Upgrade header to match.
    expect(off).toContain('"pattern":"(?i)websocket"');
    expect(off).toContain('"method":["CONNECT"]');
    expect(off).toContain('"status_code":403');

    const on = await host('ws.example.com', { allowWebsocket: true });
    expect(on).not.toContain('(?i)websocket');
  });

  it('runs the WAF on WebSocket upgrades too, so claiming to be one skips nothing', async () => {
    const config = await host('waf-ws.example.com', {
      allowWebsocket: true,
      waf: { enabled: true, mode: 'On', load_owasp_crs: true, waf_mode: 'override' },
    });
    expect(config).toContain('"handler":"waf"');
    // The old #195 carve-out: a `not` on the upgrade headers in front of the WAF.
    expect(config).not.toContain('"Upgrade":["websocket"]');
  });

  it('sets the Host header only while preserveHostHeader is on', async () => {
    expect(await host('keep-host.example.com', { preserveHostHeader: true })).toContain(
      '{http.request.host}"]',
    );
    expect(await host('upstream-host.example.com', { preserveHostHeader: false })).not.toContain(
      '"Host":["{http.request.host}"]',
    );
  });
});

describe('redirect path modes', () => {
  it('keeps a valid preservePath through the model and drops an unknown one', async () => {
    const config = await host('redirects.example.com', {
      redirects: [
        { from: '/old/*', to: '/new', status: 301, preservePath: 'suffix' },
        { from: '/legacy', to: '/v2', status: 302, preservePath: 'bogus' },
      ],
    });
    expect(config).toContain('"strip_path_prefix":"/old"');
    expect(config).toContain('/new{http.request.uri}');
    expect(config).toContain('"Location":["/v2"]');
  });
});

describe('host notes', () => {
  it('stores, searches, keeps and clears them', async () => {
    const host = await createProxyHost(
      {
        name: 'notes',
        domains: ['notes.example.com'],
        upstreams: ['10.0.0.5:8080'],
        description: ' Ask Sam ',
      },
      1,
    );
    expect(host.description).toBe('Ask Sam');
    expect((await listProxyHostsPaginated(50, 0, 'Sam')).map((h) => h.id)).toContain(host.id);

    const renamed = await updateProxyHost(host.id, { name: 'renamed' }, 1);
    expect(renamed.description).toBe('Ask Sam');

    const cleared = await updateProxyHost(host.id, { description: '' }, 1);
    expect(cleared.description).toBeNull();
  });
});

describe('parseProxyHostOptionUpdates', () => {
  it('reads each toggle behind its presence marker', () => {
    const form = new FormData();
    for (const key of ['sslForced', 'hstsEnabled', 'allowWebsocket', 'preserveHostHeader']) {
      form.set(`${key}Present`, '1');
    }
    form.set('sslForced', 'on');
    const parsed = parseProxyHostOptionUpdates(form);
    expect(parsed.sslForced).toBe(true);
    expect(parsed.hstsEnabled).toBe(false);
    expect(parsed.allowWebsocket).toBe(false);
    expect(parsed.preserveHostHeader).toBe(false);
  });

  it('leaves a toggle alone when its marker is absent', () => {
    const parsed = parseProxyHostOptionUpdates(new FormData());
    expect(parsed.sslForced).toBeUndefined();
    expect(parsed.allowWebsocket).toBeUndefined();
  });
});

describe('HTTP versions', () => {
  it("leaves Caddy's default alone while everything is on", () => {
    expect(buildServerProtocols({ http2: true, http3: true })).toEqual({});
  });

  it('always keeps HTTP/1.1', () => {
    expect(buildServerProtocols({ http2: false, http3: false })).toEqual({ protocols: ['h1'] });
    expect(buildServerProtocols({ http2: true, http3: false })).toEqual({
      protocols: ['h1', 'h2'],
    });
  });

  it('reads anything but an explicit false as on', () => {
    expect(normalizeHttpProtocols(null)).toEqual({ http2: true, http3: true });
    expect(normalizeHttpProtocols({ http3: false, extra: 'x' })).toEqual({
      http2: true,
      http3: false,
    });
  });
});
