/** The reverse_proxy transport: TLS, a custom resolver and timeouts merged into one object. */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { eq } from 'drizzle-orm';
import { createProxyHost, updateProxyHost } from '../../../src/lib/models/proxy-hosts';
import { buildCaddyDocument } from '../../../src/lib/caddy';
import { isCaddyDuration } from '../../../src/lib/caddy/duration';
import { parseUpstreamTimeoutsConfig } from '../../../src/lib/proxy-hosts/form';
import * as schema from '../../../src/lib/db/schema';
import { chainsTo, type Handler } from '../../helpers/host-chains';

const NOW = new Date().toISOString();

async function proxyFor(upstream: string, options: Record<string, unknown> = {}) {
  await createProxyHost(
    { name: 'app', domains: ['app.example.com'], upstreams: [upstream], ...options },
    1,
  );
  const chains = chainsTo(await buildCaddyDocument(), upstream.replace(/^https?:\/\//, ''));
  expect(chains.length).toBeGreaterThan(0);
  return chains[0].find((h) => h.handler === 'reverse_proxy') as Handler;
}

const RESOLVER = { enabled: true, resolvers: ['1.1.1.1'], fallbacks: ['9.9.9.9:5353'] };

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

describe('host transport', () => {
  it('is left out for a plain http upstream', async () => {
    expect((await proxyFor('10.0.0.5:8080')).transport).toBeUndefined();
  });

  it('carries TLS for an https upstream', async () => {
    const proxy = await proxyFor('https://10.0.0.5:8443', { skipHttpsHostnameValidation: true });
    expect(proxy.transport).toEqual({ protocol: 'http', tls: { insecure_skip_verify: true } });
  });

  it('merges TLS and the resolver, with the resolver timeout as the dial timeout', async () => {
    const proxy = await proxyFor('https://10.0.0.5:8443', {
      dnsResolver: { ...RESOLVER, timeout: '4s' },
    });
    expect(proxy.transport).toEqual({
      protocol: 'http',
      tls: {},
      resolver: { addresses: ['1.1.1.1:53', '9.9.9.9:5353'] },
      dial_timeout: '4s',
    });
  });

  it('carries a resolver alone for a plain http upstream', async () => {
    const proxy = await proxyFor('10.0.0.5:8080', { dnsResolver: RESOLVER });
    expect(proxy.transport).toEqual({
      protocol: 'http',
      resolver: { addresses: ['1.1.1.1:53', '9.9.9.9:5353'] },
    });
  });

  it('ignores a disabled resolver', async () => {
    const proxy = await proxyFor('10.0.0.5:8080', {
      dnsResolver: { ...RESOLVER, enabled: false, timeout: '4s' },
    });
    expect(proxy.transport).toBeUndefined();
  });
});

const TIMEOUTS = {
  dialTimeout: '5s',
  responseHeaderTimeout: '30s',
  readTimeout: '1m30s',
  writeTimeout: '2m',
  keepAliveIdleTimeout: '90s',
  streamTimeout: '1d',
  streamCloseDelay: '5m',
};

const host = (options: Record<string, unknown>) =>
  createProxyHost(
    { name: 'app', domains: ['app.example.com'], upstreams: ['10.0.0.5:8080'], ...options },
    1,
  );

describe('upstream timeouts', () => {
  it('merge into the transport with TLS and the resolver, the stream pair on the handler', async () => {
    const proxy = await proxyFor('https://10.0.0.5:8443', {
      dnsResolver: { ...RESOLVER, timeout: '4s' },
      upstreamTimeouts: TIMEOUTS,
    });
    expect(proxy.transport).toEqual({
      protocol: 'http',
      tls: {},
      resolver: { addresses: ['1.1.1.1:53', '9.9.9.9:5353'] },
      dial_timeout: '5s',
      response_header_timeout: '30s',
      read_timeout: '1m30s',
      write_timeout: '2m',
      keep_alive: { idle_timeout: '90s' },
    });
    expect(proxy.stream_timeout).toBe('1d');
    expect(proxy.stream_close_delay).toBe('5m');
  });

  it('create an http transport for a plain upstream', async () => {
    const proxy = await proxyFor('10.0.0.5:8080', { upstreamTimeouts: { readTimeout: '10m' } });
    expect(proxy.transport).toEqual({ protocol: 'http', read_timeout: '10m' });
  });

  it('fall back to the resolver timeout for the dial timeout, then to Caddy', async () => {
    const legacy = await proxyFor('10.0.0.5:8080', {
      dnsResolver: { ...RESOLVER, timeout: '4s' },
      upstreamTimeouts: { readTimeout: '10m' },
    });
    expect((legacy.transport as Handler).dial_timeout).toBe('4s');

    await ctx.db.delete(schema.proxyHosts);
    const none = await proxyFor('10.0.0.5:8080', { upstreamTimeouts: { readTimeout: '10m' } });
    expect((none.transport as Handler).dial_timeout).toBeUndefined();
  });

  it('are inherited by location rules', async () => {
    await host({
      upstreamTimeouts: { dialTimeout: '5s', streamTimeout: '1h' },
      locationRules: [{ path: '/api/*', upstreams: ['https://10.0.0.9:8443'] }],
    });
    const chains = chainsTo(await buildCaddyDocument(), '10.0.0.9:8443');
    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) {
      const proxy = chain.find((h) => h.handler === 'reverse_proxy') as Handler;
      expect(proxy.transport).toEqual({ protocol: 'http', tls: {}, dial_timeout: '5s' });
      expect(proxy.stream_timeout).toBe('1h');
    }
  });

  it('round-trip through the model, and null clears them', async () => {
    const created = await host({ upstreamTimeouts: { dialTimeout: ' 5s ', readTimeout: '' } });
    expect(created.upstreamTimeouts).toEqual({
      dialTimeout: '5s',
      responseHeaderTimeout: null,
      readTimeout: null,
      writeTimeout: null,
      keepAliveIdleTimeout: null,
      streamTimeout: null,
      streamCloseDelay: null,
    });
    const cleared = await updateProxyHost(created.id, { upstreamTimeouts: null }, 1);
    expect(cleared.upstreamTimeouts).toBeNull();
  });

  it('survive an update to another field', async () => {
    const created = await host({ upstreamTimeouts: { streamTimeout: '1h' } });
    const updated = await updateProxyHost(created.id, { name: 'renamed' }, 1);
    expect(updated.upstreamTimeouts?.streamTimeout).toBe('1h');
  });
});

describe('invalid durations', () => {
  for (const value of ['30', '5 s', 'soon', '-1s', '1w']) {
    it(`refuses upstream timeout "${value}"`, async () => {
      await expect(host({ upstreamTimeouts: { dialTimeout: value } })).rejects.toMatchObject({
        code: 'hostUpstreamTimeoutInvalid',
      });
    });
  }

  it('refuses a DNS resolver timeout that is not a duration', async () => {
    await expect(host({ dnsResolver: { ...RESOLVER, timeout: '5' } })).rejects.toMatchObject({
      code: 'hostDnsResolverTimeoutInvalid',
    });
  });

  it('drops a stored one rather than failing the whole document', async () => {
    const created = await host({});
    await ctx.db
      .update(schema.proxyHosts)
      .set({
        meta: JSON.stringify({
          dns_resolver: { ...RESOLVER, timeout: 'soon' },
          upstream_timeouts: { read_timeout: 'forever', write_timeout: '1m' },
        }),
      })
      .where(eq(schema.proxyHosts.id, created.id));
    const [chain] = chainsTo(await buildCaddyDocument(), '10.0.0.5:8080');
    const proxy = chain.find((h) => h.handler === 'reverse_proxy') as Handler;
    expect(proxy.transport).toEqual({
      protocol: 'http',
      resolver: { addresses: ['1.1.1.1:53', '9.9.9.9:5353'] },
      write_timeout: '1m',
    });
  });
});

describe('isCaddyDuration', () => {
  it('takes Go durations and d, with a unit on every number', () => {
    for (const ok of ['30s', '1m30s', '2h', '1d', '1.5h', '250ms', '0s']) {
      expect(isCaddyDuration(ok)).toBe(true);
    }
    for (const bad of ['', '30', '-1s', '1 m', '1w', 'forever', '1s'.repeat(20)]) {
      expect(isCaddyDuration(bad)).toBe(false);
    }
  });
});

describe('the editor form', () => {
  const form = (entries: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(entries)) data.set(key, value);
    return data;
  };

  it('is absent without the card, null with it off, and the fields with it on', () => {
    expect(parseUpstreamTimeoutsConfig(form({}))).toBeUndefined();
    expect(parseUpstreamTimeoutsConfig(form({ upstreamTimeoutsPresent: '1' }))).toBeNull();
    const parsed = parseUpstreamTimeoutsConfig(
      form({
        upstreamTimeoutsPresent: '1',
        upstreamTimeoutsEnabled: 'on',
        'upstreamTimeouts.dialTimeout': '5s',
        'upstreamTimeouts.streamTimeout': '',
      }),
    );
    expect(parsed?.dialTimeout).toBe('5s');
    expect(parsed?.streamTimeout).toBeNull();
  });
});
