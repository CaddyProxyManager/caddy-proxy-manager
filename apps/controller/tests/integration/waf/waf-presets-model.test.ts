/**
 * Integration: src/lib/models/waf-presets.ts against a real database - validation, the in-use
 * guard on delete, and the Caddy re-apply an edit to a selected preset triggers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { createTestDb, type TestDb } from '../../helpers/db';
import { proxyHosts, users } from '../../../src/lib/db/schema';
import type { DomainError } from '../../../src/lib/errors/domain-error';
import { type CaddyValidator, setCaddyValidator } from '../../../src/lib/waf/dry-run';

let db: TestDb;
let globalWaf: { preset_ids?: number[]; strict_directives?: boolean } | null = null;
let dashboardMeta: string | null = null;

vi.mock('../../../src/lib/db', () => dbModuleMock(() => db));
vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));
const applyCaddyConfig = vi.fn(async () => {});
vi.mock('../../../src/lib/caddy', () => ({ applyCaddyConfig }));
vi.mock('../../../src/lib/settings', () => ({
  getWafSettings: async () => globalWaf,
  getDashboardSettings: async () => ({ options: { meta: dashboardMeta } }),
}));

import {
  assertWafPresetIdsExist,
  createWafPreset,
  deleteWafPreset,
  getWafPresetUsage,
  listWafPresets,
  updateWafPreset,
} from '../../../src/lib/models/waf-presets';

const RULE = 'SecRule ARGS "@rx x" "id:9700,phase:1,pass,nolog,ctl:ruleRemoveById=942100"';

let userId: number;

beforeEach(async () => {
  db = await createTestDb();
  vi.clearAllMocks();
  globalWaf = null;
  dashboardMeta = null;
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
});

async function seedHost(name: string, presetIds: number[]) {
  const now = new Date().toISOString();
  await db.insert(proxyHosts).values({
    name,
    domains: JSON.stringify([`${name}.test`]),
    upstreams: JSON.stringify(['app:80']),
    meta: JSON.stringify({ waf: { enabled: true, preset_ids: presetIds } }),
    createdAt: now,
    updatedAt: now,
  });
}

describe('createWafPreset', () => {
  it('stores a trimmed preset and lists it by name', async () => {
    await createWafPreset({ name: ' Nextcloud ', directives: `\n${RULE}\n` }, userId);
    await createWafPreset({ name: 'Immich', description: 'uploads', directives: RULE }, userId);
    const presets = await listWafPresets();
    expect(presets.map((p) => p.name)).toEqual(['Immich', 'Nextcloud']);
    expect(presets[1].directives).toBe(RULE);
    expect(presets[0].description).toBe('uploads');
  });

  it('stores the CRLF a browser form submits as LF', async () => {
    const multiLine = 'SecRule ARGS "@rx x" \\\r\n    "id:9701,phase:1,pass,nolog"';
    const preset = await createWafPreset({ name: 'Form', directives: multiLine }, userId);
    expect(preset.directives).toBe(multiLine.replace('\r\n', '\n'));
  });

  it('refuses a name another preset has, ignoring case', async () => {
    await createWafPreset({ name: 'Nextcloud', directives: RULE }, userId);
    await expect(createWafPreset({ name: 'nextcloud', directives: RULE }, userId)).rejects.toThrow(
      'already exists',
    );
  });

  it('refuses directives the allowlist would drop, naming them', async () => {
    // Only the strict global setting refuses them; a preset follows it wherever it is selected.
    globalWaf = { strict_directives: true };
    await expect(
      createWafPreset({ name: 'Bad', directives: `${RULE}\nSecRuleEngine Off` }, userId),
    ).rejects.toThrow('SecRuleEngine Off');
    globalWaf = null;
    await expect(
      createWafPreset({ name: 'Risky', directives: `${RULE}\nSecRuleEngine Off` }, userId),
    ).resolves.toMatchObject({ name: 'Risky' });
  });

  it('refuses an empty preset', async () => {
    await expect(createWafPreset({ name: 'Empty', directives: '  ' }, userId)).rejects.toThrow(
      'at least one directive',
    );
  });
});

describe('updateWafPreset', () => {
  it('re-applies Caddy only when a selected preset changes its directives', async () => {
    const preset = await createWafPreset({ name: 'A', directives: RULE }, userId);
    await updateWafPreset(preset.id, { directives: RULE.replace('9700', '9701') }, userId);
    expect(applyCaddyConfig).not.toHaveBeenCalled();

    await seedHost('app', [preset.id]);
    await updateWafPreset(preset.id, { description: 'renamed nothing' }, userId);
    expect(applyCaddyConfig).not.toHaveBeenCalled();
    await updateWafPreset(preset.id, { directives: RULE }, userId);
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);
  });

  it('allows keeping its own name', async () => {
    const preset = await createWafPreset({ name: 'A', directives: RULE }, userId);
    const updated = await updateWafPreset(preset.id, { name: 'a' }, userId);
    expect(updated.name).toBe('a');
  });
});

describe('deleteWafPreset', () => {
  it('refuses while a host selects it, naming the host', async () => {
    const preset = await createWafPreset({ name: 'A', directives: RULE }, userId);
    await seedHost('files', [preset.id]);
    await expect(deleteWafPreset(preset.id, userId)).rejects.toThrow('files');
  });

  it('refuses while the global settings select it', async () => {
    const preset = await createWafPreset({ name: 'A', directives: RULE }, userId);
    globalWaf = { preset_ids: [preset.id] };
    await expect(deleteWafPreset(preset.id, userId)).rejects.toThrow('global WAF settings');
  });

  it('refuses while the dashboard host selects it', async () => {
    const preset = await createWafPreset({ name: 'A', directives: RULE }, userId);
    dashboardMeta = JSON.stringify({ waf: { enabled: true, preset_ids: [preset.id] } });
    expect((await getWafPresetUsage()).get(preset.id)).toEqual({
      global: false,
      dashboard: true,
      hosts: [],
    });
    await expect(deleteWafPreset(preset.id, userId)).rejects.toThrow('dashboard host');
  });

  it('deletes an unused preset', async () => {
    const preset = await createWafPreset({ name: 'A', directives: RULE }, userId);
    await deleteWafPreset(preset.id, userId);
    expect(await listWafPresets()).toEqual([]);
  });
});

describe('getWafPresetUsage / assertWafPresetIdsExist', () => {
  it('reports global and per-host selections', async () => {
    const a = await createWafPreset({ name: 'A', directives: RULE }, userId);
    const b = await createWafPreset({ name: 'B', directives: RULE }, userId);
    globalWaf = { preset_ids: [a.id] };
    await seedHost('one', [a.id, b.id]);
    const usage = await getWafPresetUsage();
    expect(usage.get(a.id)).toEqual({
      global: true,
      dashboard: false,
      hosts: [expect.objectContaining({ name: 'one' })],
    });
    expect(usage.get(b.id)?.global).toBe(false);
  });

  it('names ids that match no preset', async () => {
    const a = await createWafPreset({ name: 'A', directives: RULE }, userId);
    await assertWafPresetIdsExist([a.id]);
    await expect(assertWafPresetIdsExist([a.id, 4242])).rejects.toThrow('4242');
  });
});

describe('Coraza checks', () => {
  const refusal = (candidate: number) =>
    `Error: loading http app module: provision http: server candidate_${candidate}: setting up route handlers: route 0: loading handler modules: position 0: loading module 'waf': provision http.handlers.waf: invalid WAF config from string: failed to compile the directive "secrule": duplicated rule id 9700`;

  let restore: CaddyValidator | null = null;
  afterEach(() => {
    if (restore) setCaddyValidator(restore);
    restore = null;
  });

  it('refuses what the linter knows Coraza will not load, before asking Caddy', async () => {
    const seen: string[] = [];
    restore = setCaddyValidator(async (config) => {
      seen.push(config);
      return { status: 200, text: '' };
    });
    const error = await createWafPreset(
      { name: 'Typo', directives: 'SecRule ARGS "@rxx a" "id:1,deny"' },
      userId,
    ).catch((e: unknown) => e);
    expect((error as DomainError).code).toBe('wafPresetDirectivesInvalid');
    expect((error as DomainError).message).toContain('line 1:');
    expect(seen).toEqual([]);
    expect(await listWafPresets()).toEqual([]);
  });

  it('refuses a preset Caddy will not load, and stores nothing', async () => {
    const seen: string[] = [];
    restore = setCaddyValidator(async (config) => {
      seen.push(config);
      return { status: 422, text: refusal(0) };
    });
    const error = await createWafPreset({ name: 'Bad', directives: RULE }, userId).catch(
      (e: unknown) => e,
    );
    expect((error as DomainError).code).toBe('wafDryRunRejectedPreset');
    expect(seen[0]).toContain('id:9700');
    expect(await listWafPresets()).toEqual([]);
  });

  it('names the host an edit would break, and skips the dry run when the rules did not change', async () => {
    const preset = await createWafPreset({ name: 'Shared', directives: RULE }, userId);
    // With the CRS, so its WAF is not the preset-alone one the dry run already compiles.
    const now = new Date().toISOString();
    await db.insert(proxyHosts).values({
      name: 'shop',
      domains: JSON.stringify(['shop.test']),
      upstreams: JSON.stringify(['app:80']),
      meta: JSON.stringify({
        waf: { enabled: true, load_owasp_crs: true, preset_ids: [preset.id] },
      }),
      createdAt: now,
      updatedAt: now,
    });
    const seen: string[] = [];
    restore = setCaddyValidator(async (config) => {
      seen.push(config);
      return { status: 422, text: refusal(1) };
    });

    const edited = RULE.replace('@rx x', '@rx y');
    const error = await updateWafPreset(preset.id, { directives: edited }, userId).catch(
      (e: unknown) => e,
    );
    expect((error as DomainError).code).toBe('wafDryRunRejectedHost');
    expect((error as DomainError).params.name).toBe('shop');
    // The preset alone, then the host selecting it - each with the edit, not the stored text.
    const servers = JSON.parse(seen[0]).apps.http.servers;
    expect(Object.keys(servers)).toEqual(['candidate_0', 'candidate_1']);
    expect(seen[0]).toContain('@rx y');
    expect((await listWafPresets())[0].directives).toBe(RULE);

    await updateWafPreset(preset.id, { name: 'Renamed' }, userId);
    expect(seen).toHaveLength(1);
  });
});
