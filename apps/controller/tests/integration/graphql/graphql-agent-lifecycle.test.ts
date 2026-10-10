/**
 * The agent lifecycle mutations against the real store: a code is minted once and kept encrypted,
 * a rename and an unpair are read back from the database, a rebuild reaches the agent or says why
 * not, and a non-admin gets nothing. The agent's own fields are graphql-agent.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capabilitiesOf } from '@/tests/helpers/access';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { eq } from 'drizzle-orm';
import { graphql } from 'graphql';
import { AGENT_BOOTSTRAP_FILE, PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from '@cpm/shared';
import { schema } from '../../../src/lib/graphql/schema';
import type { GraphQLContext } from '../../../src/lib/graphql/context';
import { recordBundledAgent, resetBootstrapState } from '../../../src/lib/agent/bootstrap';
import { redeemRepairCode, resetPairingCodes } from '../../../src/lib/agent/pairing-codes';
import { isConnected } from '../../../src/lib/agent/registry';
import { findAgentById, insertPairedAgent } from '../../../src/lib/models/agents';
import { decryptSecret } from '../../../src/lib/secrets';
import { invalidateSettingsCache } from '../../../src/lib/settings/resolve';
import * as db from '../../../src/lib/db/schema';
import { type FakeCaddy, installFakeCaddy } from '../../helpers/caddy-admin';
import { startFakeAgent } from '../../helpers/fake-agent';

const NOW = '2026-03-01T00:00:00.000Z';
const ROLE_REFUSED = "This account's role does not allow this request";

function contextFor(role: string | null): GraphQLContext {
  return {
    viewer: async () => {
      if (!role) throw new Error('Unauthorized');
      return { userId: 1, role, authMethod: 'bearer' as const };
    },
    access: async () => ({
      userId: 1,
      role: role ?? '',
      capabilities: capabilitiesOf(role),
      grants: { proxyHosts: new Map(), l4ProxyHosts: new Map(), agents: new Map() },
    }),
    rawBody: async () => '',
    request: {} as never,
  };
}

async function run(
  document: string,
  role: string | null,
  variableValues?: Record<string, unknown>,
) {
  return await graphql({
    schema,
    source: document,
    contextValue: contextFor(role),
    variableValues,
  });
}

/** The data of a call that must succeed; its errors are the failure message otherwise. */
async function ok<T = Record<string, unknown>>(
  document: string,
  variableValues?: Record<string, unknown>,
): Promise<T> {
  const result = await run(document, 'admin', variableValues);
  expect(result.errors).toBeUndefined();
  return result.data as T;
}

type PairingCode = { code: string | null; expiresAt: string; bootstrap: boolean };
const MINT =
  'mutation ($agentId: Int) { mintAgentPairingCode(agentId: $agentId) { code expiresAt bootstrap } }';

/** A paired agent that holds no stream, as one whose host is down. */
async function seedAgent(name = 'edge', agentId = `agent-${name}`): Promise<number> {
  const row = await insertPairedAgent({ name, agentId, secret: 's3cret' });
  if (!row) throw new Error('seedAgent: already paired');
  return row.id;
}

async function pairingRows() {
  return await ctx.db
    .select({ slot: db.agentPairingSecrets.slot, secret: db.agentPairingSecrets.secret })
    .from(db.agentPairingSecrets);
}

let caddy: FakeCaddy;
let dataDir: string;

