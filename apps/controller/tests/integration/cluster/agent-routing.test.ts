/**
 * Reaching an agent whose stream another replica holds. The other replica is played by rows
 * written straight to the tables and NOTIFYs sent from a second session, as it would send them;
 * this process is the real registry and broker. PostgreSQL only: the bus is LISTEN/NOTIFY.
 */
import { SQL } from 'bun';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from 'bun:test';
import type { AgentDesiredState, AgentServerEvent, AgentStatus } from '@cpm/shared';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

// A NOTIFY can take seconds to arrive on a loaded CI runner, past Bun's 5s default.
setDefaultTimeout(20_000);

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
const { createTestDb } = await import('../../helpers/db');
ctx.db = await createTestDb();
vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import * as schema from '../../../src/lib/db/schema';
const registry = await import('../../../src/lib/agent/registry');
const { syncAgentConnections } = await import('../../../src/lib/agent/broker');
const { listenForMessages, stopListening } = await import('../../../src/lib/cluster/bus');
const { cluster } = await import('../../../src/lib/cluster/state');
const { postgresClient } = await import('../../../src/lib/db/connection');

const OTHER = '00000000-0000-4000-8000-000000000001';
const STATE = {} as AgentDesiredState;
const STATUS = { capabilities: ['caddy-validate'] } as unknown as AgentStatus;

let other: SQL;

/** A message from the other replica, as its bus would send it. */
async function fromOther(type: string, data?: unknown, to?: string): Promise<void> {
  await other.notify('cpm_bus', JSON.stringify({ from: OTHER, type, to, data }));
}

async function eventually<T>(check: () => Promise<T> | T, ms = 10_000): Promise<NonNullable<T>> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > until) throw new Error('timed out');
    await Bun.sleep(20);
  }
}

async function otherIsLive(now = Date.now()): Promise<void> {
  await ctx.db
    .insert(schema.controllerReplicas)
    .values({ id: OTHER, hostname: 'b', keyFingerprint: 'x', startedAt: now, heartbeatAt: now })
    .onConflictDoUpdate({ target: schema.controllerReplicas.id, set: { heartbeatAt: now } });
}

async function heldByOther(agentId: string, status: AgentStatus | null = null): Promise<void> {
  const now = Date.now();
  await ctx.db.insert(schema.agentConnections).values({
    agentId,
    replicaId: OTHER,
    agentRowId: 7,
    name: `agent ${agentId}`,
    connectedAt: now,
    lastSeenAt: now,
    status: status ? JSON.stringify(status) : null,
  });
}

function attachHere(agentId: string) {
  const attached = registry.attach({
    agentId,
    agentRowId: 3,
    name: `agent ${agentId}`,
    controllerId: 'c',
    controllerName: 'CPM',
    initialState: STATE,
  });
  const received: AgentServerEvent[] = [];
  let ended = false;
  void (async () => {
    for await (const event of attached.events) received.push(event);
    ended = true;
  })();
  return { received, ended: () => ended };
}

