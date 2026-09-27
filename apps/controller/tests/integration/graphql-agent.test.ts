/**
 * Drives the schema directly: the SSE framing is the server's to get right. The gate between agent
 * and operator fields would break silently, so both directions are asserted, not assumed.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => {
  return {
    default: ctx.db,
    sqlite: undefined,
    schema: schemaModule,
    nowIso: () => new Date().toISOString(),
    toIso: (value: string | Date | null | undefined): string | null => {
      if (!value) return null;
      return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    },
  };
});

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

// The signature check is tested in agent/verify; here only its answer varies.
const verified = { ok: true as const, agent: { id: 1, agentId: 'a1', name: 'edge' } };
let verifyResult: unknown = verified;
vi.mock('../../src/lib/agent/verify', () => ({
  verifyAgentRequest: async () => verifyResult,
}));

// Desired state is built from the database; what it contains is agent-fleet's business.
vi.mock('../../src/lib/agent/desired-state', () => ({
  buildDesiredState: async () => ({
    l4Ports: [],
    caddyModules: [],
    services: { services: { clickhouse: false }, env: {} },
    fleetConfig: { clickhouse: null, analytics: false, geoip: null },
    caddyEnabled: true,
  }),
}));

// What becomes of relayed rows is agent/analytics-ingest's business; these tests pin the gate.
const ingest = vi.hoisted(() => ({
  calls: [] as { agentId: string; kind: unknown; rows: unknown[] }[],
  failure: null as Error | null,
}));
vi.mock('../../src/lib/agent/analytics-ingest', () => {
  class AnalyticsIngestError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    AnalyticsIngestError,
    ingestAnalytics: async (agentId: string, kind: unknown, rows: unknown[]) => {
      if (ingest.failure) throw ingest.failure;
      ingest.calls.push({ agentId, kind, rows });
      return { accepted: rows.length, rejected: 0 };
    },
  };
});
const { AnalyticsIngestError } = await import('../../src/lib/agent/analytics-ingest');

import { graphql, subscribe, parse } from 'graphql';
import type { ExecutionResult } from 'graphql';
import { schema } from '../../src/lib/graphql/schema';
import type { GraphQLContext } from '../../src/lib/graphql/context';
import { AGENT_OPERATIONS } from '@cpm/shared';
import { connectedAgents, detach, isConnected } from '../../src/lib/agent/registry';

function agentContext(): GraphQLContext {
  return {
    viewer: async () => {
      throw new Error('Unauthorized');
    },
    access: async () => {
      throw new Error('Unauthorized');
    },
    rawBody: async () => '{}',
    request: { headers: new Headers() } as never,
  };
}

function userContext(role: string): GraphQLContext {
  return {
    viewer: async () => ({ userId: 1, role, authMethod: 'bearer' as const }),
    access: async () => ({
      userId: 1,
      role,
      isAdmin: role === 'admin',
      isOperator: false,
      grants: { proxyHosts: new Map(), l4ProxyHosts: new Map(), agents: new Map() },
    }),
    rawBody: async () => '{}',
    request: { headers: new Headers() } as never,
  };
}

afterEach(() => {
  verifyResult = verified;
  detach('a1');
});

describe('the agent subscription', () => {
  it('opens with hello and the desired state, in that order', async () => {
    const result = await subscribe({
      schema,
      document: parse(AGENT_OPERATIONS.events),
      contextValue: agentContext(),
    });

    // A refusal would come back as a single ExecutionResult rather than an iterator.
    expect(Symbol.asyncIterator in result).toBe(true);
    const iterator = result as AsyncIterableIterator<ExecutionResult>;

    const first = (await iterator.next()).value?.data?.agentEvents as { type: string };
    const second = (await iterator.next()).value?.data?.agentEvents as { type: string };

    expect(first.type).toBe('hello');
    expect(second.type).toBe('desired-state');

    // Ending the consumer is the only way a disconnect is noticed.
    expect(isConnected('a1')).toBe(true);
    await iterator.return?.();
    expect(isConnected('a1')).toBe(false);
  });

  it('refuses an agent whose signature does not verify', async () => {
    verifyResult = { ok: false, status: 401, error: 'Unknown agent' };

    const result = (await subscribe({
      schema,
      document: parse(AGENT_OPERATIONS.events),
      contextValue: agentContext(),
    })) as ExecutionResult;

    expect(result.errors?.[0]?.message).toBe('Unknown agent');
    expect(isConnected('a1')).toBe(false);
  });
});

describe('the agent mutations', () => {
  async function connect() {
    const result = (await subscribe({
      schema,
      document: parse(AGENT_OPERATIONS.events),
      contextValue: agentContext(),
    })) as AsyncIterableIterator<ExecutionResult>;
    await result.next();
    return result;
  }

  const status = {
    agentId: 'a1',
    version: 'test',
    mode: 'standalone',
    composeProject: 'cpm',
    l4Ports: { applied: [], status: { state: 'idle' } },
    caddyBuild: { applied: null, status: { state: 'idle' } },
    services: { applied: null, status: { state: 'idle' } },
    analytics: { enabled: false, accessLogPresent: false },
  };

  it('records a status from a connected agent', async () => {
    const iterator = await connect();

    const result = await graphql({
      schema,
      source: AGENT_OPERATIONS.status,
      contextValue: agentContext(),
      variableValues: { status },
    });

    expect(result.errors).toBeUndefined();
    expect(connectedAgents().find((a) => a.agentId === 'a1')?.status).toMatchObject({
      agentId: 'a1',
    });
    await iterator.return?.();
  });

  it('refuses a status from an agent with no open subscription', async () => {
    // Accepting it would let the dashboard report a host as reachable when nothing can reach it.
    const result = await graphql({
      schema,
      source: AGENT_OPERATIONS.status,
      contextValue: agentContext(),
      variableValues: { status },
    });

    expect(result.errors?.[0]?.message).toContain('not connected');
  });
});

describe('the analytics relay', () => {
  afterEach(() => {
    ingest.calls = [];
    ingest.failure = null;
  });

  it('writes rows from a signed agent, with or without an open subscription', async () => {
    // Rows parsed while the stream was down still describe real traffic.
    const result = await graphql({
      schema,
      source: AGENT_OPERATIONS.analytics,
      contextValue: agentContext(),
      variableValues: { kind: 'traffic', rows: [{ host: 'a' }, { host: 'b' }] },
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?.agentAnalytics).toEqual({ accepted: 2, rejected: 0 });
    expect(ingest.calls).toEqual([
      { agentId: 'a1', kind: 'traffic', rows: [{ host: 'a' }, { host: 'b' }] },
    ]);
  });

  it('refuses rows that are not signed by a paired agent', async () => {
    verifyResult = { ok: false, status: 401, error: 'Unknown agent' };

    const result = await graphql({
      schema,
      source: AGENT_OPERATIONS.analytics,
      contextValue: userContext('admin'),
      variableValues: { kind: 'traffic', rows: [{}] },
    });

    expect(result.errors?.[0]?.message).toBe('Unknown agent');
    expect(ingest.calls).toEqual([]);
  });

  it('passes a refusal on with its code, so the agent keeps its place and resends', async () => {
    ingest.failure = new AnalyticsIngestError('ANALYTICS_DISABLED', 'Analytics are switched off.');

    const result = await graphql({
      schema,
      source: AGENT_OPERATIONS.analytics,
      contextValue: agentContext(),
      variableValues: { kind: 'waf', rows: [{}] },
    });

    expect(result.errors?.[0]?.message).toBe('Analytics are switched off.');
    expect(result.errors?.[0]?.extensions?.code).toBe('ANALYTICS_DISABLED');
  });
});

describe('the two credentials do not cross over', () => {
  it('refuses agent fields to a user token', async () => {
    verifyResult = { ok: false, status: 401, error: 'Unknown agent' };

    const result = await graphql({
      schema,
      source: AGENT_OPERATIONS.status,
      contextValue: userContext('admin'),
      variableValues: { status: {} },
    });

    expect(result.errors?.[0]?.message).toBe('Unknown agent');
  });

  it('refuses operator fields to an agent', async () => {
    // An agent secret must not be a way to read every host's configuration.
    const result = await graphql({
      schema,
      source: '{ proxyHosts { id } }',
      contextValue: agentContext(),
    });

    expect(result.errors?.[0]?.message).toContain('Unauthorized');
  });
});
