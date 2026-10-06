/**
 * Both sides: the simulated agent must look finished to the pages, and every door a real agent or
 * Caddy could come through must stay shut.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { AgentDesiredState } from '@cpm/shared';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

// Hoisted out of the factory: a Bun mock factory must be synchronous.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

const { broadcastDesiredState, connectedAgents, detach, dispatchCaddyAdmin, resetRegistry } =
  await import('../../../src/lib/agent/registry');
const { DEMO_AGENT_ID, startSimulatedAgent } = await import(
  '../../../src/lib/demo/simulated-agent'
);
const { httpCaddyAdminTransport } = await import('../../../src/lib/caddy/admin');
const { issueBootstrapToken } = await import('../../../src/lib/agent/bootstrap');
const { requireAgent } = await import('../../../src/lib/graphql/agent');
const { findAgentRowByAgentId } = await import('../../../src/lib/models/agents');
const { POST: pair } = await import('../../../src/app/api/agent/v1/pair/route');

const FAST = { ports: 20, build: 20, services: 20 };

async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the simulated agent');
    await Bun.sleep(5);
  }
}

const demoStatus = () => connectedAgents().find((a) => a.agentId === DEMO_AGENT_ID)?.status ?? null;

beforeEach(() => {
  process.env.DEMO_MODE = 'true';
});

afterEach(() => {
  delete process.env.DEMO_MODE;
  resetRegistry();
});

describe('simulated agent', () => {
  it('pairs itself once and reports a status as soon as it attaches', async () => {
    const first = await startSimulatedAgent(FAST);
    expect(first).not.toBeNull();
    await until(() => demoStatus() !== null);
    expect((await findAgentRowByAgentId(DEMO_AGENT_ID))?.name).toBe('Demo agent');

    first?.stop();
    const second = await startSimulatedAgent(FAST);
    expect(second?.agentRowId).toBe(first?.agentRowId);
  });

  it('answers Caddy admin calls from memory', async () => {
    await startSimulatedAgent(FAST);
    const body = JSON.stringify({ apps: { http: { servers: {} } } });

    expect(
      (await dispatchCaddyAdmin(DEMO_AGENT_ID, { method: 'POST', path: '/load', body })).status,
    ).toBe(200);
    const readBack = await dispatchCaddyAdmin(DEMO_AGENT_ID, { method: 'GET', path: '/config/' });
    expect(readBack.text).toBe(body);
  });

  it('finishes a rebuild and a port change after a delay, as a real agent would', async () => {
    await startSimulatedAgent(FAST);
    await until(() => demoStatus() !== null);

    const state: AgentDesiredState = {
      l4Ports: ['5432:5432'],
      caddyModules: ['github.com/example/module'],
      services: { services: { clickhouse: true }, env: {} },
      fleetConfig: { clickhouse: null, analytics: true, geoip: null },
      caddyEnabled: true,
    };
    await broadcastDesiredState(async () => state);

    await until(() => demoStatus()?.caddyBuild.status.state === 'building');
    await until(() => demoStatus()?.caddyBuild.status.state === 'applied');
    await until(() => demoStatus()?.l4Ports.status.state === 'applied');
    await until(() => demoStatus()?.services.status.state === 'applied');

    const status = demoStatus();
    expect(status?.caddyBuild.applied).toEqual(state.caddyModules);
    expect(status?.l4Ports.applied).toEqual(state.l4Ports);
    expect(status?.services.applied).toEqual({ clickhouse: true, crowdsec: false });
    expect(status?.analytics).toEqual({ enabled: true, accessLogPresent: true });
  });

  it('stays gone once unpaired', async () => {
    await startSimulatedAgent(FAST);
    detach(DEMO_AGENT_ID);
    expect(connectedAgents()).toHaveLength(0);
  });
});

describe('nothing real gets in', () => {
  it('refuses to open a socket to Caddy', async () => {
    await expect(httpCaddyAdminTransport({ method: 'GET', path: '/config/' })).rejects.toThrow(
      /demo mode/,
    );
  });

  it('refuses to pair an agent', async () => {
    const response = await pair(
      new Request('http://controller.test/api/agent/v1/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'ABCDEF', agentId: 'a'.repeat(32), agentVersion: '3.0.0' }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it('writes no bootstrap token for the bundled agent', async () => {
    expect(await issueBootstrapToken(null)).toBe(false);
  });

  it('turns an already-paired agent away without telling it to forget its pairing', async () => {
    const refused = requireAgent({} as Parameters<typeof requireAgent>[0], 1024);
    await expect(refused).rejects.toMatchObject({ extensions: { code: 'DEMO_MODE' } });
  });
});
