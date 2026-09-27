/**
 * Which agents are asked to run the controller's ClickHouse, and sent its password. Every agent
 * relays events to the controller, so only the one in the controller's own stack needs it.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { createTestDb, currentDb, type TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const schemaModule = await import('@/src/lib/db/schema');

// Hoisted out of the factory below: createTestDb is async, and a Bun mock factory must be
// synchronous - an async one never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('@/src/lib/db', () => ({
  default: currentDb(() => ctx.db),
  db: currentDb(() => ctx.db),
  client: undefined,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null =>
    !value ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
}));

vi.mock('@/src/lib/clickhouse/client', () => ({ isAnalyticsEnabled: async () => true }));
vi.mock('@/src/lib/agent/desired-state', () => ({ pushDesiredState: async () => {} }));

const registry = await import('@/src/lib/settings/registry');
const { saveSettings } = await import('@/src/lib/settings/resolve');
const { setSetting } = await import('@/src/lib/settings');
const { encryptSecret } = await import('@/src/lib/secret');
const { desiredManagedServices } = await import('@/src/lib/agent/managed-services');

const BUNDLED_AGENT_KEY = 'agent_bootstrap_agent_id';

async function pair(agentId: string): Promise<number> {
  const now = new Date().toISOString();
  const [row] = await ctx.db
    .insert(schemaModule.agents)
    .values({
      name: agentId,
      agentId,
      secret: encryptSecret('a'.repeat(64)),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schemaModule.agents.id });
  return row.id;
}

let bundled: number;
let remote: number;

beforeEach(async () => {
  await ctx.db.delete(schemaModule.agents);
  bundled = await pair('bundled-agent');
  remote = await pair('remote-agent');
  await setSetting(BUNDLED_AGENT_KEY, 'bundled-agent');
  await saveSettings({ [registry.clickhousePassword.key]: 'clickhouse-secret' });
});

describe('desiredManagedServices', () => {
  it('asks only the bundled agent to run ClickHouse, and sends only it the password', async () => {
    const forBundled = await desiredManagedServices(bundled);
    const forRemote = await desiredManagedServices(remote);

    expect(forBundled.services).toEqual({ clickhouse: true });
    expect(forBundled.env.CLICKHOUSE_PASSWORD).toBe('clickhouse-secret');
    expect(forRemote).toEqual({ services: { clickhouse: false }, env: {} });
  });

  it('asks every agent when none is recorded as bundled, rather than losing ClickHouse', async () => {
    await setSetting(BUNDLED_AGENT_KEY, null);

    expect((await desiredManagedServices(remote)).services).toEqual({ clickhouse: true });
  });

  it('asks every agent when the recorded bundled agent has since been unpaired', async () => {
    await setSetting(BUNDLED_AGENT_KEY, 'unpaired-agent');

    expect((await desiredManagedServices(remote)).services).toEqual({ clickhouse: true });
  });
});
