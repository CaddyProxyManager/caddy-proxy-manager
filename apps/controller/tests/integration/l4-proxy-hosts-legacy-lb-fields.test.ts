/**
 * caddy-l4 has no `retries` and no passive `unhealthy_latency` (upstream #301), so the L4 load
 * balancer no longer stores or returns them. Hosts saved by older versions may still carry them in
 * meta; they must be ignored, and dropped the next time the load balancer is saved.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

// A Bun mock factory must be synchronous; an async one never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => ({
  default: ctx.db,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null => {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  },
}));

vi.mock('../../src/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}));

import {
  createL4ProxyHost,
  getL4ProxyHost,
  updateL4ProxyHost,
  type L4ProxyHostInput,
} from '../../src/lib/models/l4-proxy-hosts';
import { l4ProxyHosts, users } from '../../src/lib/db/schema';

beforeEach(async () => {
  await ctx.db.delete(l4ProxyHosts);
  await ctx.db.delete(users).catch(() => {});
  const now = new Date().toISOString();
  await ctx.db.insert(users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    provider: 'credentials',
    subject: 'admin',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
});

async function storedLoadBalancerMeta(id: number) {
  const [row] = await ctx.db.select().from(l4ProxyHosts).where(eq(l4ProxyHosts.id, id));
  return JSON.parse(row.meta!).load_balancer as Record<string, unknown>;
}

async function insertLegacyHost(listenAddress: string, loadBalancer: Record<string, unknown>) {
  const now = new Date().toISOString();
  const [row] = await ctx.db
    .insert(l4ProxyHosts)
    .values({
      name: 'Legacy',
      protocol: 'tcp',
      listenAddress,
      upstreams: JSON.stringify([`10.0.0.1${listenAddress}`]),
      matcherType: 'none',
      matcherValue: null,
      tlsTermination: false,
      proxyProtocolVersion: null,
      proxyProtocolReceive: false,
      enabled: true,
      meta: JSON.stringify({ load_balancer: loadBalancer }),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}

// Cast: an API client can still send the withdrawn fields.
const legacyLoadBalancer = {
  enabled: true,
  policy: 'first',
  tryDuration: '5s',
  tryInterval: '250ms',
  retries: 3,
  activeHealthCheck: { enabled: true, port: null, interval: null, timeout: null },
  passiveHealthCheck: { enabled: true, failDuration: '30s', maxFails: 3, unhealthyLatency: '5s' },
} as unknown as L4ProxyHostInput['loadBalancer'];

describe('L4 load balancer legacy fields', () => {
  it('does not store retries or unhealthyLatency sent by an API client', async () => {
    const host = await createL4ProxyHost(
      {
        name: 'LB',
        protocol: 'tcp',
        listenAddress: ':5432',
        upstreams: ['10.0.0.1:5432', '10.0.0.2:5432'],
        matcherType: 'none',
        loadBalancer: legacyLoadBalancer,
      },
      1,
    );

    expect(await storedLoadBalancerMeta(host.id)).toEqual({
      enabled: true,
      policy: 'first',
      try_duration: '5s',
      try_interval: '250ms',
      active_health_check: { enabled: true },
      passive_health_check: { enabled: true, fail_duration: '30s', max_fails: 3 },
    });
    expect(host.loadBalancer).not.toHaveProperty('retries');
    expect(host.loadBalancer?.passiveHealthCheck).not.toHaveProperty('unhealthyLatency');
  });

  it('does not return legacy values already stored on a host', async () => {
    const row = await insertLegacyHost(':5433', {
      enabled: true,
      policy: 'round_robin',
      retries: 4,
      passive_health_check: { enabled: true, fail_duration: '30s', unhealthy_latency: '2s' },
    });

    const host = await getL4ProxyHost(row.id);
    expect(host?.loadBalancer).toMatchObject({ enabled: true, policy: 'round_robin' });
    expect(host?.loadBalancer).not.toHaveProperty('retries');
    expect(host?.loadBalancer?.passiveHealthCheck).not.toHaveProperty('unhealthyLatency');
  });

  it('drops legacy values from storage the next time the load balancer is saved', async () => {
    const row = await insertLegacyHost(':5434', { enabled: true, policy: 'first', retries: 4 });

    await updateL4ProxyHost(
      row.id,
      { loadBalancer: { ...legacyLoadBalancer, tryDuration: '10s' } },
      1,
    );

    const meta = await storedLoadBalancerMeta(row.id);
    expect(meta).not.toHaveProperty('retries');
    expect(meta.try_duration).toBe('10s');
    expect(meta.passive_health_check).not.toHaveProperty('unhealthy_latency');
  });
});