describe.skipIf(postgresClient === null)('agent routing across replicas', () => {
  beforeAll(async () => {
    other = new SQL({ url: process.env.TEST_POSTGRES_URL ?? '', max: 1 });
    if (postgresClient) await listenForMessages(postgresClient);
  });

  afterAll(async () => {
    await stopListening();
    await other.close();
  });

  beforeEach(async () => {
    ctx.db = await createTestDb();
    registry.resetRegistry();
    cluster.started = true;
    await otherIsLive();
  });

  afterEach(() => {
    registry.resetRegistry();
    cluster.started = false;
  });

  it('counts an agent another live replica holds as connected, but not as its own', async () => {
    await heldByOther('aa01', STATUS);
    await syncAgentConnections();
    expect(registry.isConnected('aa01')).toBe(true);
    expect(registry.connectedAgents().map((agent) => [agent.agentId, agent.status])).toEqual([
      ['aa01', STATUS],
    ]);
    expect(registry.localAgents()).toEqual([]);
  });

  it('forgets the streams of a replica gone quiet', async () => {
    await heldByOther('aa01');
    await otherIsLive(Date.now() - 60_000);
    await syncAgentConnections();
    expect(registry.isConnected('aa01')).toBe(false);
    expect(await ctx.db.select().from(schema.agentConnections)).toEqual([]);
  });

  it('records the streams it holds, and drops the row when one hangs up', async () => {
    attachHere('aa02');
    const row = await eventually(
      async () => (await ctx.db.select().from(schema.agentConnections))[0],
    );
    expect(row).toMatchObject({ agentId: 'aa02', replicaId: cluster.replicaId, agentRowId: 3 });

    registry.detach('aa02');
    await eventually(
      async () => (await ctx.db.select().from(schema.agentConnections)).length === 0,
    );
  });

  it('sends a command through the holder and resolves with the answer it relays', async () => {
    await heldByOther('aa01');
    await syncAgentConnections();

    const answer = registry.dispatchCaddyAdmin('aa01', {
      method: 'GET',
      path: '/config/',
    } as never);
    const [queued] = await eventually(async () => {
      const rows = await ctx.db.select().from(schema.agentOutbox);
      return rows.length > 0 ? rows : null;
    });
    expect(queued.replicaId).toBe(OTHER);
    const event = JSON.parse(queued.event) as Extract<AgentServerEvent, { type: 'command' }>;
    expect(event.command.kind).toBe('caddy-admin');
    expect(event.command.id.startsWith(`aa01:${cluster.replicaId}:`)).toBe(true);

    const response = { status: 200, headers: {}, body: '{}' };
    await ctx.db.insert(schema.agentCommandResults).values({
      commandId: event.command.id,
      replicaId: cluster.replicaId,
      result: JSON.stringify({ id: event.command.id, ok: true, response }),
      createdAt: Date.now(),
    });
    await fromOther('agent-result', undefined, cluster.replicaId);
    expect(await answer).toEqual(response as never);
  });

  it('fails a command at once when the holder says the agent is gone', async () => {
    await heldByOther('aa01');
    await syncAgentConnections();
    const answer = registry.dispatchCaddyAdmin('aa01', { method: 'GET', path: '/' } as never);
    const [queued] = await eventually(async () => {
      const rows = await ctx.db.select().from(schema.agentOutbox);
      return rows.length > 0 ? rows : null;
    });
    const { command } = JSON.parse(queued.event) as Extract<AgentServerEvent, { type: 'command' }>;
    await ctx.db.insert(schema.agentCommandResults).values({
      commandId: command.id,
      replicaId: cluster.replicaId,
      result: JSON.stringify({ id: command.id, notConnected: true }),
      createdAt: Date.now(),
    });
    await fromOther('agent-result', undefined, cluster.replicaId);
    // Not `expect(answer).rejects`: on a rejection from a LISTEN callback, Bun 1.4.2 stops
    // delivering notifications and the process never exits.
    const error = await answer.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(registry.AgentNotConnectedError);
  });

  it("passes on an answer to another replica's command that the agent sent here", async () => {
    const id = `aa02:${OTHER}:1234`;
    await registry.settleResults('aa02', [{ id, ok: true, response: { status: 204 } } as never]);
    const [row] = await ctx.db.select().from(schema.agentCommandResults);
    expect(row).toMatchObject({ commandId: id, replicaId: OTHER });
  });

  it('refuses to pass on an answer for a command another agent was sent', async () => {
    await registry.settleResults('aa02', [{ id: `aa09:${OTHER}:1`, ok: true } as never]);
    expect(await ctx.db.select().from(schema.agentCommandResults)).toEqual([]);
  });

  it('delivers what another replica queued for a stream it holds', async () => {
    const stream = attachHere('aa03');
    await ctx.db.insert(schema.agentOutbox).values({
      id: 'e1',
      replicaId: cluster.replicaId,
      agentId: 'aa03',
      event: JSON.stringify({ type: 'restart', reason: 'test' }),
      createdAt: Date.now(),
    });
    await fromOther('agent-outbox', undefined, cluster.replicaId);
    await eventually(() => stream.received.some((event) => event.type === 'restart'));
    expect(await ctx.db.select().from(schema.agentOutbox)).toEqual([]);
  });

  it('tells the issuer when a queued command found no stream here', async () => {
    const command = { id: `aa04:${OTHER}:9`, kind: 'caddy-admin', request: {} };
    await ctx.db.insert(schema.agentOutbox).values({
      id: 'e2',
      replicaId: cluster.replicaId,
      agentId: 'aa04',
      event: JSON.stringify({ type: 'command', command }),
      createdAt: Date.now(),
    });
    await syncAgentConnections();
    const [row] = await ctx.db.select().from(schema.agentCommandResults);
    expect(row.replicaId).toBe(OTHER);
    expect(JSON.parse(row.result)).toEqual({ id: command.id, notConnected: true });
  });

  it('closes its stream when another replica takes the agent over', async () => {
    const stream = attachHere('aa05');
    await eventually(
      async () => (await ctx.db.select().from(schema.agentConnections)).length === 1,
    );
    await ctx.db.update(schema.agentConnections).set({ replicaId: OTHER });
    await fromOther('agent-attached', { agentId: 'aa05' });
    await eventually(() => stream.ended());
    expect(registry.localAgents()).toEqual([]);
    expect(registry.isConnected('aa05')).toBe(true);
    // Its row is the other replica's now, and closing here must not delete it.
    await Bun.sleep(50);
    expect((await ctx.db.select().from(schema.agentConnections))[0].replicaId).toBe(OTHER);
  });

  it("keeps a new stream whose claim has not yet overwritten the old replica's row", async () => {
    // The row of the stream this one replaced, still live and written before this one attached.
    await ctx.db.insert(schema.agentConnections).values({
      agentId: 'aa09',
      replicaId: OTHER,
      agentRowId: 3,
      name: 'agent aa09',
      connectedAt: Date.now() - 5_000,
      lastSeenAt: Date.now() - 5_000,
    });
    const stream = attachHere('aa09');
    await syncAgentConnections();
    expect(stream.ended()).toBe(false);
    expect(registry.localAgents().map((agent) => agent.agentId)).toEqual(['aa09']);
    const [row] = await ctx.db.select().from(schema.agentConnections);
    expect(row.replicaId).toBe(cluster.replicaId);
  });

  it('closes its stream at the heartbeat when another replica holds a newer one', async () => {
    const stream = attachHere('aa10');
    await eventually(
      async () => (await ctx.db.select().from(schema.agentConnections)).length === 1,
    );
    await ctx.db
      .update(schema.agentConnections)
      .set({ replicaId: OTHER, connectedAt: Date.now() + 1_000 });
    await syncAgentConnections();
    await eventually(() => stream.ended());
  });

  it('keeps a command on its own stream when the replica it left reports the old one gone', async () => {
    const stream = attachHere('aa11');
    const answer = registry.dispatchCaddyAdmin('aa11', { method: 'GET', path: '/' } as never);
    const sent = await eventually(() =>
      stream.received.find(
        (event): event is Extract<AgentServerEvent, { type: 'command' }> =>
          event.type === 'command',
      ),
    );
    // The stopped replica closing the stream this one replaced, a few seconds late.
    await fromOther('agent-detached', { agentId: 'aa11' });
    await Bun.sleep(200);
    await registry.settleResults('aa11', [
      { id: sent.command.id, ok: true, response: { status: 200 } } as never,
    ]);
    expect(await answer).toEqual({ status: 200 } as never);
  });

  it('drops a row of its own with no stream behind it', async () => {
    const now = Date.now();
    await ctx.db.insert(schema.agentConnections).values({
      agentId: 'aa08',
      replicaId: cluster.replicaId,
      agentRowId: 3,
      name: 'gone',
      connectedAt: now,
      lastSeenAt: now,
    });
    await syncAgentConnections();
    expect(await ctx.db.select().from(schema.agentConnections)).toEqual([]);
  });

  it('claims its stream again after the row went missing', async () => {
    attachHere('aa06');
    await eventually(
      async () => (await ctx.db.select().from(schema.agentConnections)).length === 1,
    );
    await ctx.db.delete(schema.agentConnections);
    await syncAgentConnections();
    expect((await ctx.db.select().from(schema.agentConnections))[0].replicaId).toBe(
      cluster.replicaId,
    );
  });

  it('records a status for an agent another replica holds, and returns the one it replaces', async () => {
    await heldByOther('aa01', STATUS);
    await syncAgentConnections();
    const next = { capabilities: [] } as unknown as AgentStatus;
    expect(await registry.recordStatus('aa01', next)).toEqual(STATUS);
    const [row] = await ctx.db.select().from(schema.agentConnections);
    expect(JSON.parse(row.status ?? 'null')).toEqual(next);
  });

  it('finds a stream another replica opened before the mirror heard of it', async () => {
    await heldByOther('aa07');
    expect(registry.isConnected('aa07')).toBe(false);
    expect(await registry.isConnectedAnywhere('aa07')).toBe(true);
  });

  it('asks the holder to close a stream it was told to detach', async () => {
    await heldByOther('aa01');
    await syncAgentConnections();
    const heard: string[] = [];
    const subscription = await other.listen('cpm_bus', (payload) => heard.push(payload));
    try {
      registry.detach('aa01');
      const message = await eventually(() =>
        heard.map((raw) => JSON.parse(raw)).find((parsed) => parsed.type === 'agent-detach'),
      );
      expect(message).toMatchObject({ to: OTHER, data: { agentId: 'aa01' } });
    } finally {
      await subscription.unlisten();
    }
  });
});
