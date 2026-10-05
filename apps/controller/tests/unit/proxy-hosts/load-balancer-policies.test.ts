/**
 * Every shape here was checked with `caddy validate`: an unknown field refuses the *whole*
 * document, so one bad host takes every route down - the bug the layer-4 cases pin.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

// Hoisted: a Bun mock factory must be synchronous, and an async one hangs the file.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { createProxyHost } from '../../../src/lib/models/proxy-hosts';
import { createL4ProxyHost } from '../../../src/lib/models/l4-proxy-hosts';
import { buildCaddyDocument } from '../../../src/lib/caddy';
import * as schema from '../../../src/lib/db/schema';

beforeEach(async () => {
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.l4ProxyHosts);
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

type Lb = Record<string, unknown>;

async function httpHostWithLb(loadBalancer: Lb, upstreams = ['a:80', 'b:80', 'c:80']) {
  await createProxyHost(
    {
      name: 'lb',
      domains: ['lb.example.com'],
      upstreams,
      loadBalancer,
    } as never,
    1,
  );
  return JSON.parse(JSON.stringify(await buildCaddyDocument()));
}

/** Wherever the builder placed it. */
function reverseProxy(doc: unknown): Record<string, unknown> {
  const found: Record<string, unknown>[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (obj.handler === 'reverse_proxy' && obj.load_balancing) found.push(obj);
    Object.values(obj).forEach(walk);
  };
  walk(doc);
  if (found.length === 0) throw new Error('no reverse_proxy handler with load_balancing');
  return found[0];
}

function selectionPolicy(doc: unknown): Record<string, unknown> {
  const lb = reverseProxy(doc).load_balancing as Record<string, unknown>;
  return lb.selection_policy as Record<string, unknown>;
}

describe('selection policies', () => {
  it('emits weights for weighted_round_robin, in upstream order', async () => {
    const doc = await httpHostWithLb({
      enabled: true,
      policy: 'weighted_round_robin',
      policyWeights: [3, 2, 1],
    });
    expect(selectionPolicy(doc)).toEqual({ policy: 'weighted_round_robin', weights: [3, 2, 1] });
  });

  it('falls back to round_robin when the weights do not match the upstreams', async () => {
    // Padding would silently drop a backend to weight 0; unweighted is the honest degradation.
    const doc = await httpHostWithLb({
      enabled: true,
      policy: 'weighted_round_robin',
      policyWeights: [5, 1],
    });
    expect(selectionPolicy(doc)).toEqual({ policy: 'round_robin' });
  });

  it('falls back to round_robin when every weight is zero, which Caddy refuses', async () => {
    const doc = await httpHostWithLb({
      enabled: true,
      policy: 'weighted_round_robin',
      policyWeights: [0, 0, 0],
    });
    expect(selectionPolicy(doc)).toEqual({ policy: 'round_robin' });
  });

  it('falls back to round_robin when weighted_round_robin has no weights at all', async () => {
    const doc = await httpHostWithLb({ enabled: true, policy: 'weighted_round_robin' });
    expect(selectionPolicy(doc)).toEqual({ policy: 'round_robin' });
  });

  it('emits choose for random_choose', async () => {
    const doc = await httpHostWithLb({
      enabled: true,
      policy: 'random_choose',
      policyChoose: 2,
    });
    expect(selectionPolicy(doc)).toEqual({ policy: 'random_choose', choose: 2 });
  });

  it('emits key for the query policy', async () => {
    const doc = await httpHostWithLb({
      enabled: true,
      policy: 'query',
      policyQueryKey: 'session',
    });
    expect(selectionPolicy(doc)).toEqual({ policy: 'query', key: 'session' });
  });

  it('emits client_ip_hash with no options of its own', async () => {
    const doc = await httpHostWithLb({ enabled: true, policy: 'client_ip_hash' });
    expect(selectionPolicy(doc)).toEqual({ policy: 'client_ip_hash' });
  });
});

describe('active health check fields', () => {
  it('emits the probe controls under their Caddy names', async () => {
    const doc = await httpHostWithLb({
      enabled: true,
      policy: 'round_robin',
      activeHealthCheck: {
        enabled: true,
        uri: '/healthz',
        passes: 2,
        fails: 3,
        method: 'head',
        requestBody: 'ping',
        followRedirects: true,
        headers: { 'X-Probe': 'yes' },
      },
    });
    const active = (reverseProxy(doc).health_checks as Record<string, unknown>).active as Record<
      string,
      unknown
    >;

    expect(active.passes).toBe(2);
    expect(active.fails).toBe(3);
    // Upper-cased on the way in: Caddy compares the method verbatim.
    expect(active.method).toBe('HEAD');
    expect(active.follow_redirects).toBe(true);
    // Caddy's `headers` is a map of field to a *list* of values.
    expect(active.headers).toEqual({ 'X-Probe': ['yes'] });
  });

  it('keeps the probe body and the expected body apart', async () => {
    // `body` is sent, `expect_body` matched; swapping them makes every check fail closed.
    const doc = await httpHostWithLb({
      enabled: true,
      policy: 'round_robin',
      activeHealthCheck: { enabled: true, uri: '/h', requestBody: 'ping', body: 'pong' },
    });
    const active = (reverseProxy(doc).health_checks as Record<string, unknown>).active as Record<
      string,
      unknown
    >;
    expect(active.body).toBe('ping');
    expect(active.expect_body).toBe('pong');
  });

  it('refuses a header value carrying a newline', async () => {
    // It would forge a second header on every timed probe against the operator's backend.
    const doc = await httpHostWithLb({
      enabled: true,
      policy: 'round_robin',
      activeHealthCheck: {
        enabled: true,
        uri: '/h',
        headers: { Good: 'yes', Bad: 'a\r\nX-Injected: 1' },
      },
    });
    const active = (reverseProxy(doc).health_checks as Record<string, unknown>).active as Record<
      string,
      unknown
    >;
    expect(active.headers).toEqual({ Good: ['yes'] });
  });

  it('refuses a method that is not one of the probe verbs', async () => {
    const doc = await httpHostWithLb({
      enabled: true,
      policy: 'round_robin',
      activeHealthCheck: { enabled: true, uri: '/h', method: 'TRACE' },
    });
    const active = (reverseProxy(doc).health_checks as Record<string, unknown>).active as Record<
      string,
      unknown
    >;
    expect(active.method).toBeUndefined();
  });
});

