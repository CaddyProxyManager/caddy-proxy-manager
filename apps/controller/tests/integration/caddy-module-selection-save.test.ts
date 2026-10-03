/**
 * Settings and PUT /api/v1/caddy/modules save the module selection alike. It is desired state, so
 * saving starts an agent's rebuild; the config is applied first, as a Caddy the rebuild recreates
 * resumes its autosave and must not find a module it lost. A failed apply sends nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

// Hoisted out of the factory: a Bun mock factory must be synchronous, or the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/src/lib/auth', () => ({
  requireAdmin: vi.fn(async () => ({ user: { id: '1', role: 'admin' } })),
}));

const actualApiAuth = await import('../../src/lib/api-auth');
vi.mock('../../src/lib/api-auth', () => ({
  ...actualApiAuth,
  requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
}));

import messages from '../../messages/en.json';
import { updateCaddyBuildSettingsAction } from '@/src/app/(dashboard)/settings/actions';
import { PUT } from '@/src/app/api/v1/caddy/modules/route';
import * as schema from '../../src/lib/db/schema';
import { type FakeCaddy, installFakeCaddy } from '../helpers/caddy-admin';
import { startFakeAgent } from '../helpers/fake-agent';

const L4 = 'github.com/mholt/caddy-l4';
const results = messages.settings.results;

let agent: Awaited<ReturnType<typeof startFakeAgent>>;
let caddy: FakeCaddy;
/** Config loads Caddy had seen when each new desired-state frame arrived. */
let loadsAtPush: number[];

function trackPushes() {
  loadsAtPush = [];
  const push = agent.requests.push.bind(agent.requests);
  agent.requests.push = (...entries) => {
    for (const entry of entries) {
      if (entry.kind === 'desired-state') loadsAtPush.push(caddy.loads.length);
    }
    return push(...entries);
  };
}

function withoutL4(): FormData {
  const form = new FormData();
  // Every other shipped module stays on; an unchecked box submits nothing.
  for (const id of ['coraza-waf', 'caddy-blocker', 'caddy-tailscale'])
    form.set(`module:${id}`, 'on');
  form.set('customModulesJson', '[]');
  return form;
}

function putRequest(body: unknown): any {
  return {
    headers: { get: () => null },
    method: 'PUT',
    nextUrl: { pathname: '/api/v1/caddy/modules', searchParams: new URLSearchParams() },
    json: async () => body,
  };
}

beforeEach(async () => {
  await ctx.db.delete(schema.settings);
  caddy = installFakeCaddy();
  agent = await startFakeAgent();
  trackPushes();
});

afterEach(async () => {
  await agent.stop();
});

describe('saving the module selection in Settings', () => {
  it('applies the config, then pushes the selection, and says the rebuild has started', async () => {
    const result = await updateCaddyBuildSettingsAction(null, withoutL4());

    expect(result).toEqual({ success: true, message: results.caddyBuildSavedBuilding });
    expect(agent.desired?.caddyModules).not.toContain(L4);
    expect(loadsAtPush.length).toBe(1);
    expect(loadsAtPush[0]).toBeGreaterThan(0);
  });

  it('pushes nothing when the config cannot be applied', async () => {
    caddy.failWith(500, 'nope');

    const result = await updateCaddyBuildSettingsAction(null, withoutL4());

    expect(result.message).toStartWith('Selection saved, but could not apply to Caddy');
    expect(loadsAtPush).toEqual([]);
  });

  it('says the rebuild waits for an agent when none is connected', async () => {
    await agent.stop();

    const result = await updateCaddyBuildSettingsAction(null, withoutL4());

    expect(result).toEqual({ success: true, message: results.caddyBuildSavedNoAgent });
  });
});

describe('PUT /api/v1/caddy/modules', () => {
  it('applies the config, then pushes the selection, as Settings does', async () => {
    const response = await PUT(putRequest({ modules: { 'caddy-l4': false } }));

    expect(response.status).toBe(200);
    expect(agent.desired?.caddyModules).not.toContain(L4);
    expect(loadsAtPush.length).toBe(1);
    expect(loadsAtPush[0]).toBeGreaterThan(0);
  });

  it('pushes nothing when the config cannot be applied', async () => {
    caddy.failWith(500, 'nope');

    const response = await PUT(putRequest({ modules: { 'caddy-l4': false } }));

    expect(response.status).toBe(500);
    expect(loadsAtPush).toEqual([]);
  });
});
