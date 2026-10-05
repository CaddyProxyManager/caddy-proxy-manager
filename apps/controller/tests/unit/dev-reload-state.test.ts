/**
 * The dev server re-evaluates a changed module without re-running register(); a query string
 * gives the same fresh instance here.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { AgentDesiredState } from '@cpm/shared';
import type { CaddyAdminTransport } from '../../src/lib/caddy/admin';

const admin = await import('../../src/lib/caddy/admin');
const registry = await import('../../src/lib/agent/registry');

let restore: CaddyAdminTransport | null = null;

afterEach(() => {
  if (restore) admin.setCaddyAdminTransport(restore);
  restore = null;
  registry.resetRegistry();
});

describe('state that survives a dev program reload', () => {
  it('keeps the installed Caddy admin transport', async () => {
    const transport: CaddyAdminTransport = async () => ({ status: 200, headers: {}, text: 'ok' });
    restore = admin.setCaddyAdminTransport(transport);

    const reloaded = (await import(
      `../../src/lib/caddy/admin.ts?reload=${Date.now()}`
    )) as typeof admin;
    expect(reloaded).not.toBe(admin);
    const response = await reloaded.caddyAdminRequest({ method: 'GET', path: '/config/' });
    expect(response.text).toBe('ok');
  });

  it('keeps the connected agents', async () => {
    registry.attach({
      agentId: 'a'.repeat(32),
      agentRowId: 1,
      name: 'edge',
      controllerId: 'c',
      controllerName: 'Controller',
      initialState: {} as AgentDesiredState,
    });

    const reloaded = (await import(
      `../../src/lib/agent/registry.ts?reload=${Date.now()}`
    )) as typeof registry;
    expect(reloaded).not.toBe(registry);
    expect(reloaded.isConnected('a'.repeat(32))).toBe(true);
    expect(reloaded.connectedAgents().map((agent) => agent.name)).toEqual(['edge']);
  });
});
