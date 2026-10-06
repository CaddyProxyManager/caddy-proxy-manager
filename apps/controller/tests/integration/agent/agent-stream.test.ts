/**
 * A command must not outlive its agent, a reconnect must not leave two live streams, and a
 * result must not be settleable by an agent it was not issued to.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { AgentDesiredState, AgentServerEvent, AgentStatus } from '@cpm/shared';

const {
  attach,
  detach,
  connectedAgents,
  isConnected,
  recordStatus,
  dispatchCaddyAdmin,
  settleResults,
  broadcastDesiredState,
  resetRegistry,
  AgentNotConnectedError,
} = await import('../../../src/lib/agent/registry');

const STATE: AgentDesiredState = {
  l4Ports: [],
  caddyModules: [],
  services: { services: { clickhouse: false }, env: {} },
  fleetConfig: { clickhouse: null, analytics: false, geoip: null },
  caddyEnabled: true,
};

function status(agentId: string): AgentStatus {
  return {
    agentId,
    version: 'test',
    mode: 'standalone',
    composeProject: 'cpm',
    l4Ports: { applied: [], status: { state: 'idle' } },
    caddyBuild: { applied: null, status: { state: 'idle' } },
    services: { applied: null, status: { state: 'idle' } },
    analytics: { enabled: false, accessLogPresent: false },
  };
}

/** Collects events, not SSE bytes: framing is the GraphQL server's job. */
function connect(agentId: string, name = agentId) {
  const { events } = attach({
    agentId,
    agentRowId: 1,
    name,
    controllerId: 'c1',
    controllerName: 'Test',
    initialState: STATE,
  });

  const frames: AgentServerEvent[] = [];

  const pump = (async () => {
    for await (const event of events) {
      // Keepalives have their own test; here they would make ordering depend on timing.
      if (event.type !== 'ping') frames.push(event);
    }
  })().catch(() => {
    // Closed by detach; that is the normal end of a connection.
  });

  return { frames, pump };
}

afterEach(() => {
  resetRegistry();
});

describe('attaching', () => {
  it('greets a new agent and sends it the desired state before anything else', async () => {
    const { frames } = connect('a1');
    await Bun.sleep(5);

    expect(frames[0]).toEqual({ type: 'hello', controllerId: 'c1', controllerName: 'Test' });
    expect(frames[1]).toEqual({ type: 'desired-state', state: STATE });
  });

  it('replaces a reconnecting agent rather than attaching it twice', async () => {
    connect('a1');
    await Bun.sleep(5);
    const second = connect('a1');
    await Bun.sleep(5);

    // The *new* stream wins, or every command after a partition would be sent twice.
    expect(connectedAgents()).toHaveLength(1);
    await broadcastDesiredState(async () => ({ ...STATE, caddyEnabled: false }));
    await Bun.sleep(5);
    expect(second.frames.at(-1)).toEqual({
      type: 'desired-state',
      state: { ...STATE, caddyEnabled: false },
    });
  });

  it('reports an agent as gone once detached', async () => {
    connect('a1');
    await Bun.sleep(5);
    expect(isConnected('a1')).toBe(true);
    detach('a1');
    expect(isConnected('a1')).toBe(false);
    expect(connectedAgents()).toHaveLength(0);
  });
});

describe('status', () => {
  it('keeps the last status beside the connection', async () => {
    connect('a1');
    await Bun.sleep(5);
    recordStatus('a1', status('a1'));
    expect(connectedAgents()[0].status?.agentId).toBe('a1');
  });

  it('ignores a status from an agent that is not attached', () => {
    recordStatus('ghost', status('ghost'));
    expect(connectedAgents()).toHaveLength(0);
  });
});

