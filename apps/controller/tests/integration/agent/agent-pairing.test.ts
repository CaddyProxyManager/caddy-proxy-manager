/**
 * An agent's secret runs Caddy admin calls on another host, so this pins what pairing refuses:
 * no cleartext secret, single-use credentials, bounded guessing, and no displacing a paired agent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

// Hoisted: an async Bun mock factory never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { eq } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';
const {
  clientThrottled,
  ensurePairingCode,
  mintRepairCode,
  recordFailedGuess,
  redeemPairingCode,
  redeemRepairCode,
  resetPairingCodes,
} = await import('../../../src/lib/agent/pairing-codes');
const { deleteAgent, listAgents, findAgentByAgentId, recordAgentContact, renameAgent } =
  await import('../../../src/lib/models/agents');
const bootstrap = await import('../../../src/lib/agent/bootstrap');
const { POST } = await import('../../../src/app/api/agent/v1/pair/route');
const { POST: PREVIEW } = await import('../../../src/app/api/agent/v1/pair/preview/route');
const { saveSettings, invalidateSettingsCache } = await import('../../../src/lib/settings/resolve');
const { appName } = await import('../../../src/lib/settings/registry');

const AGENT_ID = 'a'.repeat(32);
const OTHER_ID = 'b'.repeat(32);

function pairRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://controller.test/api/agent/v1/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function pair(code: string, agentId = AGENT_ID, headers: Record<string, string> = {}) {
  return POST(pairRequest({ code, agentId, agentVersion: '3.0.0' }, headers));
}

async function secretOf(response: Response): Promise<string> {
  return ((await response.json()) as { secret: string }).secret;
}

beforeEach(async () => {
  resetPairingCodes();
  bootstrap.resetBootstrapState();
  await ctx.db.delete(schema.agents);
  await ctx.db.delete(schema.settings);
  invalidateSettingsCache();
});

afterEach(() => {
  resetPairingCodes();
  bootstrap.resetBootstrapState();
});

describe('pairing codes', () => {
  it('mints a six-letter code and keeps returning the same one until it expires', () => {
    const first = ensurePairingCode();
    expect(first.code).toMatch(/^[A-Z]{6}$/);
    expect(ensurePairingCode().code).toBe(first.code);
  });

  it('draws only from an alphabet with no I or O, so a code can be read aloud', () => {
    for (let i = 0; i < 50; i += 1) {
      resetPairingCodes();
      expect(ensurePairingCode().code).not.toMatch(/[IO]/);
    }
  });

  it('burns the code on success, so it cannot be used twice', () => {
    const { code } = ensurePairingCode();
    expect(redeemPairingCode(code).ok).toBe(true);
    expect(redeemPairingCode(code).ok).toBe(false);
  });

  it('refuses an expired code and does not resurrect it', () => {
    const { code } = ensurePairingCode();
    const later = Date.now() + 6 * 60_000;
    expect(redeemPairingCode(code, later).ok).toBe(false);
    expect(redeemPairingCode(code).ok).toBe(false);
  });

  it('survives 199 wrong guesses, so one noisy client cannot burn it', () => {
    const { code } = ensurePairingCode();
    for (let i = 0; i < 199; i += 1) expect(redeemPairingCode('ZZZZZZ').ok).toBe(false);
    expect(redeemPairingCode(code).ok).toBe(true);
  });

  it('burns the code after 200 wrong guesses in total, bounding a guessing botnet', () => {
    const { code } = ensurePairingCode();
    for (let i = 0; i < 200; i += 1) expect(redeemPairingCode('ZZZZZZ').ok).toBe(false);
    expect(redeemPairingCode(code).ok).toBe(false);
  });

  it('accepts a code typed in lower case with stray spaces', () => {
    const { code } = ensurePairingCode();
    expect(redeemPairingCode(`  ${code.toLowerCase()} `).ok).toBe(true);
  });

  it('keeps a re-pair code to the agent it was minted for', () => {
    const { code } = mintRepairCode(AGENT_ID);
    expect(redeemRepairCode(OTHER_ID, code).ok).toBe(false);
    // Neither is the live code, nor does it stand in for one.
    expect(redeemPairingCode(code).ok).toBe(false);
    expect(redeemRepairCode(AGENT_ID, code).ok).toBe(true);
    expect(redeemRepairCode(AGENT_ID, code).ok).toBe(false);
  });

  it('throttles a client after five wrong guesses in a minute, and forgets it after', () => {
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      expect(clientThrottled('203.0.113.9', now)).toBe(false);
      recordFailedGuess('203.0.113.9', now);
    }
    expect(clientThrottled('203.0.113.9', now)).toBe(true);
    expect(clientThrottled('198.51.100.7', now)).toBe(false);
    expect(clientThrottled('203.0.113.9', now + 61_000)).toBe(false);
  });
});

describe('POST /api/agent/v1/pair', () => {
  it('introduces the controller by its Application name', async () => {
    await saveSettings({ [appName.key]: 'Branch Office' });
    const { code } = ensurePairingCode();
    const response = await pair(code);
    expect(((await response.json()) as { controllerName: string }).controllerName).toBe(
      'Branch Office',
    );
  });

  it('stores the agent and returns a secret it did not receive', async () => {
    const { code } = ensurePairingCode();
    const response = await POST(
      pairRequest({ code, agentId: AGENT_ID, agentName: 'edge', agentVersion: '3.0.0' }),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as { secret: string; controllerId: string };
    expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(body.controllerId).toBeTruthy();

    const agents = await listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].agentId).toBe(AGENT_ID);
    expect(agents[0].name).toBe('edge');
  });

  it('never stores the secret in the clear', async () => {
    const { code } = ensurePairingCode();
    const secret = await secretOf(await pair(code));

    const [row] = await ctx.db.select().from(schema.agents);
    expect(row.secret).not.toBe(secret);
    // …and it must still decrypt back to what the agent was given, or the agent can never sign.
    expect((await findAgentByAgentId(AGENT_ID))?.secret).toBe(secret);
  });

  it('refuses a wrong code with 401 and stores nothing', async () => {
    ensurePairingCode();
    const response = await pair('ZZZZZZ');
    expect(response.status).toBe(401);
    expect(await listAgents()).toHaveLength(0);
  });

  it('refuses a code that was already redeemed', async () => {
    const { code } = ensurePairingCode();
    await pair(code);
    const second = await pair(code, OTHER_ID);
    expect(second.status).toBe(401);
    expect(await listAgents()).toHaveLength(1);
  });

  it('rejects an agent id that is not one, before touching the code', async () => {
    const { code } = ensurePairingCode();
    const response = await POST(pairRequest({ code, agentId: '../etc', agentVersion: '3.0.0' }));
    expect(response.status).toBe(400);
    // The code survives: a malformed request must not burn the operator's code for them.
    expect(redeemPairingCode(code).ok).toBe(true);
  });

  it('names an agent that did not name itself', async () => {
    const { code } = ensurePairingCode();
    await pair(code);
    expect((await listAgents())[0].name).toBe(`Agent ${AGENT_ID.slice(0, 8)}`);
  });

  it('refuses a body that is not JSON', async () => {
    ensurePairingCode();
    const response = await POST(
      new Request('http://controller.test/api/agent/v1/pair', { method: 'POST', body: 'nonsense' }),
    );
    expect(response.status).toBe(400);
  });
});

describe('an agent that is already paired', () => {
  it('cannot be displaced with the shared code, which stays usable for a new agent', async () => {
    const original = await secretOf(await pair(ensurePairingCode().code));

    resetPairingCodes();
    const { code } = ensurePairingCode();
    const hijack = await pair(code);
    expect(hijack.status).toBe(401);
    expect((await findAgentByAgentId(AGENT_ID))?.secret).toBe(original);

    // Refused before the code was spent: an attacker naming a known id must not burn it.
    expect((await pair(code, OTHER_ID)).status).toBe(200);
  });

  it('is never re-enabled by pairing, even with a code minted for it', async () => {
    await pair(ensurePairingCode().code);
    await ctx.db.update(schema.agents).set({ enabled: false });
    const { code } = mintRepairCode(AGENT_ID);

    const response = await pair(code);
    expect(response.status).toBe(403);
    const [row] = await ctx.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.agentId, AGENT_ID));
    expect(row.enabled).toBe(false);
    // Nothing was spent on a refusal.
    expect(redeemRepairCode(AGENT_ID, code).ok).toBe(true);
  });

  it('recovers with a re-pair code minted for it, keeping its row and its name', async () => {
    const first = await secretOf(await pair(ensurePairingCode().code));
    const [row] = await listAgents();
    await renameAgent(row.id, 'edge-renamed');

    const { code } = mintRepairCode(AGENT_ID);
    const response = await pair(code);
    expect(response.status).toBe(200);
    const second = await secretOf(response);

    expect(second).not.toBe(first);
    const agents = await listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('edge-renamed');
    expect((await findAgentByAgentId(AGENT_ID))?.secret).toBe(second);
    expect((await pair(code)).status).toBe(401);
  });

  it('cannot be re-paired with a code minted for a different agent', async () => {
    await pair(ensurePairingCode().code);
    resetPairingCodes();
    await pair(ensurePairingCode().code, OTHER_ID);
    const { code } = mintRepairCode(OTHER_ID);

    expect((await pair(code, AGENT_ID)).status).toBe(401);
  });
});

describe('guessing from one address', () => {
  // X-Forwarded-For: the test server stamps no peer address, and X-Real-IP is never trusted.
  const from = { 'x-forwarded-for': '203.0.113.9' };

  it('stops a client after five wrong codes, even when its sixth is right', async () => {
    const { code } = ensurePairingCode();
    for (let i = 0; i < 5; i += 1) expect((await pair('ZZZZZZ', AGENT_ID, from)).status).toBe(401);

    expect((await pair(code, AGENT_ID, from)).status).toBe(429);
    // Another client still pairs with the same code: the throttled one could not burn it.
    const elsewhere = await pair(code, AGENT_ID, { 'x-forwarded-for': '198.51.100.7' });
    expect(elsewhere.status).toBe(200);
  });
});

describe('bootstrap token', () => {
  // A directory per test, so a leaked token file cannot pair a later test.
  let dir: string;

  beforeEach(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    dir = mkdtempSync(join(tmpdir(), 'cpm-bootstrap-'));
    process.env.L4_PORTS_DIR = dir;
  });

  afterEach(() => {
    process.env.L4_PORTS_DIR = undefined;
  });

  async function readToken(): Promise<string> {
    const { readFileSync } = await import('node:fs');
    return readFileSync(bootstrap.bootstrapPath(), 'utf-8').trim();
  }

  async function tokenOnDisk(): Promise<boolean> {
    const { existsSync } = await import('node:fs');
    return existsSync(bootstrap.bootstrapPath());
  }

  it('writes a token when nothing is paired, and keeps it on a second call', async () => {
    expect(await bootstrap.ensureBootstrapToken()).toBe(true);
    const first = await readToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    await bootstrap.ensureBootstrapToken();
    expect(await readToken()).toBe(first);
  });

  it('pairs an agent that presents it and deletes it, so it cannot be replayed', async () => {
    await bootstrap.ensureBootstrapToken();
    const token = await readToken();

    expect((await pair(token)).status).toBe(200);
    expect(await listAgents()).toHaveLength(1);
    expect(await bootstrap.isBundledAgent(AGENT_ID)).toBe(true);

    // Deleted, not rotated: nothing is left on the volume for anyone else to read.
    expect(await tokenOnDisk()).toBe(false);
    expect((await pair(token, 'c'.repeat(32))).status).toBe(401);
    expect(await listAgents()).toHaveLength(1);
  });

  it('refuses a token that is the right shape but not the stored one', async () => {
    await bootstrap.ensureBootstrapToken();
    expect((await pair('d'.repeat(64))).status).toBe(401);
    expect(await listAgents()).toHaveLength(0);
  });

  it('accepts no token this process did not write, whatever is on the volume', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(bootstrap.bootstrapPath(), 'e'.repeat(64));
    expect((await pair('e'.repeat(64))).status).toBe(401);
  });

  it('does not let a bootstrap token stand in for a typed code when none was written', async () => {
    // Must not fall through to comparing against the live six-letter code.
    ensurePairingCode();
    expect((await pair('e'.repeat(64))).status).toBe(401);
    expect(await listAgents()).toHaveLength(0);
  });

  it('leaves the typed-code path working alongside it', async () => {
    await bootstrap.ensureBootstrapToken();
    expect((await pair(ensurePairingCode().code)).status).toBe(200);
  });

  it('lets exactly one of two simultaneous redemptions through', async () => {
    await bootstrap.ensureBootstrapToken();
    const token = await readToken();

    const statuses = (await Promise.all([pair(token, AGENT_ID), pair(token, OTHER_ID)]))
      .map((response) => response.status)
      .sort();
    expect(statuses).toEqual([200, 401]);
    expect(await listAgents()).toHaveLength(1);
  });

  it('refuses a token whose file was already claimed by another process', async () => {
    const { rmSync } = await import('node:fs');
    await bootstrap.ensureBootstrapToken();
    const token = await readToken();
    rmSync(bootstrap.bootstrapPath());

    expect((await pair(token)).status).toBe(401);
  });

  it('expires', async () => {
    await bootstrap.ensureBootstrapToken();
    const token = await readToken();
    const later = Date.now() + bootstrap.BOOTSTRAP_TOKEN_TTL_MS + 1;

    expect(bootstrap.redeemBootstrapToken(token, AGENT_ID, false, later)).toBe(false);
    expect(await tokenOnDisk()).toBe(false);
    expect((await pair(token)).status).toBe(401);
  });

  it('writes no token while the bundled agent is paired', async () => {
    await bootstrap.ensureBootstrapToken();
    await pair(await readToken());

    bootstrap.resetBootstrapState();
    expect(await bootstrap.ensureBootstrapToken()).toBe(false);
    expect(await tokenOnDisk()).toBe(false);
  });

  it('cannot displace an agent that is already paired', async () => {
    const original = await secretOf(await pair(ensurePairingCode().code));
    await bootstrap.enableAutoPairing();

    expect((await pair(await readToken())).status).toBe(401);
    expect((await findAgentByAgentId(AGENT_ID))?.secret).toBe(original);
  });

  it('re-pairs the bundled agent with a token bound to it, and nobody else with that token', async () => {
    await bootstrap.ensureBootstrapToken();
    const first = await secretOf(await pair(await readToken()));

    expect(bootstrap.issueBootstrapToken(AGENT_ID)).toBe(true);
    const bound = await readToken();
    expect((await pair(bound, OTHER_ID)).status).toBe(401);

    const response = await pair(bound);
    expect(response.status).toBe(200);
    expect(await secretOf(response)).not.toBe(first);
    expect(await listAgents()).toHaveLength(1);
  });

  it('stays unpaired after the bundled agent is unpaired, until auto-pairing is turned back on', async () => {
    await bootstrap.ensureBootstrapToken();
    await pair(await readToken());
    const [row] = await listAgents();

    const agentId = await deleteAgent(row.id);
    expect(agentId).toBe(AGENT_ID);
    await bootstrap.forgetBootstrapAgent(AGENT_ID);

    // A restart is when a fresh token would let the agent pair back.
    bootstrap.resetBootstrapState();
    expect(await bootstrap.ensureBootstrapToken()).toBe(false);
    expect(await tokenOnDisk()).toBe(false);
    expect(await bootstrap.autoPairingDisabled()).toBe(true);

    expect(await bootstrap.enableAutoPairing()).toBe(true);
    expect(await bootstrap.autoPairingDisabled()).toBe(false);
    expect((await pair(await readToken())).status).toBe(200);
  });

  it('leaves auto-pairing alone when a remote agent is unpaired', async () => {
    await bootstrap.ensureBootstrapToken();
    await pair(await readToken());
    await pair(ensurePairingCode().code, OTHER_ID);

    await bootstrap.forgetBootstrapAgent(OTHER_ID);
    expect(await bootstrap.autoPairingDisabled()).toBe(false);
  });
});

describe('POST /api/agent/v1/pair/preview', () => {
  async function preview(code: string, agentId = AGENT_ID) {
    return PREVIEW(
      new Request('http://controller.test/api/agent/v1/pair/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, agentId }),
      }),
    );
  }

  it('names the controller for a right code without spending it', async () => {
    // The Application name, not a separate branding value.
    await saveSettings({ [appName.key]: 'Edge Controller' });
    const { code } = ensurePairingCode();

    const response = await preview(code);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      controllerName: string;
      controllerId: string;
      repair: boolean;
    };
    expect(body.controllerName).toBe('Edge Controller');
    expect(body.controllerId.length).toBeGreaterThan(0);
    expect(body.repair).toBe(false);

    // Still good for the pairing the operator confirms next.
    expect((await pair(code)).status).toBe(200);
  });

  it('says nothing about the controller for a wrong code', async () => {
    ensurePairingCode();
    const response = await preview('ZZZZZZ');
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('Caddy Proxy Manager');
  });

  it('counts a wrong guess against the same throttle as pairing', async () => {
    const { code } = ensurePairingCode();
    for (let i = 0; i < 5; i += 1) expect((await preview('ZZZZZZ')).status).toBe(401);
    // The sixth attempt - right or not, preview or pair - is refused for this address.
    expect((await preview(code)).status).toBe(429);
    expect((await pair(code)).status).toBe(429);
  });

  it('reports a re-pair for an agent that is already known', async () => {
    const first = ensurePairingCode();
    expect((await pair(first.code)).status).toBe(200);
    const { code } = mintRepairCode(AGENT_ID);

    const response = await preview(code);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { repair: boolean }).repair).toBe(true);
    // And the re-pair code is still there to use.
    expect(redeemRepairCode(AGENT_ID, code).ok).toBe(true);
  });

  it('says nothing about a disabled agent to a caller without its code', async () => {
    const first = ensurePairingCode();
    expect((await pair(first.code)).status).toBe(200);
    await ctx.db
      .update(schema.agents)
      .set({ enabled: false })
      .where(eq(schema.agents.agentId, AGENT_ID));
    const { code } = mintRepairCode(AGENT_ID);

    // A wrong code is refused as wrong, exactly as for an enabled agent.
    expect((await preview('ZZZZZZ')).status).toBe(401);
    // The right one still does not bring a disabled agent back.
    expect((await preview(code)).status).toBe(403);
  });

  it('does not preview a bootstrap token', async () => {
    const response = await preview('f'.repeat(64));
    expect(response.status).toBe(400);
  });
});

describe('agent contact', () => {
  it('stamps lastSeenAt and carries no error field nothing would ever set', async () => {
    const { code } = ensurePairingCode();
    expect((await pair(code)).status).toBe(200);
    const [before] = await listAgents();
    expect(before.lastSeenAt).toBeNull();

    await recordAgentContact(before.id);
    const [after] = await listAgents();
    expect(after.lastSeenAt).not.toBeNull();
    expect(after).not.toHaveProperty('lastError');
    expect(Object.keys(schema.agents)).not.toContain('lastError');
  });
});
