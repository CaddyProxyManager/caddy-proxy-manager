/**
 * Settings -> Agents and Caddy build: pairing codes, unpairing and re-pairing, auto-pairing of
 * the bundled agent, per-agent module selections and the rebuild button. A fake agent attaches to
 * the real registry, so what reaches an agent is what the controller would send it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import { createTestDb, type TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  session: null as null | { user: import('../helpers/settings-actions').SessionUser },
}));

ctx.db = await createTestDb();

vi.mock('@/src/lib/db', () => dbModuleMock(() => ctx.db));
vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const actualAuth = await import('@/src/lib/auth');
vi.mock('@/src/lib/auth', () => ({
  ...actualAuth,
  auth: vi.fn(async () => ctx.session),
}));

import messages from '../../messages/en.json';
import {
  enableAutoPairingAction,
  pairingCodeAction,
  rebuildCaddyAction,
  repairAgentAction,
  revokePairingCodeAction,
  unpairAgentAction,
  updateCaddyBuildSettingsAction,
} from '@/src/app/(dashboard)/settings/actions';
import { AGENT_BOOTSTRAP_FILE } from '@cpm/shared';
import {
  autoPairingDisabled,
  recordBundledAgent,
  resetBootstrapState,
} from '@/src/lib/agent/bootstrap';
import { redeemRepairCode, resetPairingCodes } from '@/src/lib/agent/pairing-codes';
import { connectedAgents } from '@/src/lib/agent/registry';
import { CADDY_MODULES } from '@/src/lib/caddy-modules';
import { domainErrorMessage } from '@/src/lib/domain-error';
import { findAgentById, getAgentBuildSettings, insertPairedAgent } from '@/src/lib/models/agents';
import { getCaddyBuildSettings, saveWafSettings, setSetting } from '@/src/lib/settings';
import { invalidateSettingsCache } from '@/src/lib/settings/resolve';
import { type FakeAgent, startFakeAgent } from '../helpers/fake-agent';
import { type SessionUser, form, seedUser } from '../helpers/settings-actions';

const results = messages.settings.results;
const ADMIN_REQUIRED = domainErrorMessage('adminRequired');
const L4 = 'github.com/mholt/caddy-l4';

let admin: SessionUser;
let agent: FakeAgent;
let dataDir: string;

/** Every shipped module on except `off`; an unchecked box posts nothing. */
function modules(off: string[] = [], extra: Record<string, string> = {}): FormData {
  const fields: Record<string, string> = { customModulesJson: '[]', ...extra };
  for (const module of CADDY_MODULES) {
    if (!off.includes(module.id)) fields[`module:${module.id}`] = 'on';
  }
  return form(fields);
}

async function pairFakeAgent(): Promise<number> {
  const row = await insertPairedAgent({ name: 'edge', agentId: agent.agentId, secret: 's3cret' });
  if (row?.id !== 1) throw new Error('the fake agent attaches as row 1');
  return row.id;
}

beforeEach(async () => {
  ctx.db = await createTestDb();
  invalidateSettingsCache();
  resetPairingCodes();
  resetBootstrapState();
  dataDir = mkdtempSync(join(tmpdir(), 'cpm-agent-actions-'));
  vi.stubEnv('L4_PORTS_DIR', dataDir);
  admin = await seedUser(ctx.db, 'admin@example.com', 'admin');
  ctx.session = { user: admin };
  agent = await startFakeAgent();
});