describe('commands', () => {
  it('drops a stream nobody has read for a keepalive, so a command fails rather than waits', async () => {
    // Attached, but never read: what a transport that died without telling Yoga looks like.
    attach({
      agentId: 'stalled',
      agentRowId: 1,
      name: 'stalled',
      controllerId: 'c1',
      controllerName: 'Test',
      initialState: STATE,
    });
    const realNow = Date.now;
    Date.now = () => realNow() + 25_000;
    try {
      await expect(
        dispatchCaddyAdmin('stalled', { path: '/config/', method: 'GET' }),
      ).rejects.toBeInstanceOf(AgentNotConnectedError);
      expect(isConnected('stalled')).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  it('delivers a command and resolves with the agent’s answer', async () => {
    const { frames } = connect('a1');
    await Bun.sleep(5);

    const pending = dispatchCaddyAdmin('a1', { path: '/config/', method: 'GET' });
    await Bun.sleep(5);

    const frame = frames.at(-1);
    expect(frame?.type).toBe('command');
    const id = frame?.type === 'command' ? frame.command.id : '';

    settleResults('a1', [
      { id, ok: true, response: { status: 200, text: '{"ok":true}', headers: {} } },
    ]);
    await expect(pending).resolves.toEqual({ status: 200, text: '{"ok":true}', headers: {} });
  });

  it('rejects when the agent reports a failure', async () => {
    const { frames } = connect('a1');
    await Bun.sleep(5);

    const pending = dispatchCaddyAdmin('a1', { path: '/load', method: 'POST' });
    await Bun.sleep(5);
    const frame = frames.at(-1);
    const id = frame?.type === 'command' ? frame.command.id : '';

    settleResults('a1', [{ id, ok: false, error: 'Caddy refused it', code: 'INTERNAL' }]);
    await expect(pending).rejects.toThrow('Caddy refused it');
  });

  it('refuses to dispatch to an agent that is not connected', async () => {
    await expect(dispatchCaddyAdmin('nobody', { path: '/config/', method: 'GET' })).rejects.toThrow(
      AgentNotConnectedError,
    );
  });

  it('fails anything in flight when the agent disconnects', async () => {
    connect('a1');
    await Bun.sleep(5);

    const pending = dispatchCaddyAdmin('a1', { path: '/config/', method: 'GET' });
    await Bun.sleep(5);
    detach('a1');

    // Immediately, rather than holding a page render open until the timeout.
    await expect(pending).rejects.toThrow(AgentNotConnectedError);
  });

  it('will not let one agent settle another’s command', async () => {
    const first = connect('a1');
    connect('a2');
    await Bun.sleep(5);

    const pending = dispatchCaddyAdmin('a1', { path: '/config/', method: 'GET' });
    await Bun.sleep(5);
    const frame = first.frames.at(-1);
    const id = frame?.type === 'command' ? frame.command.id : '';

    settleResults('a2', [{ id, ok: true, response: { status: 200, text: 'stolen', headers: {} } }]);

    // a2 must not answer for a1. Settled properly so no live timer is left behind.
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Bun.sleep(10);
    expect(settled).toBe(false);

    settleResults('a1', [{ id, ok: true, response: { status: 200, text: 'real', headers: {} } }]);
    await expect(pending).resolves.toMatchObject({ text: 'real' });
  });
});

describe('broadcast', () => {
  it('reaches every attached agent', async () => {
    const a = connect('a1');
    const b = connect('a2');
    await Bun.sleep(5);

    const next = { ...STATE, l4Ports: ['3306:3306'] };
    await broadcastDesiredState(async () => next);
    await Bun.sleep(5);

    expect(a.frames.at(-1)).toEqual({ type: 'desired-state', state: next });
    expect(b.frames.at(-1)).toEqual({ type: 'desired-state', state: next });
  });

  it('builds a separate state for each agent, and skips the ones that would not build', async () => {
    // Agents can want different ports; one whose state cannot be computed keeps its last one.
    const a = connect('a1');
    const b = connect('a2');
    await Bun.sleep(5);
    const bBefore = b.frames.at(-1);

    await broadcastDesiredState(async (agent) =>
      agent.agentId === 'a1' ? { ...STATE, l4Ports: ['3306:3306'] } : null,
    );
    await Bun.sleep(5);

    expect(a.frames.at(-1)).toEqual({
      type: 'desired-state',
      state: { ...STATE, l4Ports: ['3306:3306'] },
    });
    expect(b.frames.at(-1)).toEqual(bBefore);
  });
});
