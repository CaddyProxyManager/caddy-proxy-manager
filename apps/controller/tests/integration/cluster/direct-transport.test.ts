/**
 * With no agent connected, a lone controller configures Caddy directly; with other controllers
 * live it refuses, or each would load its own config onto the same Caddy.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
const { createTestDb } = await import('../../helpers/db');
ctx.db = await createTestDb();
vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

const { agentCaddyAdminTransportWith } = await import('../../../src/lib/caddy/admin');
const { AgentRequiredError } = await import('../../../src/lib/agent/client');
const { resetRegistry } = await import('../../../src/lib/agent/registry');
const { cluster } = await import('../../../src/lib/cluster/state');
const { postgresClient } = await import('../../../src/lib/db/connection');

let directCalls = 0;
const transport = agentCaddyAdminTransportWith(async () => {
  directCalls++;
  return { status: 200, text: '{}', headers: {} };
});

beforeEach(() => {
  directCalls = 0;
  resetRegistry();
});

afterEach(() => {
  cluster.started = false;
  cluster.peers = 0;
});

describe('the direct Caddy transport', () => {
  it('is used by a lone controller with no agent', async () => {
    expect((await transport({ path: '/config/', method: 'GET' })).status).toBe(200);
    expect(directCalls).toBe(1);
  });

  it.skipIf(postgresClient === null)('is refused while other controllers are live', async () => {
    cluster.started = true;
    cluster.peers = 1;
    await expect(transport({ path: '/load', method: 'POST', body: '{}' })).rejects.toBeInstanceOf(
      AgentRequiredError,
    );
    expect(directCalls).toBe(0);
  });

  it('is never used for a request pinned to an agent', async () => {
    await expect(
      transport({ path: '/config/', method: 'GET', agentId: 'aa01' }),
    ).rejects.toBeInstanceOf(Error);
    expect(directCalls).toBe(0);
  });
});

describe.skipIf(postgresClient === null)('an apply refused for want of an agent', () => {
  it('says why, and answers the API with 503 rather than 500', async () => {
    const { applyCaddyConfig } = await import('../../../src/lib/caddy');
    const { setCaddyAdminTransport } = await import('../../../src/lib/caddy/admin');
    const { CaddyApplyError } = await import('../../../src/lib/caddy/apply-error');
    const { apiErrorResponse } = await import('../../../src/lib/api/auth');
    cluster.started = true;
    cluster.peers = 1;
    const previous = setCaddyAdminTransport(transport);
    try {
      const error = await applyCaddyConfig().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(CaddyApplyError);
      expect((error as InstanceType<typeof CaddyApplyError>).localized?.code).toBe(
        'caddyNeedsAgent',
      );
      const response = apiErrorResponse(error);
      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain('reached only through an agent');
      expect(directCalls).toBe(0);
    } finally {
      setCaddyAdminTransport(previous);
    }
  });
});
