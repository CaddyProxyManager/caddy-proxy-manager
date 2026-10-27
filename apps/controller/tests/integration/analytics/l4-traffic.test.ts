/**
 * L4 connections end to end against the SQLite analytics store: an agent's rows checked and kept
 * to the ports it serves, then one host's last day read back by protocol and port.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

const schema = await import('../../../src/lib/db/schema');
const client = await import('../../../src/lib/clickhouse/client');
const { ingestAnalytics, parseL4Row } = await import('../../../src/lib/agent/analytics-ingest');
const { getL4HostTraffic } = await import('../../../src/lib/l4/detail');
const { setSetting } = await import('../../../src/lib/settings');

const NOW = Math.floor(Date.now() / 1000);

function row(overrides: Record<string, unknown> = {}) {
  return {
    ts: NOW - 600,
    network: 'tcp',
    port: 5432,
    client_ip: '198.51.100.1',
    country_code: 'DE',
    bytes_in: 100,
    bytes_out: 1000,
    duration_ms: 2000,
    ...overrides,
  };
}

async function l4Host(name: string, listenAddress: string, protocol: 'tcp' | 'udp' = 'tcp') {
  const at = new Date().toISOString();
  const [inserted] = await ctx.db
    .insert(schema.l4ProxyHosts)
    .values({
      name,
      protocol,
      listenAddress,
      upstreams: JSON.stringify(['db:5432']),
      matcherType: 'none',
      matcherValue: null,
      tlsTermination: false,
      proxyProtocolVersion: null,
      proxyProtocolReceive: false,
      meta: null,
      enabled: true,
      createdAt: at,
      updatedAt: at,
    })
    .returning({ id: schema.l4ProxyHosts.id });
  return { id: inserted!.id, protocol, listenAddress };
}

let postgres: Awaited<ReturnType<typeof l4Host>>;
let ingested: Awaited<ReturnType<typeof ingestAnalytics>>;

beforeAll(async () => {
  process.env.DEMO_MODE = 'true';
  process.env.DEMO_ANALYTICS_DB = ':memory:';
  await client.invalidateClickHouseConfig();
  await client.initClickHouse();
  await client.clearAnalyticsEvents();
  postgres = await l4Host('db', ':5432');
  await l4Host('replica', ':5432');
  await l4Host('games', ':25565-25570', 'udp');
  ingested = await ingestAnalytics(
    'edge-1',
    'l4',
    [
      row(),
      row({ client_ip: '198.51.100.2', bytes_out: 3000 }),
      row({ ts: NOW - 3 * 86400 }),
      row({ network: 'udp', port: 25567 }),
      row({ network: 'udp', port: 5432 }),
      row({ port: 9999 }),
      { nonsense: true },
    ],
    1,
  );
});

afterAll(async () => {
  delete process.env.DEMO_MODE;
  delete process.env.DEMO_ANALYTICS_DB;
  await client.invalidateClickHouseConfig();
});

const logL4 = (on: boolean) => setSetting('logging', { enabled: false, l4Connections: on });

describe('parseL4Row', () => {
  it('keeps a well-formed row and refuses the rest', () => {
    expect(parseL4Row(row())).toMatchObject({ port: 5432, network: 'tcp' });
    expect(parseL4Row(row({ network: 'unix' }))).toBeNull();
    expect(parseL4Row(row({ port: 0 }))).toBeNull();
    expect(parseL4Row(row({ bytes_in: -1 }))).toBeNull();
    expect(parseL4Row({ ...row(), extra: 'x' })).not.toHaveProperty('extra');
  });
});

describe('L4 connections', () => {
  it('keeps only rows for a port and protocol an L4 host listens on', () => {
    expect(ingested).toEqual({ accepted: 4, rejected: 3 });
  });

  it('is off until L4 connection logging is on', async () => {
    await logL4(false);
    expect(await getL4HostTraffic(postgres)).toEqual({ state: 'off' });
  });

  it("reads a host's last day by its port, and counts who shares it", async () => {
    await logL4(true);
    const traffic = await getL4HostTraffic(postgres, NOW * 1000);
    if (traffic.state !== 'on') throw new Error('expected traffic');
    expect(traffic.sharedWith).toBe(1);
    expect(traffic.report.totals).toEqual({
      connections: 2,
      bytesIn: 200,
      bytesOut: 4000,
      uniqueIps: 2,
      avgDurationMs: 2000,
    });
    expect(traffic.report.timeline.reduce((sum, b) => sum + b.connections, 0)).toBe(2);
    expect(traffic.report.clients.map((c) => c.ip).sort()).toEqual([
      '198.51.100.1',
      '198.51.100.2',
    ]);
  });

  it('reads a range by any port in it', async () => {
    await logL4(true);
    const games = { id: -1, protocol: 'udp' as const, listenAddress: ':25565-25570' };
    const traffic = await getL4HostTraffic(games, NOW * 1000);
    expect(traffic.state === 'on' && traffic.report.totals.connections).toBe(1);
  });
});