describe('passive health check fields', () => {
  it('emits unhealthy_request_count', async () => {
    const doc = await httpHostWithLb({
      enabled: true,
      policy: 'round_robin',
      passiveHealthCheck: { enabled: true, failDuration: '30s', unhealthyRequestCount: 20 },
    });
    const passive = (reverseProxy(doc).health_checks as Record<string, unknown>).passive as Record<
      string,
      unknown
    >;
    expect(passive.unhealthy_request_count).toBe(20);
  });
});

// ─── Layer 4 ─────────────────────────────────────────────────────────────────

/** A different, much smaller schema. */
function l4Proxy(doc: unknown): Record<string, unknown> {
  const found: Record<string, unknown>[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (obj.handler === 'proxy') found.push(obj);
    Object.values(obj).forEach(walk);
  };
  walk(doc);
  if (found.length === 0) throw new Error('no layer4 proxy handler');
  return found[0];
}

async function l4HostWithLb(loadBalancer: Lb) {
  await createL4ProxyHost(
    {
      name: 'l4lb',
      protocol: 'tcp',
      listenAddress: ':9000',
      upstreams: ['a:80', 'b:80'],
      loadBalancer,
    } as never,
    1,
  );
  return JSON.parse(JSON.stringify(await buildCaddyDocument()));
}

describe('layer 4 emits only what caddy-l4 defines', () => {
  it('uses `selection` and keeps the try window, never retries', async () => {
    // caddy-l4 v0.1.2 decodes strictly: `selection_policy` or `retries` refuses the document.
    const doc = await l4HostWithLb({
      enabled: true,
      policy: 'round_robin',
      tryDuration: '5s',
      tryInterval: '250ms',
      retries: 3,
    });
    expect(l4Proxy(doc).load_balancing).toEqual({
      selection: { policy: 'round_robin' },
      try_duration: '5s',
      try_interval: '250ms',
    });
  });

  it('never emits unhealthy_latency on the passive check', async () => {
    const doc = await l4HostWithLb({
      enabled: true,
      policy: 'round_robin',
      passiveHealthCheck: {
        enabled: true,
        failDuration: '30s',
        maxFails: 3,
        unhealthyLatency: '5s',
      },
    });
    const passive = (l4Proxy(doc).health_checks as Record<string, unknown>).passive as Record<
      string,
      unknown
    >;
    expect(passive).toEqual({ fail_duration: '30s', max_fails: 3 });
  });

  it('keeps the active check to port, interval and timeout', async () => {
    const doc = await l4HostWithLb({
      enabled: true,
      policy: 'round_robin',
      activeHealthCheck: { enabled: true, port: 8080, interval: '10s', timeout: '2s' },
    });
    const active = (l4Proxy(doc).health_checks as Record<string, unknown>).active as Record<
      string,
      unknown
    >;
    expect(active).toEqual({ port: 8080, interval: '10s', timeout: '2s' });
  });

  it('weighs each upstream rather than the policy', async () => {
    const wrr = l4Proxy(
      await l4HostWithLb({ enabled: true, policy: 'weighted_round_robin', policyWeights: [3, 1] }),
    );
    expect(wrr.load_balancing).toEqual({ selection: { policy: 'weighted_round_robin' } });
    expect(wrr.upstreams).toEqual([
      { dial: ['a:80'], weight: 3 },
      { dial: ['b:80'], weight: 1 },
    ]);

    await ctx.db.delete(schema.l4ProxyHosts);
    const drifted = l4Proxy(
      await l4HostWithLb({ enabled: true, policy: 'weighted_round_robin', policyWeights: [3] }),
    );
    expect(drifted.load_balancing).toEqual({ selection: { policy: 'round_robin' } });
    expect(drifted.upstreams).toEqual([{ dial: ['a:80'] }, { dial: ['b:80'] }]);
  });

  it('puts the random_choose count in the selection', async () => {
    const rc = await l4HostWithLb({ enabled: true, policy: 'random_choose', policyChoose: 2 });
    expect(l4Proxy(rc).load_balancing).toEqual({
      selection: { policy: 'random_choose', choose: 2 },
    });
  });
});
