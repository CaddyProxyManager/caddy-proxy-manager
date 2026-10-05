/**
 * L4 port computation and the round trip through the agent. The agent speaks the real protocol
 * (tests/helpers/fake-agent.ts), so every assertion also checks the signing, which fails silently.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

// ---------------------------------------------------------------------------
// Mock the database the port computation reads from.
// ---------------------------------------------------------------------------

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

// Hoisted: an async Bun mock factory never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}));

import * as schema from '../../../src/lib/db/schema';
const {
  getRequiredL4Ports,
  getAppliedL4Ports,
  getL4PortsDiff,
  applyL4Ports,
  getL4PortsStatus,
  isAgentAvailable,
} = await import('../../../src/lib/l4/ports');
const { startFakeAgent, clearAgentEnv } = await import('../../helpers/fake-agent');

type FakeAgent = Awaited<ReturnType<typeof startFakeAgent>>;
let agent: FakeAgent;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function makeL4Host(overrides: Partial<typeof schema.l4ProxyHosts.$inferInsert> = {}) {
  const now = nowIso();
  return {
    name: 'Test L4 Host',
    protocol: 'tcp',
    listenAddress: ':5432',
    upstreams: JSON.stringify(['10.0.0.1:5432']),
    matcherType: 'none',
    matcherValue: null,
    tlsTermination: false,
    proxyProtocolVersion: null,
    proxyProtocolReceive: false,
    ownerUserId: null,
    meta: null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } satisfies typeof schema.l4ProxyHosts.$inferInsert;
}

beforeEach(async () => {
  await ctx.db.delete(schema.l4ProxyHosts);
  agent = await startFakeAgent();
});

afterEach(async () => {
  await agent.stop();
});

// ---------------------------------------------------------------------------
// getRequiredL4Ports
// ---------------------------------------------------------------------------

describe('getRequiredL4Ports', () => {
  it('returns empty array when no L4 hosts exist', async () => {
    const ports = await getRequiredL4Ports();
    expect(ports).toEqual([]);
  });

  it('returns TCP port for enabled host', async () => {
    await ctx.db.insert(schema.l4ProxyHosts).values(
      makeL4Host({
        listenAddress: ':5432',
        protocol: 'tcp',
        enabled: true,
      }),
    );
    const ports = await getRequiredL4Ports();
    expect(ports).toEqual(['5432:5432']);
  });

  it('returns UDP port with /udp suffix', async () => {
    await ctx.db.insert(schema.l4ProxyHosts).values(
      makeL4Host({
        listenAddress: ':5353',
        protocol: 'udp',
        enabled: true,
      }),
    );
    const ports = await getRequiredL4Ports();
    expect(ports).toEqual(['5353:5353/udp']);
  });

  it('excludes disabled hosts', async () => {
    await ctx.db.insert(schema.l4ProxyHosts).values(
      makeL4Host({
        name: 'Enabled',
        listenAddress: ':5432',
        enabled: true,
      }),
    );
    await ctx.db.insert(schema.l4ProxyHosts).values(
      makeL4Host({
        name: 'Disabled',
        listenAddress: ':3306',
        enabled: false,
      }),
    );
    const ports = await getRequiredL4Ports();
    expect(ports).toEqual(['5432:5432']);
  });

  it('deduplicates ports from multiple hosts on same address', async () => {
    await ctx.db.insert(schema.l4ProxyHosts).values(
      makeL4Host({
        name: 'Host 1',
        listenAddress: ':5432',
      }),
    );
    await ctx.db.insert(schema.l4ProxyHosts).values(
      makeL4Host({
        name: 'Host 2',
        listenAddress: ':5432',
      }),
    );
    const ports = await getRequiredL4Ports();
    expect(ports).toEqual(['5432:5432']);
  });

  it('handles HOST:PORT format', async () => {
    await ctx.db.insert(schema.l4ProxyHosts).values(
      makeL4Host({
        listenAddress: '0.0.0.0:5432',
      }),
    );
    const ports = await getRequiredL4Ports();
    expect(ports).toEqual(['5432:5432']);
  });

  it('returns multiple ports sorted', async () => {
    await ctx.db.insert(schema.l4ProxyHosts).values(
      makeL4Host({
        name: 'Redis',
        listenAddress: ':6379',
      }),
    );
    await ctx.db.insert(schema.l4ProxyHosts).values(
      makeL4Host({
        name: 'PG',
        listenAddress: ':5432',
      }),
    );
    await ctx.db.insert(schema.l4ProxyHosts).values(
      makeL4Host({
        name: 'MySQL',
        listenAddress: ':3306',
      }),
    );
    const ports = await getRequiredL4Ports();
    expect(ports).toEqual(['3306:3306', '5432:5432', '6379:6379']);
  });
});

// ---------------------------------------------------------------------------
// getAppliedL4Ports
// ---------------------------------------------------------------------------

describe('getAppliedL4Ports', () => {
  it('is empty when the agent has published nothing', async () => {
    expect(await getAppliedL4Ports()).toEqual([]);
  });

  it('reports what the agent says is published', async () => {
    agent.state.appliedPorts = ['3306:3306', '5432:5432'];
    expect(await getAppliedL4Ports()).toEqual(['3306:3306', '5432:5432']);
  });

  it('is empty when no agent is reachable at all', async () => {
    await agent.stop();
    clearAgentEnv();
    // Not an error: pages must still render with the agent down.
    expect(await getAppliedL4Ports()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getL4PortsDiff
// ---------------------------------------------------------------------------

describe('getL4PortsDiff', () => {
  it('needsApply is false when nothing is required and nothing is published', async () => {
    const diff = await getL4PortsDiff();
    expect(diff.needsApply).toBe(false);
    expect(diff.requiredPorts).toEqual([]);
    expect(diff.currentPorts).toEqual([]);
  });

  it('needsApply is true when a host needs a port the agent has not published', async () => {
    await ctx.db.insert(schema.l4ProxyHosts).values(makeL4Host({ listenAddress: ':5432' }));
    const diff = await getL4PortsDiff();
    expect(diff.needsApply).toBe(true);
    expect(diff.requiredPorts).toEqual(['5432:5432']);
    expect(diff.currentPorts).toEqual([]);
  });

  it('needsApply is false once the agent publishes exactly those ports', async () => {
    await ctx.db.insert(schema.l4ProxyHosts).values(makeL4Host({ listenAddress: ':5432' }));
    agent.state.appliedPorts = ['5432:5432'];
    expect((await getL4PortsDiff()).needsApply).toBe(false);
  });

  it('needsApply is true when the agent publishes a different port', async () => {
    await ctx.db.insert(schema.l4ProxyHosts).values(makeL4Host({ listenAddress: ':5432' }));
    agent.state.appliedPorts = ['3306:3306'];
    expect((await getL4PortsDiff()).needsApply).toBe(true);
  });

  it('needsApply is true for a required port when the agent is unreachable', async () => {
    await ctx.db.insert(schema.l4ProxyHosts).values(makeL4Host({ listenAddress: ':5432' }));
    await agent.stop();
    clearAgentEnv();
    // "Already up" would be the one answer an operator cannot act on.
    expect((await getL4PortsDiff()).needsApply).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyL4Ports
// ---------------------------------------------------------------------------

describe('applyL4Ports', () => {
  it('pushes the required ports to the agent', async () => {
    await ctx.db.insert(schema.l4ProxyHosts).values(makeL4Host({ listenAddress: ':5432' }));
    await applyL4Ports();
    expect(agent.desired?.l4Ports).toEqual(['5432:5432']);
  });

  it('returns the in-progress status the agent answers with', async () => {
    await ctx.db.insert(schema.l4ProxyHosts).values(makeL4Host({ listenAddress: ':5432' }));
    // A recreate takes seconds, so the agent answers at once and the controller polls.
    expect((await applyL4Ports()).state).toBe('pending');

    agent.completeL4Ports();
    expect(await getAppliedL4Ports()).toEqual(['5432:5432']);
    expect((await getL4PortsStatus()).state).toBe('applied');
  });

  it('pushes an empty list when no host needs a port', async () => {
    await applyL4Ports();
    expect(agent.desired?.l4Ports).toEqual([]);
  });

  it('sends the same ports for the same hosts, whatever order they were added in', async () => {
    await ctx.db
      .insert(schema.l4ProxyHosts)
      .values([
        makeL4Host({ listenAddress: ':6379', name: 'b' }),
        makeL4Host({ listenAddress: ':5432', name: 'a' }),
      ]);
    await applyL4Ports();
    expect(agent.desired?.l4Ports).toEqual(['5432:5432', '6379:6379']);
  });

  it('fails loudly when there is no agent to send to', async () => {
    await agent.stop();
    clearAgentEnv();
    // Unlike the reads, a clicked button must be told nothing happened.
    expect(applyL4Ports()).rejects.toThrow(/agent/i);
  });
});

// ---------------------------------------------------------------------------
// getL4PortsStatus / isAgentAvailable
// ---------------------------------------------------------------------------

describe('getL4PortsStatus', () => {
  it('is idle before anything has been applied', async () => {
    expect(await getL4PortsStatus()).toEqual({ state: 'idle' });
  });

  it('reports what the agent last did', async () => {
    agent.state.l4Status = { state: 'applied', message: 'Recreated', appliedAt: 'now' };
    expect(await getL4PortsStatus()).toEqual({
      state: 'applied',
      message: 'Recreated',
      appliedAt: 'now',
    });
  });

  it('reports a failure the agent recorded', async () => {
    agent.state.l4Status = { state: 'failed', message: 'port in use', error: 'port in use' };
    const status = await getL4PortsStatus();
    expect(status.state).toBe('failed');
    expect(status.error).toBe('port in use');
  });

  it('is idle when no agent is reachable', async () => {
    await agent.stop();
    clearAgentEnv();
    expect(await getL4PortsStatus()).toEqual({ state: 'idle' });
  });
});

describe('isAgentAvailable', () => {
  it('is true while the agent answers', async () => {
    expect(await isAgentAvailable()).toBe(true);
  });

  it('is false with nothing configured', async () => {
    await agent.stop();
    clearAgentEnv();
    expect(await isAgentAvailable()).toBe(false);
  });

  it('is false once the agent disconnects', async () => {
    await agent.stop();
    // Without an open stream an agent cannot be reached at all.
    expect(await isAgentAvailable()).toBe(false);
    clearAgentEnv();
  });
});

// ---------------------------------------------------------------------------
// Port ranges
// ---------------------------------------------------------------------------

describe('port ranges', () => {
  it('publishes a range as one compose entry, with the protocol suffix', async () => {
    await ctx.db
      .insert(schema.l4ProxyHosts)
      .values([
        makeL4Host({ name: 'rtp', listenAddress: ':10000-10099', protocol: 'udp' }),
        makeL4Host({ name: 'ftp', listenAddress: '[::]:30000-30009' }),
      ]);
    expect(await getRequiredL4Ports()).toEqual([
      '10000-10099:10000-10099/udp',
      '30000-30009:30000-30009',
    ]);
  });

  it('merges overlapping and adjacent ports, so none is published twice', async () => {
    await ctx.db
      .insert(schema.l4ProxyHosts)
      .values([
        makeL4Host({ name: 'a', listenAddress: '10.0.0.1:5000-5010' }),
        makeL4Host({ name: 'b', listenAddress: '10.0.0.2:5005-5020' }),
        makeL4Host({ name: 'c', listenAddress: ':5021' }),
        makeL4Host({ name: 'd', listenAddress: ':5023' }),
        makeL4Host({ name: 'e', listenAddress: ':5005', protocol: 'udp' }),
      ]);
    expect(await getRequiredL4Ports()).toEqual([
      '5000-5021:5000-5021',
      '5005:5005/udp',
      '5023:5023',
    ]);
  });

  it('publishes nothing for a range with a reserved port inside it', async () => {
    await ctx.db
      .insert(schema.l4ProxyHosts)
      .values([
        makeL4Host({ name: 'legacy', listenAddress: ':2000-2100' }),
        makeL4Host({ name: 'ok', listenAddress: ':5432' }),
      ]);
    expect(await getRequiredL4Ports()).toEqual(['5432:5432']);
  });

  it('sees no change while an older agent reports the range port by port', async () => {
    await ctx.db.insert(schema.l4ProxyHosts).values(makeL4Host({ listenAddress: ':5000-5002' }));
    agent.state.appliedPorts = ['5000:5000', '5001:5001', '5002:5002'];
    expect((await getL4PortsDiff()).needsApply).toBe(false);
    agent.state.appliedPorts = ['5000:5000', '5001:5001'];
    expect((await getL4PortsDiff()).needsApply).toBe(true);
  });

  it('sends an agent without l4-port-ranges each port on its own', async () => {
    await ctx.db.insert(schema.l4ProxyHosts).values(makeL4Host({ listenAddress: ':5000-5002' }));
    await applyL4Ports();
    expect(agent.desired?.l4Ports).toEqual(['5000:5000', '5001:5001', '5002:5002']);
  });

  it('sends the range itself to an agent that takes ranges', async () => {
    await agent.stop();
    agent = await startFakeAgent({}, { capabilities: ['l4-port-ranges'] });
    agent.report();
    await ctx.db.insert(schema.l4ProxyHosts).values(makeL4Host({ listenAddress: ':5000-5002' }));
    await applyL4Ports();
    expect(agent.desired?.l4Ports).toEqual(['5000-5002:5000-5002']);
  });
});
