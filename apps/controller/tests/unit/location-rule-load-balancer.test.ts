/**
 * Per-location-rule load balancer / health checks (#200): the model round-trips the nested config,
 * it survives an unrelated update, and buildCaddyDocument emits it on the matching path.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

// Hoisted: an async Bun mock factory never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { createProxyHost, updateProxyHost, getProxyHost } from '../../src/lib/models/proxy-hosts';
import { buildCaddyDocument } from '../../src/lib/caddy';
import * as schema from '../../src/lib/db/schema';

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

const LB_INPUT = {
  enabled: true,
  policy: 'round_robin' as const,
  tryDuration: '5s',
  retries: 3,
  activeHealthCheck: {
    enabled: true,
    uri: '/health',
    port: 8081,
    interval: '30s',
    timeout: '5s',
    status: 200,
  },
  passiveHealthCheck: {
    enabled: true,
    failDuration: '30s',
    maxFails: 5,
    unhealthyStatus: [500, 502, 503],
  },
};

async function createHostWithRuleLb() {
  return createProxyHost(
    {
      name: 'LB Rule Host',
      domains: ['lb.example.com'],
      upstreams: ['origin:80'],
      locationRules: [{ path: '/api/*', upstreams: ['a:80', 'b:80'], loadBalancer: LB_INPUT }],
    },
    1,
  );
}

describe('location rule load balancer - model round-trip', () => {
  it('hydrates the nested load balancer on read', async () => {
    const host = await createHostWithRuleLb();
    const fetched = (await getProxyHost(host.id))!;
    const rule = fetched.locationRules[0];

    expect(rule.path).toBe('/api/*');
    expect(rule.loadBalancer).not.toBeNull();
    expect(rule.loadBalancer!.policy).toBe('round_robin');
    expect(rule.loadBalancer!.retries).toBe(3);
    expect(rule.loadBalancer!.activeHealthCheck).toMatchObject({
      enabled: true,
      uri: '/health',
      port: 8081,
      status: 200,
    });
    expect(rule.loadBalancer!.passiveHealthCheck).toMatchObject({
      enabled: true,
      maxFails: 5,
      unhealthyStatus: [500, 502, 503],
    });
  });

  it('preserves the rule load balancer across an unrelated update', async () => {
    const host = await createHostWithRuleLb();
    await updateProxyHost(host.id, { name: 'Renamed' }, 1);
    const fetched = (await getProxyHost(host.id))!;

    expect(fetched.name).toBe('Renamed');
    expect(fetched.locationRules[0].loadBalancer?.policy).toBe('round_robin');
    expect(fetched.locationRules[0].loadBalancer?.activeHealthCheck?.uri).toBe('/health');
  });

  it('emits load_balancing and health_checks in the generated Caddy config', async () => {
    await createHostWithRuleLb();
    const doc = JSON.stringify(await buildCaddyDocument());
    expect(doc).toContain('"load_balancing"');
    expect(doc).toContain('"health_checks"');
    expect(doc).toContain('"expect_status":200');
  });
});
