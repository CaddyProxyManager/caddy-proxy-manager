/** Response compression: the global switch, the per-host override and where `encode` sits. */
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
import { saveCompressionSettings } from '../../src/lib/settings';
import { parseProxyHostOptionUpdates } from '../../src/lib/proxy-host-form';
import {
  buildEncodeHandler,
  isCompressionOn,
  normalizeCompressionSettings,
  sanitizeHostCompression,
} from '../../src/lib/host-compression';
import * as schema from '../../src/lib/db/schema';
import { chainLabels, chainsTo } from '../helpers/host-chains';

const NOW = new Date().toISOString();
const UPSTREAM = '10.0.0.5:8080';
const LOCATION_UPSTREAM = '10.0.0.6:9000';

async function labelsFor(domain: string, options: Record<string, unknown> = {}) {
  await createProxyHost({ name: domain, domains: [domain], upstreams: [UPSTREAM], ...options }, 1);
  const labels = chainLabels(await buildCaddyDocument(), UPSTREAM);
  expect(labels.length).toBeGreaterThan(0);
  return labels;
}

beforeEach(async () => {
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

describe('encode handler', () => {
  it('offers zstd and gzip and leaves the content-type list to Caddy', () => {
    const handler = buildEncodeHandler();
    expect(handler).toEqual({
      handler: 'encode',
      encodings: { gzip: {}, zstd: {} },
      prefer: ['zstd', 'gzip'],
    });
    expect(handler).not.toHaveProperty('match');
  });

  it('resolves inherit against the global switch', () => {
    expect(isCompressionOn(null, undefined)).toBe(true);
    expect(isCompressionOn({ enabled: false }, 'inherit')).toBe(false);
    expect(isCompressionOn({ enabled: false }, 'on')).toBe(true);
    expect(isCompressionOn({ enabled: true }, 'off')).toBe(false);
    expect(normalizeCompressionSettings(null)).toEqual({ enabled: true });
    expect(normalizeCompressionSettings({ enabled: false })).toEqual({ enabled: false });
    expect(sanitizeHostCompression('bogus')).toBe('inherit');
  });
});

describe('chain position', () => {
  it('sits after ws-refuse and before geo blocking and the WAF', async () => {
    for (const labels of await labelsFor('plain.example.com', {
      allowWebsocket: false,
      waf: { enabled: true, mode: 'On', load_owasp_crs: true, waf_mode: 'override' },
    })) {
      const encode = labels.indexOf('encode');
      expect(encode).toBeGreaterThan(labels.indexOf('ws-refuse'));
      expect(encode).toBeLessThan(labels.indexOf('waf'));
    }
  });

  it('wraps the auth subrequest on a forward-auth host', async () => {
    for (const labels of await labelsFor('fa.example.com', {
      forwardAuth: { enabled: true, provider: 'authelia', authUpstream: 'http://authelia:9091' },
    })) {
      const encode = labels.indexOf('encode');
      expect(encode).toBeGreaterThanOrEqual(0);
      expect(encode).toBeLessThan(labels.lastIndexOf('reverse_proxy'));
      expect(labels.filter((label) => label === 'encode')).toHaveLength(1);
    }
  });

  it('reaches location rules through the shared chain', async () => {
    await createProxyHost(
      {
        name: 'loc',
        domains: ['loc.example.com'],
        upstreams: [UPSTREAM],
        locationRules: [{ path: '/api/*', upstreams: [LOCATION_UPSTREAM] }],
      },
      1,
    );
    const chains = chainsTo(await buildCaddyDocument(), LOCATION_UPSTREAM);
    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) {
      expect(chain.some((handler) => handler.handler === 'encode')).toBe(true);
    }
  });

  it('is not added to the error routes', async () => {
    await labelsFor('errors.example.com', {
      errorPages: [{ statuses: [502], body: 'down' }],
    });
    const doc = (await buildCaddyDocument()) as {
      apps: { http: { servers: Record<string, { errors?: unknown }> } };
    };
    const errors = JSON.stringify(Object.values(doc.apps.http.servers).map((s) => s.errors));
    expect(errors).not.toContain('"encode"');
  });
});

describe('inherit, on and off', () => {
  it('follows the global switch unless the host overrides it', async () => {
    await saveCompressionSettings({ enabled: false });
    const inherit = await labelsFor('inherit.example.com');
    expect(inherit.every((labels) => !labels.includes('encode'))).toBe(true);

    await ctx.db.delete(schema.proxyHosts);
    const on = await labelsFor('on.example.com', { compression: 'on' });
    expect(on.every((labels) => labels.includes('encode'))).toBe(true);

    await saveCompressionSettings({ enabled: true });
    await ctx.db.delete(schema.proxyHosts);
    const off = await labelsFor('off.example.com', { compression: 'off' });
    expect(off.every((labels) => !labels.includes('encode'))).toBe(true);
  });

  it('stores only an override, and a form without the field keeps it', async () => {
    const host = await createProxyHost(
      { name: 'store', domains: ['store.example.com'], upstreams: [UPSTREAM], compression: 'off' },
      1,
    );
    expect(host.compression).toBe('off');

    const form = new FormData();
    form.set('name', 'renamed');
    await updateProxyHost(host.id, { name: 'renamed', ...parseProxyHostOptionUpdates(form) }, 1);
    expect((await getProxyHost(host.id))?.compression).toBe('off');

    const inherit = new FormData();
    inherit.set('compression', 'inherit');
    await updateProxyHost(host.id, parseProxyHostOptionUpdates(inherit), 1);
    const row = await ctx.db.query.proxyHosts.findFirst();
    expect(row?.meta ?? '').not.toContain('compression');
    expect((await getProxyHost(host.id))?.compression).toBe('inherit');
  });
});