beforeEach(async () => {
  caddy = installFakeCaddy();
  invalidateSettingsCache();
  await resetPairingCodes();
  await resetBootstrapState();
  for (const table of [db.agents, db.settings, db.users]) {
    await ctx.db.delete(table);
  }
  await ctx.db.insert(db.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    createdAt: NOW,
    updatedAt: NOW,
  });
  // Where the bootstrap token lands; the module names the setting it first served.
  dataDir = mkdtempSync(join(tmpdir(), 'cpm-graphql-agents-'));
  vi.stubEnv('L4_PORTS_DIR', dataDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('mintAgentPairingCode', () => {
  it('mints the live code once, stores it encrypted and shows it again until it expires', async () => {
    const first = (await ok<{ mintAgentPairingCode: PairingCode }>(MINT)).mintAgentPairingCode;
    const second = (await ok<{ mintAgentPairingCode: PairingCode }>(MINT)).mintAgentPairingCode;

    expect(first.code).toMatch(new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`));
    expect(first.bootstrap).toBe(false);
    expect(Date.parse(first.expiresAt)).toBeGreaterThan(Date.now());
    expect(second).toEqual(first);

    const rows = await pairingRows();
    expect(rows.map((row) => row.slot)).toEqual(['code']);
    expect(rows[0]?.secret).not.toBe(first.code);
    expect(decryptSecret(rows[0]?.secret ?? '')).toBe(first.code ?? '');
  });

  it('gives a paired remote agent a code that re-pairs it and nothing else', async () => {
    const id = await seedAgent();
    const { mintAgentPairingCode: minted } = await ok<{ mintAgentPairingCode: PairingCode }>(MINT, {
      agentId: id,
    });

    expect(minted.bootstrap).toBe(false);
    expect((await pairingRows()).map((row) => row.slot)).toEqual(['repair:agent-edge']);
    // The live code never came into being, so the re-pair code pairs no stranger.
    expect(await redeemRepairCode('agent-other', minted.code ?? '')).toMatchObject({ ok: false });
    expect(await redeemRepairCode('agent-edge', minted.code ?? '')).toEqual({ ok: true });
  });

  it('writes the bundled agent a bootstrap token on the data volume instead of a code', async () => {
    const id = await seedAgent('bundled');
    await recordBundledAgent('agent-bundled');

    const { mintAgentPairingCode: minted } = await ok<{ mintAgentPairingCode: PairingCode }>(MINT, {
      agentId: id,
    });

    expect(minted).toMatchObject({ code: null, bootstrap: true });
    expect(existsSync(join(dataDir, AGENT_BOOTSTRAP_FILE))).toBe(true);
    const rows = await pairingRows();
    expect(rows.map((row) => row.slot)).toEqual(['bootstrap']);
    // A hash, so reading the table never yields the token.
    expect(rows[0]?.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('knows no agent by an id that is not paired', async () => {
    const result = await run(MINT, 'admin', { agentId: 404 });
    expect(result.errors?.[0]?.message).toBe('Agent not found');
    expect(await pairingRows()).toEqual([]);
  });
});

describe('renameAgent', () => {
  it('renames and answers the agent as stored', async () => {
    const id = await seedAgent();
    const data = await ok<{ renameAgent: { id: number; name: string; connected: boolean } }>(
      'mutation ($id: Int!) { renameAgent(id: $id, name: "  rack 2  ") { id name connected } }',
      { id },
    );

    expect(data.renameAgent).toEqual({ id, name: 'rack 2', connected: false });
    expect((await findAgentById(id))?.name).toBe('rack 2');
  });

  it('refuses a blank name and changes nothing', async () => {
    const id = await seedAgent();
    const result = await run(
      'mutation ($id: Int!) { renameAgent(id: $id, name: "   ") { id } }',
      'admin',
      { id },
    );

    expect(result.errors?.[0]?.message).toBe('Name is required');
    expect((await findAgentById(id))?.name).toBe('edge');
  });
});

describe('unpairAgent', () => {
  it('forgets the agent, its stream and its re-pair code', async () => {
    const agent = await startFakeAgent();
    try {
      const id = await seedAgent('fake', agent.agentId);
      await ok(MINT, { agentId: id });
      expect(isConnected(agent.agentId)).toBe(true);

      const data = await ok<{ unpairAgent: boolean }>(
        'mutation ($id: Int!) { unpairAgent(id: $id) }',
        { id },
      );

      expect(data.unpairAgent).toBe(true);
      expect(await findAgentById(id)).toBeNull();
      expect(isConnected(agent.agentId)).toBe(false);
      expect(await pairingRows()).toEqual([]);
    } finally {
      await agent.stop();
    }
  });

  it('turns auto-pairing off for the bundled agent, so it does not pair straight back', async () => {
    const id = await seedAgent('bundled');
    await recordBundledAgent('agent-bundled');

    await ok('mutation ($id: Int!) { unpairAgent(id: $id) }', { id });

    const [disabled] = await ctx.db
      .select({ value: db.settings.value })
      .from(db.settings)
      .where(eq(db.settings.key, 'agent_bootstrap_disabled'));
    expect(disabled?.value).toBe('true');
  });

  it('knows no agent by an id that is not paired', async () => {
    const result = await run('mutation { unpairAgent(id: 404) }', 'admin');
    expect(result.errors?.[0]?.message).toBe('Agent not found');
  });
});

describe('rebuildAgentCaddy', () => {
  it('asks the connected agent to rebuild', async () => {
    const agent = await startFakeAgent();
    try {
      const id = await seedAgent('fake', agent.agentId);
      const pushes = agent.requests.length;

      const data = await ok<{ rebuildAgentCaddy: boolean }>(
        'mutation ($id: Int!) { rebuildAgentCaddy(id: $id) }',
        { id },
      );

      expect(data.rebuildAgentCaddy).toBe(true);
      expect(agent.requests.length).toBeGreaterThan(pushes);
    } finally {
      await agent.stop();
    }
  });

  it('says so when the agent is not reachable', async () => {
    const id = await seedAgent();
    const result = await run('mutation ($id: Int!) { rebuildAgentCaddy(id: $id) }', 'admin', {
      id,
    });

    expect(result.errors?.[0]?.message).toContain('No agent is connected');
  });
});

describe('a non-administrator', () => {
  it('is refused every lifecycle mutation, and nothing changes', async () => {
    const id = await seedAgent();
    for (const document of [
      MINT,
      'mutation ($id: Int!) { unpairAgent(id: $id) }',
      'mutation ($id: Int!) { renameAgent(id: $id, name: "mine") { id } }',
      'mutation ($id: Int!) { rebuildAgentCaddy(id: $id) }',
    ]) {
      const result = await run(document, 'operator', { id, agentId: id });
      expect(result.errors?.[0]?.message, document).toBe(ROLE_REFUSED);
    }

    expect((await findAgentById(id))?.name).toBe('edge');
    expect(await pairingRows()).toEqual([]);
    expect(caddy.loads).toEqual([]);
  });
});