afterEach(async () => {
  await agent.stop();
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

afterAll(() => {
  resetBootstrapState();
});

describe('the pairing code', () => {
  it('stays the same until revoked, then a fresh one is minted', async () => {
    const first = await pairingCodeAction();
    expect(first.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(first.expiresAt).toBeGreaterThan(Date.now());
    expect((await pairingCodeAction()).code).toBe(first.code);

    await revokePairingCodeAction();

    expect((await pairingCodeAction()).code).not.toBe(first.code);
  });
});

describe('unpairing', () => {
  it('forgets the agent, drops its stream and its re-pair code', async () => {
    const id = await pairFakeAgent();
    const { code } = (await repairAgentAction(id)) as { kind: 'code'; code: string };

    await unpairAgentAction(form({ agentId: String(id) }));

    expect(await findAgentById(id)).toBeNull();
    expect(connectedAgents().map((connected) => connected.agentId)).not.toContain(agent.agentId);
    expect(redeemRepairCode(agent.agentId, code).ok).toBe(false);
  });

  it('turns auto-pairing off for the bundled agent, so it does not pair straight back', async () => {
    const id = await pairFakeAgent();
    await recordBundledAgent(agent.agentId);

    await unpairAgentAction(form({ agentId: String(id) }));

    expect(await autoPairingDisabled()).toBe(true);
  });

  it('leaves auto-pairing alone when another agent goes', async () => {
    const id = await pairFakeAgent();
    await recordBundledAgent('someone-else');

    await unpairAgentAction(form({ agentId: String(id) }));

    expect(await autoPairingDisabled()).toBe(false);
  });

  it('ignores a form without an agent id', async () => {
    const id = await pairFakeAgent();

    await unpairAgentAction(form({ agentId: 'abc' }));

    expect(await findAgentById(id)).not.toBeNull();
  });
});

describe('re-pairing', () => {
  it('gives a remote agent a code that re-pairs it and nothing else', async () => {
    const id = await pairFakeAgent();

    const result = await repairAgentAction(id);

    expect(result.kind).toBe('code');
    const { code } = result as { kind: 'code'; code: string };
    expect(redeemRepairCode('another-agent', code).ok).toBe(false);
    expect(redeemRepairCode(agent.agentId, code).ok).toBe(true);
  });

  it('gives the bundled agent a bootstrap token on the shared volume', async () => {
    const id = await pairFakeAgent();
    await recordBundledAgent(agent.agentId);

    expect(await repairAgentAction(id)).toEqual({ kind: 'bootstrap' });
    expect(existsSync(join(dataDir, AGENT_BOOTSTRAP_FILE))).toBe(true);
  });

  it('fails for an agent that is not paired', async () => {
    expect(await repairAgentAction(42)).toEqual({ kind: 'failed' });
  });
});

describe('auto-pairing', () => {
  it('is turned back on, with a token written for the bundled agent to find', async () => {
    await setSetting('agent_bootstrap_disabled', true);

    await enableAutoPairingAction();

    expect(await autoPairingDisabled()).toBe(false);
    expect(existsSync(join(dataDir, AGENT_BOOTSTRAP_FILE))).toBe(true);
  });
});

describe('the Caddy module selection', () => {
  it('says nothing needs building when the agent already runs the selection', async () => {
    await updateCaddyBuildSettingsAction(null, modules());
    agent.completeBuild();

    expect(await updateCaddyBuildSettingsAction(null, modules())).toEqual({
      success: true,
      message: results.caddyBuildSaved,
    });
  });

  it('refuses to drop a module a switched-on feature needs', async () => {
    await saveWafSettings({
      enabled: true,
      mode: 'On',
      load_owasp_crs: true,
      custom_directives: '',
      excluded_rule_ids: [],
    });

    const result = await updateCaddyBuildSettingsAction(null, modules(['coraza-waf']));

    expect(result).toEqual({
      success: false,
      message:
        'Cannot disable those modules yet: global WAF is switched on and needs the Coraza WAF module. Turn the feature off first.',
    });
    expect(await getCaddyBuildSettings()).toBeNull();
  });

  it('refuses custom modules it cannot read', async () => {
    const result = await updateCaddyBuildSettingsAction(
      null,
      modules([], { customModulesJson: '[{' }),
    );

    expect(result).toEqual({
      success: false,
      message: domainErrorMessage('customModulesUnreadable'),
    });
  });

  it("saves one agent's own selection without touching the fleet default", async () => {
    const id = await pairFakeAgent();

    const result = await updateCaddyBuildSettingsAction(
      null,
      modules(['caddy-l4'], { agentRowId: String(id) }),
    );

    expect(result).toEqual({ success: true, message: results.caddyBuildSavedBuilding });
    expect((await getAgentBuildSettings(id))?.modules['caddy-l4']).toBe(false);
    expect(await getCaddyBuildSettings()).toBeNull();
    expect(agent.desired?.caddyModules).not.toContain(L4);
  });

  it('lets an agent follow the fleet default again', async () => {
    const id = await pairFakeAgent();
    await updateCaddyBuildSettingsAction(null, modules(['caddy-l4'], { agentRowId: String(id) }));

    const result = await updateCaddyBuildSettingsAction(
      null,
      form({ agentRowId: String(id), followFleetDefault: '1' }),
    );

    expect(result).toEqual({ success: true, message: results.caddyBuildFollowsFleet });
    expect(await getAgentBuildSettings(id)).toBeNull();
    await vi.waitFor(() => expect(agent.desired?.caddyModules).toContain(L4));
  });
});

describe('the rebuild button', () => {
  it('asks the connected agent to rebuild', async () => {
    const pushes = agent.requests.length;

    expect(await rebuildCaddyAction(null, form())).toEqual({
      success: true,
      message: results.rebuildTriggered,
    });
    expect(agent.requests.length).toBeGreaterThan(pushes);
  });

  it('says so when no agent is there to rebuild', async () => {
    await agent.stop();

    const result = await rebuildCaddyAction(null, form());

    expect(result.success).toBe(false);
    expect(result.message).toContain('No agent is connected');
  });
});

describe('a non-administrator', () => {
  it('cannot pair, unpair, re-pair or rebuild', async () => {
    const id = await pairFakeAgent();
    ctx.session = { user: await seedUser(ctx.db, 'op@example.com', 'operator') };

    await expect(pairingCodeAction()).rejects.toThrow(ADMIN_REQUIRED);
    await expect(revokePairingCodeAction()).rejects.toThrow(ADMIN_REQUIRED);
    await expect(unpairAgentAction(form({ agentId: String(id) }))).rejects.toThrow(ADMIN_REQUIRED);
    await expect(repairAgentAction(id)).rejects.toThrow(ADMIN_REQUIRED);
    await expect(enableAutoPairingAction()).rejects.toThrow(ADMIN_REQUIRED);
    const refused = { success: false, message: ADMIN_REQUIRED };
    expect(await rebuildCaddyAction(null, form())).toEqual(refused);
    expect(await updateCaddyBuildSettingsAction(null, modules(['caddy-l4']))).toEqual(refused);

    expect(await findAgentById(id)).not.toBeNull();
    expect(await getCaddyBuildSettings()).toBeNull();
  });
});
