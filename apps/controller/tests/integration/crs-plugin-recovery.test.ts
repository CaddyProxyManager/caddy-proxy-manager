/**
 * Caddy refusing a CRS plugin Coraza cannot build (src/lib/crs-plugins/recovery.ts). A fake load
 * builds the real plugin rules and refuses those containing a plugin marked bad.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { createTestDb, type TestDb } from '../helpers/db';
import { crsPlugins, users } from '../../src/lib/db/schema';
import { CaddyApplyError } from '../../src/lib/caddy-apply-error';

let db: TestDb;
let globalWaf: { plugin_ids?: number[] } | null = null;
const settingsStore = new Map<string, unknown>();
const audit = vi.fn();

/** Plugin names Caddy refuses, and whether its error quotes the offending rule's id. */
let refused = new Set<string>();
let quotesRuleId = false;
let alwaysRefuse = false;
const loads: string[][] = [];

vi.mock('../../src/lib/db', () => dbModuleMock(() => db));
vi.mock('../../src/lib/audit', () => ({ logAuditEvent: audit }));
vi.mock('../../src/lib/settings', () => ({
  getWafSettings: async () => globalWaf,
  getDashboardSettings: async () => ({ options: { meta: null } }),
  getSetting: async (key: string) => structuredClone(settingsStore.get(key) ?? null),
  setSetting: async (key: string, value: unknown) => {
    settingsStore.set(key, structuredClone(value));
  },
}));
vi.mock('../../src/lib/caddy', () => ({
  applyCaddyConfig: () => loadWithCrsPluginRecovery(fakeLoad),
}));

import { loadWithCrsPluginRecovery } from '../../src/lib/crs-plugins/recovery';
import { getCrsPluginQuarantine } from '../../src/lib/crs-plugins/quarantine';
import {
  getCrsPluginRules,
  retryCrsPlugin,
  setCrsPluginConfig,
} from '../../src/lib/models/crs-plugins';

async function fakeLoad(): Promise<void> {
  const emitted = await getCrsPluginRules();
  const rows = await db.select().from(crsPlugins);
  const names = rows.filter((row) => emitted.has(row.id)).map((row) => row.name);
  loads.push(names.sort());
  const bad = rows.find((row) => emitted.has(row.id) && refused.has(row.name));
  if (alwaysRefuse || bad) {
    const id = bad && quotesRuleId ? ` "id:${bad.ruleIdStart + 100},chain` : '';
    throw new CaddyApplyError('Caddy rejected configuration', 'CADDY_REJECTED', {
      wafFailed: true,
      ruleIds: id ? [bad!.ruleIdStart + 100] : [],
    });
  }
}

let userId: number;
const ids: Record<string, number> = {};

async function seed(name: string, start: number, updatedAt: string) {
  const [row] = await db
    .insert(crsPlugins)
    .values({
      name,
      repository: `https://github.com/x/${name}`,
      version: 'v1',
      ruleIdStart: start,
      ruleIdEnd: start + 999,
      configRules: '',
      beforeRules: `SecRule ARGS "@rx x" "id:${start + 100},phase:1,pass,nolog"`,
      afterRules: '',
      createdAt: updatedAt,
      updatedAt,
    })
    .returning();
  ids[name] = row.id;
}

beforeEach(async () => {
  db = await createTestDb();
  vi.clearAllMocks();
  settingsStore.clear();
  refused = new Set();
  quotesRuleId = false;
  alwaysRefuse = false;
  loads.length = 0;
  const now = new Date().toISOString();
  const [user] = await db
    .insert(users)
    .values({
      email: 'admin@test',
      name: 'Admin',
      role: 'admin',
      provider: 'credentials',
      subject: 'admin@test',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  userId = user.id;
  await seed('good', 9500000, '2026-01-01T00:00:00.000Z');
  await seed('bad', 9501000, '2026-01-02T00:00:00.000Z');
  await seed('also-good', 9502000, '2026-01-03T00:00:00.000Z');
  globalWaf = { plugin_ids: [ids.good, ids.bad, ids['also-good']] };
});

describe('loadWithCrsPluginRecovery', () => {
  it('switches off the plugin a quoted rule id names, and loads the rest', async () => {
    refused.add('bad');
    quotesRuleId = true;
    await loadWithCrsPluginRecovery(fakeLoad);
    expect(Object.keys(await getCrsPluginQuarantine()).map(Number)).toEqual([ids.bad]);
    // The refused load, then one without it.
    expect(loads.at(-1)).toEqual(['also-good', 'good']);
    expect(loads).toHaveLength(2);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'Disabled CRS plugin bad: Caddy refused to load it' }),
    );
  });

  it('finds the plugin by trying them one at a time when the error names none', async () => {
    refused.add('bad');
    await loadWithCrsPluginRecovery(fakeLoad);
    expect(Object.keys(await getCrsPluginQuarantine()).map(Number)).toEqual([ids.bad]);
    // What Caddy is left serving: everything but the plugin it refused.
    expect(loads.at(-1)).toEqual(['also-good', 'good']);
  });

  it('switches nothing off when the config fails without any plugin', async () => {
    alwaysRefuse = true;
    let caught: unknown;
    try {
      await loadWithCrsPluginRecovery(fakeLoad);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CaddyApplyError);
    expect(await getCrsPluginQuarantine()).toEqual({});
    expect(audit).not.toHaveBeenCalled();
  });

  it('leaves a failure that is not the WAF alone', async () => {
    const unreachable = new CaddyApplyError('Unable to reach Caddy API', 'CADDY_UNREACHABLE');
    let attempts = 0;
    await expect(
      loadWithCrsPluginRecovery(async () => {
        attempts++;
        throw unreachable;
      }),
    ).rejects.toBe(unreachable);
    expect(attempts).toBe(1);
    expect(await getCrsPluginQuarantine()).toEqual({});
  });
});

describe('a switched-off plugin', () => {
  it('stays out of the config until it changes, and retrying says whether Caddy took it', async () => {
    refused.add('bad');
    await loadWithCrsPluginRecovery(fakeLoad);
    expect((await getCrsPluginRules()).has(ids.bad)).toBe(false);

    // Still refused: retrying switches it off again and says so.
    expect(await retryCrsPlugin(ids.bad, userId)).toBe(false);
    expect(ids.bad in (await getCrsPluginQuarantine())).toBe(true);

    // Fixed by a config edit: the edit lets it load again.
    refused.clear();
    await setCrsPluginConfig(ids.bad, 'SecAction "id:9501010,phase:1,pass,nolog"', userId);
    expect(await getCrsPluginQuarantine()).toEqual({});
    expect(loads.at(-1)).toEqual(['also-good', 'bad', 'good']);
  });
});
