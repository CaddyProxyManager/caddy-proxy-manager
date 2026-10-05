/**
 * Integration: src/lib/models/crs-plugins.ts against a real database and a fake GitHub - install,
 * update, the config edit, the in-use guard on uninstall, and what the Caddy builder is handed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { createTestDb, type TestDb } from '../../helpers/db';
import { crsPlugins, proxyHosts, users } from '../../../src/lib/db/schema';
import { DomainError } from '../../../src/lib/errors/domain-error';
import { FAKE_BOT, WORDPRESS, fakeGithub } from '../../helpers/fake-github';
import { type CaddyValidator, setCaddyValidator } from '../../../src/lib/waf/dry-run';

let db: TestDb;
let globalWaf: { plugin_ids?: number[] } | null = null;
// The registry settings and the sync state are settings rows; a map stands in for the table.
const settingsStore = new Map<string, unknown>();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => db));
vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));
const applyCaddyConfig = vi.fn(async () => {});
vi.mock('../../../src/lib/caddy', () => ({ applyCaddyConfig }));
vi.mock('../../../src/lib/settings', () => ({
  getWafSettings: async () => globalWaf,
  getDashboardSettings: async () => ({ options: { meta: null } }),
  getSetting: async (key: string) => structuredClone(settingsStore.get(key) ?? null),
  setSetting: async (key: string, value: unknown) => {
    settingsStore.set(key, structuredClone(value));
  },
}));

import {
  assertCrsPluginIdsExist,
  checkCrsPluginUpdates,
  getCrsPluginRules,
  installCrsPlugin,
  listCrsPlugins,
  listCrsRegistry,
  setCrsPluginConfig,
  uninstallCrsPlugin,
  updateCrsPlugin,
} from '../../../src/lib/models/crs-plugins';

const WORDPRESS_REPO = 'coreruleset/wordpress-rule-exclusions-plugin';
const CONFIG =
  'SecAction "id:9507010,phase:1,pass,nolog,setvar:tx.wordpress-rule-exclusions-plugin_enabled=0"';

let userId: number;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error);
  }
  return undefined;
}

beforeEach(async () => {
  db = await createTestDb();
  vi.clearAllMocks();
  settingsStore.clear();
  globalWaf = null;
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

describe('installCrsPlugin', () => {
  it('stores the release it fetched and marks it installed in the registry', async () => {
    const github = fakeGithub({ [WORDPRESS_REPO]: WORDPRESS });
    const plugin = await installCrsPlugin(
      'official',
      'wordpress-rule-exclusions',
      userId,
      github.fetcher,
    );
    expect(plugin).toMatchObject({
      name: 'wordpress-rule-exclusions',
      version: 'v1.2.0',
      ruleIdStart: 9507000,
      ruleIdEnd: 9507999,
      configOverride: null,
      description: 'CRS rule exclusions for WordPress',
    });
    // CRLF from the repository is stored as LF, the way Coraza's parser reads it either way.
    expect(plugin.configRules).toBe('# enabled by default');
    expect(plugin.fileNames).toEqual([
      'wordpress-rule-exclusions-before.conf',
      'wordpress-rule-exclusions-config.conf',
    ]);
    const registry = await listCrsRegistry(github.fetcher);
    expect(registry.find((entry) => entry.name === plugin.name)?.installedId).toBe(plugin.id);
    // Nothing selects it yet.
    expect(applyCaddyConfig).not.toHaveBeenCalled();
  });

  it('refuses a second install, a name the registry lacks, and a plugin Caddy cannot load', async () => {
    const github = fakeGithub({
      [WORDPRESS_REPO]: WORDPRESS,
      'coreruleset/fake-bot-plugin': FAKE_BOT,
    });
    await installCrsPlugin('official', 'wordpress-rule-exclusions', userId, github.fetcher);
    expect(
      await codeOf(
        installCrsPlugin('official', 'wordpress-rule-exclusions', userId, github.fetcher),
      ),
    ).toBe('crsPluginAlreadyInstalled');
    expect(await codeOf(installCrsPlugin('official', 'nope', userId, github.fetcher))).toBe(
      'crsPluginNotInRegistry',
    );
    expect(await codeOf(installCrsPlugin('official', 'fake-bot', userId, github.fetcher))).toBe(
      'crsPluginRejected',
    );
    expect(await listCrsPlugins()).toHaveLength(1);
  });
});

describe('setCrsPluginConfig', () => {
  it('stores an edit, checks its rule ids, and goes back to upstream on blank', async () => {
    const github = fakeGithub({ [WORDPRESS_REPO]: WORDPRESS });
    const { id } = await installCrsPlugin(
      'official',
      'wordpress-rule-exclusions',
      userId,
      github.fetcher,
    );

    expect((await setCrsPluginConfig(id, `${CONFIG}\r\n`, userId)).configOverride).toBe(CONFIG);
    expect((await getCrsPluginRules()).get(id)?.config).toBe(CONFIG);

    expect(await codeOf(setCrsPluginConfig(id, 'SecAction "id:942100,phase:1,pass"', userId))).toBe(
      'crsPluginRejected',
    );

    expect((await setCrsPluginConfig(id, '  ', userId)).configOverride).toBeNull();
    expect((await getCrsPluginRules()).get(id)?.config).toBe('# enabled by default');
  });

  it('applies the config when something selects the plugin', async () => {
    const github = fakeGithub({ [WORDPRESS_REPO]: WORDPRESS });
    const { id } = await installCrsPlugin(
      'official',
      'wordpress-rule-exclusions',
      userId,
      github.fetcher,
    );
    globalWaf = { plugin_ids: [id] };
    await setCrsPluginConfig(id, CONFIG, userId);
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);
  });
});

describe('updateCrsPlugin', () => {
  it('moves to the latest release and keeps the edited config', async () => {
    const repo = { ...WORDPRESS };
    const github = fakeGithub({ [WORDPRESS_REPO]: repo });
    const { id } = await installCrsPlugin(
      'official',
      'wordpress-rule-exclusions',
      userId,
      github.fetcher,
    );
    await setCrsPluginConfig(id, CONFIG, userId);

    expect(await checkCrsPluginUpdates(github.fetcher)).toEqual(new Map());
    repo.release = 'v1.3.0';
    expect(await checkCrsPluginUpdates(github.fetcher)).toEqual(new Map([[id, 'v1.3.0']]));

    const updated = await updateCrsPlugin(id, userId, github.fetcher);
    expect(updated.version).toBe('v1.3.0');
    expect(updated.afterRules).toContain('SecRuleUpdateTargetById 942100');
    expect(updated.configOverride).toBe(CONFIG);
  });
});

describe('uninstallCrsPlugin', () => {
  it('refuses while the global settings or a host select it', async () => {
    const github = fakeGithub({ [WORDPRESS_REPO]: WORDPRESS });
    const { id } = await installCrsPlugin(
      'official',
      'wordpress-rule-exclusions',
      userId,
      github.fetcher,
    );

    globalWaf = { plugin_ids: [id] };
    expect(await codeOf(uninstallCrsPlugin(id, userId))).toBe('crsPluginInUseGlobally');

    globalWaf = null;
    const now = new Date().toISOString();
    await db.insert(proxyHosts).values({
      name: 'blog',
      domains: JSON.stringify(['blog.test']),
      upstreams: JSON.stringify(['wp:80']),
      meta: JSON.stringify({ waf: { enabled: true, plugin_ids: [id] } }),
      createdAt: now,
      updatedAt: now,
    });
    expect(await codeOf(uninstallCrsPlugin(id, userId))).toBe('crsPluginInUseByHosts');

    await db.delete(proxyHosts);
    await uninstallCrsPlugin(id, userId);
    expect(await listCrsPlugins()).toEqual([]);
    expect(await codeOf(assertCrsPluginIdsExist([id]))).toBe('crsPluginUnknownIds');
  });
});

describe('getCrsPluginRules', () => {
  it('leaves out a stored plugin that no longer passes the check, rather than half of it', async () => {
    const now = new Date().toISOString();
    const [row] = await db
      .insert(crsPlugins)
      .values({
        name: 'tampered',
        repository: 'https://github.com/x/tampered-plugin',
        version: 'v1',
        ruleIdStart: 9530000,
        ruleIdEnd: 9530999,
        configRules: '',
        beforeRules: 'SecRuleEngine Off',
        afterRules: '',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    expect((await getCrsPluginRules()).has(row.id)).toBe(false);
  });
});

describe('Coraza checks', () => {
  let restore: CaddyValidator | null = null;
  afterEach(() => {
    if (restore) setCaddyValidator(restore);
    restore = null;
  });

  it('refuses a config edit the linter knows Coraza will not load', async () => {
    const github = fakeGithub({ [WORDPRESS_REPO]: WORDPRESS });
    const { id } = await installCrsPlugin(
      'official',
      'wordpress-rule-exclusions',
      userId,
      github.fetcher,
    );
    const error = await setCrsPluginConfig(id, 'SecAction "id:9507010,phase:9,pass"', userId).catch(
      (e: unknown) => e,
    );
    expect((error as DomainError).code).toBe('crsPluginRejected');
    expect((error as DomainError).message).toContain('Coraza would refuse it');
  });

  it('refuses a config edit Caddy will not load, with the edit in place of the stored file', async () => {
    const github = fakeGithub({ [WORDPRESS_REPO]: WORDPRESS });
    const { id } = await installCrsPlugin(
      'official',
      'wordpress-rule-exclusions',
      userId,
      github.fetcher,
    );
    const seen: string[] = [];
    restore = setCaddyValidator(async (config) => {
      seen.push(config);
      return {
        status: 422,
        text: 'Error: provision http.handlers.waf: invalid WAF config from string: failed to compile the directive "secaction": duplicated rule id 9507010',
      };
    });
    expect(await codeOf(setCrsPluginConfig(id, CONFIG, userId))).toBe('wafDryRunRejectedPlugin');
    expect(seen[0]).toContain('tx.wordpress-rule-exclusions-plugin_enabled=0');
    expect(seen[0]).toContain('"load_owasp_crs":true');
    expect((await listCrsPlugins())[0].configOverride).toBeNull();
  });
});
